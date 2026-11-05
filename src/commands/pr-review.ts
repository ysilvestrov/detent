// `detent pr-review` (spec 2026-11-02-pr-review-design.md, «Команда»). The checks run in the order of the
// plan: arguments, the event and the token, the settings of the base branch, the provider, the models.
// Only after all of them does the review run. Exit 5 comes from a failed review, or from a missing key outside a fork.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveReplayArgs, runReplay, EXIT, type ReplayIo } from '../pr-review/replay.js';
import { resolveModels, selectProvider } from '../pr-review/providers.js';
import { postFailureComment, readReviewableFile, runReview, type PrContext, type ReviewDeps } from '../pr-review/review.js';
import { ConfigError, baseReader, loadSettings } from '../pr-review/settings.js';

export { EXIT };

export const USAGE = 'Usage: npx -y @ysilvestrov/detent pr-review [--replay <pr> [--head <sha>] [--base <sha>] [--provider <id>] [--record <file>] [--context-only | --find-only --save-findings <file> | --verify-from <file>]]';

export type PrReviewIo = ReplayIo;

interface PullRequestEvent {
  number: number;
  title: string;
  body: string | null;
  base: { ref: string; repo: { full_name: string } | null };
  head: { sha: string; repo: { full_name: string } | null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, windowsHide: true }).status === 0;
}

function gitText(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// `head.repo` is null when the fork was deleted; that is still a fork.
function repoOf(v: unknown): { full_name: string } | null {
  return isRecord(v) && typeof v.full_name === 'string' ? { full_name: v.full_name } : null;
}

function readEvent(path: string): PullRequestEvent {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const pr = isRecord(raw) ? raw.pull_request : undefined;
  if (!isRecord(pr) || !Number.isInteger(pr.number) || !isRecord(pr.base) || typeof pr.base.ref !== 'string' || !isRecord(pr.head)) {
    throw new Error('the event has no pull_request with a number, a base and a head');
  }
  return {
    number: pr.number as number,
    title: typeof pr.title === 'string' ? pr.title : '',
    // GitHub sends null for an empty description.
    body: typeof pr.body === 'string' ? pr.body : null,
    base: { ref: pr.base.ref, repo: repoOf(pr.base.repo) },
    head: { sha: typeof pr.head.sha === 'string' ? pr.head.sha : '', repo: repoOf(pr.head.repo) },
  };
}

export async function prReview(argv: readonly string[], io: PrReviewIo): Promise<number> {
  const fail = (code: number, message: string): number => {
    io.err(`pr-review: ${message}`);
    return code;
  };
  const usageError = (message: string): number => fail(EXIT.usage, `${message}\n${USAGE}`);

  if (argv[0] === '--replay') {
    let args;
    try {
      args = resolveReplayArgs(argv.slice(1));
    } catch (error) {
      return usageError(messageOf(error));
    }
    try {
      return await runReplay(args, io);
    } catch (error) {
      return fail(EXIT.failed, `replay failed: ${messageOf(error)}`);
    }
  }
  if (argv.length > 0) return usageError(`unknown argument "${argv[0]}"`);

  const { env } = io;
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    return usageError(`this command runs on a pull_request event (GITHUB_EVENT_NAME is "${env.GITHUB_EVENT_NAME ?? ''}"); locally use --replay`);
  }
  for (const name of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN']) {
    if (!env[name]) return usageError(`${name} is not set`);
  }
  const githubToken = env.GITHUB_TOKEN!;
  const repo = env.GITHUB_REPOSITORY!;

  let event: PullRequestEvent;
  try {
    event = readEvent(env.GITHUB_EVENT_PATH!);
  } catch (error) {
    return usageError(`cannot read the event: ${messageOf(error)}`);
  }
  const baseRef = event.base.ref;

  // The settings are those of the base branch: a PR cannot switch its own review off or steer it.
  let settings;
  try {
    settings = loadSettings(baseReader(io.cwd, baseRef));
  } catch (error) {
    if (error instanceof ConfigError) return fail(EXIT.usage, error.message);
    return fail(EXIT.failed, messageOf(error));
  }

  const headSha = (): string => {
    try {
      return gitText(io.cwd, ['rev-parse', 'HEAD']).trim();
    } catch {
      return event.head.sha;
    }
  };
  const pr: PrContext = {
    repo,
    prNumber: event.number,
    baseRef,
    prTitle: event.title,
    prBody: event.body ?? '',
    githubToken,
  };

  const selection = selectProvider(settings.configured.provider, env);
  if (selection.kind === 'ambiguous') {
    return fail(EXIT.usage, `more than one provider key is set (${selection.keys.join(', ')}): set "prReview.provider" in detent.json`);
  }
  if (selection.kind === 'no-key') {
    // A fork's PR gets no secrets, so a missing key there is expected and not a failure.
    const isFork = event.head.repo === null || event.head.repo.full_name !== (event.base.repo?.full_name ?? repo);
    if (isFork) {
      io.err(`pr-review: ${selection.wanted} is not set; skipping the review of a PR from a fork (it has no access to secrets)`);
      return EXIT.ok;
    }
    const message = `${selection.wanted} is not set`;
    try {
      await postFailureComment({ repo, prNumber: pr.prNumber, token: githubToken, fetchFn: io.fetchFn }, message, headSha());
    } catch (error) {
      io.err(`pr-review: the failure comment could not be posted: ${messageOf(error)}`);
    }
    return fail(EXIT.failed, message);
  }
  const { provider, apiKey } = selection;
  // A pin is an OpenRouter request field; anywhere else it would be silently ignored, and the review would not be the one configured.
  if (settings.configured.openrouterOnly !== undefined && provider.id !== 'openrouter') {
    return fail(EXIT.usage, `"prReview.openrouterOnly" works only with the openrouter provider, not ${provider.id}`);
  }

  const models = resolveModels(provider, settings.configured);
  if (!models.ok) return fail(EXIT.usage, models.error);

  const cwd = io.cwd;
  const deps: ReviewDeps = {
    headSha: headSha(),
    hasCommit: (sha) => gitOk(cwd, ['cat-file', '-e', `${sha}^{commit}`]),
    isAncestor: (a, b) => gitOk(cwd, ['merge-base', '--is-ancestor', a, b]),
    listChangedFiles: (diffSpec) =>
      gitText(cwd, ['-c', 'core.quotePath=off', 'diff', '--name-only', diffSpec])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    getDiff: (diffSpec, files) => gitText(cwd, ['-c', 'core.quotePath=off', 'diff', diffSpec, '--', ...files]),
    readFile: (path) => readReviewableFile(path, cwd),
    log: (message) => io.out(message),
    openaiFetch: io.fetchFn,
    githubFetch: io.fetchFn,
  };

  try {
    await runReview(pr, { settings, provider, apiKey, findModel: models.find, verifyModel: models.verify }, deps);
    return EXIT.ok;
  } catch (error) {
    // The comment about the failure has been posted by runReview; here only the log and the code.
    const message = messageOf(error).replaceAll(apiKey, '***').replaceAll(githubToken, '***');
    io.err(`::error::AI review failed: ${message}`);
    return EXIT.failed;
  }
}
