// `detent cross-review` (spec, «CLI `detent cross-review`»). The checks run in the plan's order;
// any of them failing means no review was attempted (exit 2, or 3 for a nested run). Only after
// all of them does the chain run, and only the chain can give exit 5.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config.js';
import { parseCrossReviewArgs } from '../review/args.js';
import { selectChain } from '../review/select.js';
import { isNestedRun, normalizeSpecPath, preflight, specPathError, specPreflight } from '../review/preflight.js';
import { failedBody, markerLine, markerReason, renderPrompt, successBody, type Mode } from '../review/protocol.js';
import { runAttempt, runChain, type AttemptContext } from '../review/cli-runner.js';

export const EXIT = { ok: 0, usage: 2, nested: 3, reviewerFailed: 5 } as const;

export const USAGE = 'Usage: detent cross-review --author claude|codex|agy [--reviewer <id>] [--base <ref> | --spec <file>] [--model <id>]';

type Env = Readonly<Record<string, string | undefined>>;

export interface CrossReviewIo {
  cwd: string;
  env: Env;
  timeoutMs: number;
  out: (line: string) => void; // the marker
  err: (line: string) => void; // progress and errors
  platform?: NodeJS.Platform;
}

function gitText(cwd: string, env: Env, args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: { ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectName(root: string): string {
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    try {
      const name = (JSON.parse(readFileSync(pkg, 'utf8').replace(/^﻿/, '')) as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') return name;
    } catch {
      // an unreadable package.json names nothing; the folder name does
    }
  }
  return basename(root);
}

// The project may override a core prompt with `.detent/prompts/review-<mode>.md`.
function promptTemplate(root: string, mode: Mode): string {
  const override = join(root, '.detent', 'prompts', `review-${mode}.md`);
  if (existsSync(override)) return readFileSync(override, 'utf8');
  return readFileSync(fileURLToPath(new URL(`../../prompts/review-${mode}.md`, import.meta.url)), 'utf8');
}

export function crossReview(argv: readonly string[], io: CrossReviewIo): number {
  const fail = (code: number, message: string): number => {
    io.err(`cross-review: ${message}`);
    return code;
  };

  if (isNestedRun(io.env)) return fail(EXIT.nested, 'refusing to run inside a cross-review (CROSS_REVIEW_ACTIVE=1)');

  const parsed = parseCrossReviewArgs(argv, io.env);
  if (!parsed.ok) return fail(EXIT.usage, `${parsed.error}\n${USAGE}`);
  const opts = parsed.opts;
  const mode: Mode = opts.spec === undefined ? 'diff' : 'spec';

  // Everything read from git before a run exists. A failure here is a usage error, never a `failed` marker.
  let root: string, sha: string, branch: string, dirty: boolean;
  try {
    root = gitText(io.cwd, io.env, ['rev-parse', '--show-toplevel']).trim();
    sha = gitText(io.cwd, io.env, ['rev-parse', 'HEAD']).trim();
    branch = gitText(io.cwd, io.env, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    dirty = gitText(io.cwd, io.env, ['status', '--porcelain']).trim() !== '';
  } catch (error) {
    return fail(EXIT.usage, markerReason(messageOf(error)));
  }

  const configPath = join(root, 'detent.json');
  let configText: string | null;
  try {
    configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  } catch (error) {
    return fail(EXIT.usage, `detent.json cannot be read: ${markerReason(messageOf(error))}`);
  }
  const cfg = parseConfig(configText);
  if (!cfg.ok) return fail(EXIT.usage, cfg.error);
  const config = cfg.config;

  const selectInput: Parameters<typeof selectChain>[0] = { author: opts.author, config };
  if (opts.reviewer !== undefined) selectInput.reviewer = opts.reviewer;
  if (opts.model !== undefined) selectInput.model = opts.model;
  const selected = selectChain(selectInput);
  if (!selected.ok) return fail(EXIT.usage, selected.error);

  const specPath = opts.spec === undefined ? '' : normalizeSpecPath(opts.spec);
  if (mode === 'spec') {
    const pathError = specPathError(specPath, config.specsDir);
    if (pathError !== null) return fail(EXIT.usage, pathError);
  }

  const base = opts.base ?? config.baseBranch;
  let diff = '';
  let refusal: string | null;
  if (mode === 'spec') {
    // `git cat-file -e` exits non-zero when the path is not in HEAD's tree: an answer, not a failure.
    const inHead = spawnSync('git', ['cat-file', '-e', `HEAD:${specPath}`], { cwd: root, env: { ...io.env }, windowsHide: true }).status === 0;
    refusal = specPreflight({ dirty, inHead });
  } else {
    try {
      diff = gitText(root, io.env, ['diff', `${base}...${sha}`]);
    } catch (error) {
      return fail(EXIT.usage, markerReason(messageOf(error)));
    }
    refusal = preflight({ dirty, diffBytes: diff.length });
  }
  if (refusal !== null) return fail(EXIT.usage, refusal);

  const sha7 = sha.slice(0, 7);
  const common = {
    project: projectName(root), branch, sha: sha7, specFile: config.specFile, reviewContext: config.reviewContext ?? 'none stated',
  };
  const vars = (diffPath: string): Record<string, string> => mode === 'spec'
    ? { ...common, specPath }
    : { ...common, base, diffPath, specsDir: config.specsDir, plansDir: config.plansDir };
  let template: string;
  try {
    template = promptTemplate(root, mode);
    renderPrompt(template, vars('')); // an unknown placeholder is the project's mistake, not a reviewer's
  } catch (error) {
    return fail(EXIT.usage, markerReason(messageOf(error)));
  }

  const ctx: AttemptContext = {
    root,
    tmpDir: join(root, config.tmpDir),
    sha,
    branch,
    mode,
    diff,
    prompt: (paths) => renderPrompt(template, vars(paths.diff)),
    env: io.env,
    platform: io.platform ?? process.platform,
    timeoutMs: io.timeoutMs,
    progress: io.err,
  };
  const subject = mode === 'spec' ? `${specPath} @ ${sha7}` : `${branch} @ ${sha7} vs ${base}`;
  io.err(`cross-review: ${subject}; chain: ${selected.chain.map((e) => e.id).join(' → ')}`);
  const result = runChain(selected.chain, (entry) => {
    try {
      return runAttempt(entry, ctx);
    } catch (error) {
      io.err(`cross-review: ${entry.id} failed — ${markerReason(messageOf(error))}`);
      throw error;
    }
  });

  if (result.kind === 'failed') {
    io.out(markerLine(mode, failedBody(opts.author, result.failures)));
    return EXIT.reviewerFailed;
  }
  const body: Parameters<typeof successBody>[0] = {
    reviewer: result.reviewer, sha7, author: opts.author, findings: result.findings, fallbacks: result.fallbacks,
  };
  if (result.model !== undefined) body.model = result.model;
  io.out(markerLine(mode, successBody(body)));
  return EXIT.ok;
}
