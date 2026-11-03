// `detent pr-review --replay <pr>`: the review pipeline against a merged or open PR, without posting anything.
//
// Reads file bodies from the PR's head commit via `git show`, so it never touches the working tree.
// It differs from the run in CI in two places, because the person running it owns the key and
// the machine (spec 2026-11-02-pr-review-design.md, «Команда»): the settings come from the working tree,
// not from the base branch, and AI_REVIEW_MODEL, AI_REVIEW_VERIFY_MODEL and --provider pick the candidates.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewContext } from './context.js';
import { runFind } from './find.js';
import { applyGate, changedLineRanges } from './gate.js';
import type { OpenAiDeps } from './openai.js';
import { PROVIDER_IDS, isProviderId, resolveModels, selectProvider, type Provider, type ProviderId } from './providers.js';
import { openRecord, type RecordWriter, type RunLine } from './record.js';
import { contextReader, filterReviewableFiles } from './review.js';
import { ConfigError, loadSettings } from './settings.js';
import { costUsd, formatCostLine } from './usage.js';
import { verifyAll } from './verify.js';

type Env = Readonly<Record<string, string | undefined>>;

/** What a command needs from its surroundings. `gh` is replaceable so the replay can be tested without GitHub. */
export interface ReplayIo {
  cwd: string;
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  fetchFn?: typeof fetch;
  gh?: (args: string[]) => string;
}

export const EXIT = { ok: 0, usage: 2, failed: 5 } as const;

function sh(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Make sure the PR's head commit is in this clone before anything reads it.
 *
 * A fresh checkout has never fetched `refs/pull/<n>/head`, so `git show
 * <head>:<path>` and `git merge-base` fail on an object that was simply never
 * downloaded — which reads like a broken replay rather than a missing fetch.
 */
export function ensureHeadCommit(params: {
  pr: string;
  head: string;
  hasCommit: (sha: string) => boolean;
  fetchHead: () => void;
  log: (message: string) => void;
}): void {
  const { pr, head, hasCommit, fetchHead, log } = params;
  const ref = `pull/${pr}/head`;
  if (hasCommit(head)) return;

  log(`head ${head} is not in this clone; fetching origin ${ref} (may take a moment)…`);
  try {
    fetchHead();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`git fetch origin ${ref} failed: ${detail}`);
  }

  if (!hasCommit(head)) {
    throw new Error(`git fetch origin ${ref} did not produce commit ${head}; fetch it manually and retry`);
  }
}

/**
 * Which commit the replay diffs against.
 *
 * Without an explicit base a replay always measures a *first* review, which is
 * no longer what CI usually runs. Passing the previously reviewed head lets a
 * real incremental run be measured offline — including its much smaller find
 * prompt — before betting money on a config change.
 */
export function resolveReplayBase(p: {
  explicit: string | undefined;
  baseRefName: string;
  head: string;
  mergeBase: (a: string, b: string) => string;
}): string {
  return p.explicit ?? p.mergeBase(`refs/remotes/origin/${p.baseRefName}`, p.head);
}

export interface ReplayArgs {
  pr: string;
  explicitBase?: string;
  headOverride?: string;
  provider?: ProviderId;
  /** File the run appends its `call` and `run` lines to. */
  record?: string;
  /** Print the context budget and stop: no key, no model call. */
  contextOnly?: boolean;
}

/** The files that went to the model as a diff only, because their bodies did not fit. */
export function formatContextBudget(diffOnly: string[]): string {
  return diffOnly.length === 0
    ? 'Context budget: 0 file(s) sent as diff only.'
    : `Context budget: ${diffOnly.length} file(s) sent as diff only: ${diffOnly.join(', ')}`;
}

/**
 * Replay arguments: `<pr> [--head <sha>] [--base <sha>] [--provider <id>]`.
 *
 * `--head` exists for the recall probe. Replaying a PR at its MERGED head
 * measures nothing about what a config would have FOUND: the findings the live
 * review produced have been fixed by then, which is precisely why they are known
 * to be real. The head the live review saw is in its own state block
 * (`<!-- ai-pr-review-state {"head":…} -->`), or is the commit before the fix.
 * This trap has cost two investigations — warsaw-beer-bot#344 in 2026-07, warsaw-beer-bot#418 in 2026-09 —
 * which is why it is a flag now rather than a thing to remember.
 */
export function resolveReplayArgs(argv: readonly string[]): ReplayArgs {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flagsWithValue = ['--head', '--base', '--provider', '--record'];
  const needs: Record<string, string> = {
    '--provider': `one of ${PROVIDER_IDS.join('|')}`,
    '--record': 'a file path',
  };
  let contextOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (flagsWithValue.includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs ${needs[arg] ?? 'a commit sha'}`);
      values[arg] = value;
      i++;
      continue;
    }
    if (arg === '--context-only') {
      contextOnly = true;
      continue;
    }
    // A mistyped `--head=abc` must not fall through and be taken for a positional argument.
    if (arg.startsWith('--')) throw new Error(`unrecognised option: ${arg}`);
    positional.push(arg);
  }

  const [pr, extra] = positional;
  if (pr === undefined) throw new Error('--replay needs a PR number');
  if (!/^\d+$/.test(pr)) throw new Error(`the PR number must be digits, got "${pr}"`);
  if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
  const provider = values['--provider'];
  if (provider !== undefined && !isProviderId(provider)) {
    throw new Error(`unknown provider "${provider}": one of ${PROVIDER_IDS.join('|')}`);
  }
  if (contextOnly && values['--record'] !== undefined) throw new Error('--context-only cannot be combined with --record');
  return {
    pr,
    ...(values['--base'] ? { explicitBase: values['--base'] } : {}),
    ...(values['--head'] ? { headOverride: values['--head'] } : {}),
    ...(provider !== undefined ? { provider: provider as ProviderId } : {}),
    ...(values['--record'] !== undefined ? { record: values['--record'] } : {}),
    ...(contextOnly ? { contextOnly } : {}),
  };
}

// The project's files as they are in the working tree: a replay measures settings before they are merged.
function worktreeReader(cwd: string): (path: string) => string | null {
  return (path) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
}

const modelFromEnv = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

type RecordMeta = Pick<RunLine, 'batch' | 'label' | 'draw'>;

/** `AI_REVIEW_RECORD_META` is a JSON object; a field it leaves out is null. Null when it is anything else. */
function parseRecordMeta(raw: string | undefined): RecordMeta | null {
  if (raw === undefined) return { batch: null, label: null, draw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { batch = null, label = null, draw = null } = parsed as Record<string, unknown>;
  const numberOrNull = (v: unknown): number | null | undefined => (v === null || typeof v === 'number' ? v : undefined);
  const labelOrNull = typeof label === 'string' || label === null ? label : undefined;
  const [b, d] = [numberOrNull(batch), numberOrNull(draw)];
  return b === undefined || d === undefined || labelOrNull === undefined ? null : { batch: b, label: labelOrNull, draw: d };
}

/** Runs the replay and returns the exit code. Throws only on a failed run (the caller maps that to 5). */
export async function runReplay(args: ReplayArgs, io: ReplayIo): Promise<number> {
  const usage = (message: string): number => {
    io.err(`pr-review: ${message}`);
    return EXIT.usage;
  };

  let settings;
  try {
    settings = loadSettings(worktreeReader(io.cwd));
  } catch (error) {
    if (error instanceof ConfigError) return usage(error.message);
    throw error;
  }

  // `--context-only` never calls a model, so it needs neither a provider nor a key.
  let chosen: { provider: Provider; apiKey: string; findModel: string; verifyModel: string } | null = null;
  if (!args.contextOnly) {
    const selection = selectProvider(args.provider ?? settings.configured.provider, io.env);
    if (selection.kind === 'ambiguous') {
      return usage(`more than one provider key is set (${selection.keys.join(', ')}): pass --provider`);
    }
    if (selection.kind === 'no-key') return usage(`${selection.wanted} is not set`);
    const models = resolveModels(selection.provider, {
      findModel: modelFromEnv(io.env, 'AI_REVIEW_MODEL') ?? settings.configured.findModel,
      verifyModel: modelFromEnv(io.env, 'AI_REVIEW_VERIFY_MODEL') ?? settings.configured.verifyModel,
    });
    if (!models.ok) return usage(models.error);
    chosen = { provider: selection.provider, apiKey: selection.apiKey, findModel: models.find, verifyModel: models.verify };
  }

  // Both checks come before the first call: a record that cannot be written must not be found out after the money is spent.
  const runId = randomUUID();
  let rec: RecordWriter | null = null;
  let recordMeta: RecordMeta = { batch: null, label: null, draw: null };
  if (args.record !== undefined) {
    const parsed = parseRecordMeta(io.env.AI_REVIEW_RECORD_META);
    if (parsed === null) return usage('AI_REVIEW_RECORD_META must be a JSON object {batch, label, draw}');
    recordMeta = parsed;
    try {
      rec = openRecord(args.record, runId);
    } catch (error) {
      return usage(`cannot open the record file ${args.record}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const startedAt = new Date().toISOString();
  // What the `run` line reports. Filled in as the run learns it, so a failure still leaves what was known.
  const state: Pick<RunLine, 'head' | 'base' | 'diffOnly' | 'raised' | 'gated' | 'dropped' | 'results'> = {
    head: null,
    base: null,
    diffOnly: [],
    raised: 0,
    gated: 0,
    dropped: [],
    results: [],
  };
  const runLine = (exit: number, error: string | null): Omit<RunLine, 'type' | 'runId'> => ({
    ...recordMeta,
    provider: chosen?.provider.id ?? null,
    findModel: chosen?.findModel ?? null,
    verifyModel: chosen?.verifyModel ?? null,
    only: { find: null, verify: null },
    cacheMode: 'default',
    pr: args.pr,
    startedAt,
    ...state,
    exit,
    error,
  });

  const { pr, explicitBase, headOverride } = args;
  const git = (a: string[]): string => sh(io.cwd, 'git', a);
  const gh = io.gh ?? ((a: string[]): string => sh(io.cwd, 'gh', a));

  const execute = async (): Promise<number> => {
    // `baseRefOid` is not exposed by every gh version, so the base is resolved from its branch name:
    // for a squash-merged PR the head commit is not an ancestor of the base branch, so the merge-base is still the fork point.
    const meta = JSON.parse(gh(['pr', 'view', pr, '--json', 'title,body,headRefOid,baseRefName'])) as {
      title: string;
      body: string | null;
      headRefOid: string;
      baseRefName: string;
    };

    const head = headOverride ?? meta.headRefOid;
    state.head = head;
    const hasCommit = (sha: string): boolean => {
      try {
        git(['cat-file', '-e', `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    ensureHeadCommit({
      pr,
      head,
      hasCommit,
      fetchHead: () => {
        // `refs/pull/<n>/head` tracks the PR's CURRENT head, so it cannot deliver a commit a later
        // force-push made unreachable — and that is exactly the commit a recall probe asks for. GitHub
        // still serves such a commit by sha, so ask for it by name. Only for an explicit `--head`.
        try {
          git(['fetch', 'origin', `pull/${pr}/head`]);
        } catch (err) {
          // With `--head` the pull ref is a best-effort first try; throwing here would bury the by-sha attempt.
          if (!headOverride) throw err;
        }
        if (headOverride && !hasCommit(head)) git(['fetch', 'origin', head]);
      },
      log: (message) => io.err(message),
    });

    const mergeBase = resolveReplayBase({
      explicit: explicitBase,
      baseRefName: meta.baseRefName,
      head,
      mergeBase: (a, b) => git(['merge-base', a, b]).trim(),
    });
    state.base = mergeBase;
    io.err(`replaying ${mergeBase}..${head}`);

    const changed = git(['-c', 'core.quotePath=off', 'diff', '--name-only', `${mergeBase}..${head}`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const reviewable = filterReviewableFiles(changed, settings.patterns);
    if (reviewable.length === 0) {
      io.out('no reviewable files');
      return EXIT.ok;
    }

    const diff = git(['-c', 'core.quotePath=off', 'diff', `${mergeBase}..${head}`, '--', ...reviewable]);
    const readFile = (path: string): string | null => {
      try {
        return git(['show', `${head}:${path}`]);
      } catch {
        return null;
      }
    };

    const { text: context, diffOnly } = buildReviewContext({
      diff,
      reviewable,
      readFile: contextReader(readFile, settings.patterns),
    });
    state.diffOnly = diffOnly;
    io.out(formatContextBudget(diffOnly));
    if (args.contextOnly) return EXIT.ok;

    // Present whenever a model is called: `--context-only` returned above.
    const { provider, apiKey, findModel, verifyModel } = chosen!;
    const transport = { endpoint: provider.endpoint, apiKey, providerName: provider.name, extraBody: provider.extraBody, fetchFn: io.fetchFn };
    // One hook per stage, so a call line says which stage paid for it.
    const writer = rec;
    const recording = (stage: 'find' | 'verify'): Pick<OpenAiDeps, 'onResponse'> =>
      writer ? { onResponse: (info) => writer.call(stage, info) } : {};
    const found = await runFind(
      { ...transport, ...recording('find'), model: findModel },
      { instructions: settings.findPrompt, context, prTitle: meta.title, prBody: meta.body ?? '' },
    );
    const raised = found.findings;
    state.raised = raised.length;

    const { kept, dropped } = applyGate({
      findings: raised,
      reviewable,
      changed: changedLineRanges(diff),
      fileContent: readFile,
    });
    state.gated = kept.length;
    state.dropped = dropped.map((d) => ({ file: d.finding.file, reason: d.reason, claim: d.finding.claim }));

    const verified = await verifyAll(
      { ...transport, ...recording('verify'), model: verifyModel },
      {
        instructions: settings.verifyPrompt,
        requests: kept.map((f, i) => ({
          id: `f${i}`,
          file: f.file,
          matchedLine: f.matchedLine,
          matchedEndLine: f.matchedEndLine,
          quote: f.quote,
          claim: f.claim,
          why_it_breaks: f.why_it_breaks,
        })),
        fileContent: readFile,
      },
    );
    const byId = new Map(kept.map((f, i) => [`f${i}`, f]));
    state.results = verified.results.map((r) => {
      const f = byId.get(r.id)!;
      return {
        file: f.file,
        line: f.matchedLine,
        severity: f.severity,
        confidence: f.confidence,
        quote: f.quote,
        claim: f.claim,
        whyItBreaks: f.why_it_breaks,
        verdict: r.verdict,
        evidence: r.evidence,
      };
    });
    const confirmed = verified.results
      .filter((r) => r.verdict === 'confirmed')
      .map((r) => ({ finding: byId.get(r.id)!, evidence: r.evidence }));
    const rejected = verified.results
      .filter((r) => r.verdict !== 'confirmed')
      .map((r) => ({ finding: byId.get(r.id)!, verdict: r.verdict, evidence: r.evidence }));

    io.out(`\n=== PR #${pr} (${findModel} → ${verifyModel}) ===`);
    io.out(`raised ${raised.length} → gated ${kept.length} → verified ${confirmed.length}\n`);
    for (const d of dropped) io.out(`  [gate:${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
    for (const r of rejected) io.out(`  [verify:${r.verdict}] ${r.finding.file}: ${r.finding.claim}`);
    for (const c of confirmed) {
      io.out(`\n  PUBLISHED ${c.finding.severity} ${c.finding.file}:${c.finding.matchedLine}`);
      io.out(`    claim:    ${c.finding.claim}`);
      io.out(`    evidence: ${c.evidence}`);
    }

    const findUsd = costUsd(findModel, found.usage);
    const verifyUsd = costUsd(verifyModel, verified.usage);
    const runUsd = findUsd === null || verifyUsd === null ? null : findUsd + verifyUsd;
    io.out(`\n${formatCostLine({ find: found.usage, verify: verified.usage, runUsd, totalUsd: runUsd, unpriced: runUsd === null ? 1 : 0 })}`);
    return EXIT.ok;
  };

  if (rec === null) return execute();
  let code: number;
  try {
    code = await execute();
  } catch (error) {
    // Only the error text is scrubbed: the model's own words in the record cannot hold a key it never saw.
    const message = error instanceof Error ? error.message : String(error);
    rec.run(runLine(EXIT.failed, chosen!.apiKey === '' ? message : message.replaceAll(chosen!.apiKey, '***')));
    throw error;
  }
  rec.run(runLine(code, null));
  return code;
}
