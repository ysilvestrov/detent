// The CLI transport of a review: the only place with spawnSync, the snapshot worktree and the
// timeout (spec, «Під реліз 2»). Everything that decides is a plain function so it can be tested;
// `runAttempt` is the I/O that strings them together for one reviewer.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { classifyResult, markerReason, type Mode, type ReviewerFailure } from './protocol.js';
import { ADAPTERS, errorLineOf, type ReviewerAdapter } from './adapters.js';
import { runArtifacts, runDirPrefix } from './preflight.js';
import type { ChainEntry } from './select.js';

export const TIMEOUT_MS = 900_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_REASON = 'timeout after 15 min';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const AGY_WIN32_HINT = 'agy.exe is usually in %LOCALAPPDATA%\\agy\\bin; a shell started before the install does not see it';

type Env = Readonly<Record<string, string | undefined>>;

// Windows environment names are case-insensitive (`Path` is the usual spelling), but a copied env
// object is not, so the lookup is done by hand there.
function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The runner looks the binary up itself, because spawnSync without a shell cannot start a `.cmd`
// and so cannot be left to find one (probe П-Д): PATH × PATHEXT on win32, PATH on POSIX.
// Empty PATH entries are skipped: an empty entry would mean the current directory. A relative
// entry is resolved against the launching directory, because the reviewer runs in the snapshot.
export function findExecutable(
  cmd: string,
  o: { env: Env; platform: NodeJS.Platform; cwd?: string; isFile?: (p: string) => boolean },
): string | null {
  const isFile = o.isFile ?? isExecutableFile;
  const win = o.platform === 'win32';
  const dirs = (envValue(o.env, 'PATH', o.platform) ?? '').split(win ? ';' : ':').filter((d) => d !== '');
  const exts = win
    ? (envValue(o.env, 'PATHEXT', o.platform) || DEFAULT_PATHEXT).split(';').filter((e) => e !== '')
    : [''];
  const resolve = win ? win32.resolve : posix.resolve;
  const cwd = o.cwd ?? process.cwd();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(cwd, dir, cmd + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface LaunchPlan { cmd: string; prefixArgs: string[] }

// An npm `.cmd` shim ends in `"%_prog%"  "%dp0%\<rel>" %*`, where `_prog` is node.exe next to the
// shim, else `node` (probe П-Д). Unwrapped the same way, the script runs without a shell, so stdin
// stays closed and the prompt stays one argument. Node falls back to the one running detent.
const NPM_SHIM_LINE = /"%_prog%" {2}"%dp0%\\([^"]+)" %\*/;

export function resolveNpmShim(shimPath: string, text: string, nodeExeExists: (p: string) => boolean): LaunchPlan | null {
  const m = NPM_SHIM_LINE.exec(text);
  if (!m) return null;
  const dir = win32.dirname(shimPath);
  const nodeExe = win32.join(dir, 'node.exe');
  return { cmd: nodeExeExists(nodeExe) ? nodeExe : process.execPath, prefixArgs: [win32.join(dir, m[1] as string)] };
}

export function launchPlan(found: string): { ok: true; plan: LaunchPlan } | { ok: false; reason: string } {
  const ext = win32.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { ok: true, plan: { cmd: found, prefixArgs: [] } };
  const plan = resolveNpmShim(found, readFileSync(found, 'utf8'), existsSync);
  return plan === null ? { ok: false, reason: `unrecognised .cmd shim at ${found}` } : { ok: true, plan };
}

// How spawnSync ended, reduced to what the classifiers need. Node reports a timeout as error code
// ETIMEDOUT (plus the kill signal), which is the timeout and never a spawn error.
export function spawnOutcome(r: {
  status: number | null; signal: string | null; errorCode?: string; errorMessage?: string;
}): { timedOut: boolean; spawnError?: string } {
  if (r.errorCode === 'ETIMEDOUT') return { timedOut: true };
  const spawnError = r.errorCode ?? r.errorMessage ?? (r.signal && r.status === null ? `killed by ${r.signal}` : undefined);
  return spawnError === undefined ? { timedOut: false } : { timedOut: false, spawnError };
}

export interface ProcessOutcome { exitCode: number | null; timedOut: boolean; spawnError?: string; stdout: string; stderr: string }
export type RunVerdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string; timeout: boolean };

// The tail of the adapter's own error line, or null when it gave none (or only the prefix).
function errorTail(adapter: Pick<ReviewerAdapter, 'errorLine'>, stdout: string, stderr: string): string | null {
  const line = errorLineOf(adapter, stdout, stderr);
  if (line === null) return null;
  const tail = line.slice(adapter.errorLine.prefix.length).trim();
  return tail === '' ? null : tail;
}

// The reason carries no reviewer name: the chain prefixes `<id>: ` (plan, «Причини»).
export function classifyRun(
  adapter: Pick<ReviewerAdapter, 'errorLine'>,
  r: ProcessOutcome & { report: string },
): RunVerdict {
  if (r.timedOut) return { kind: 'failed', reason: TIMEOUT_REASON, timeout: true };
  if (r.spawnError !== undefined) return { kind: 'failed', reason: `did not run to completion: ${r.spawnError}`, timeout: false };
  if (r.exitCode !== 0) {
    return { kind: 'failed', reason: errorTail(adapter, r.stdout, r.stderr) ?? `exited with code ${r.exitCode}`, timeout: false };
  }
  const v = classifyResult(r.report);
  return v.kind === 'ok' ? v : { kind: 'failed', reason: v.reason, timeout: false };
}

// The canary proves the deny rule: a file means the rule does nothing in this CLI version, and a
// canary that did not finish cleanly proves nothing either. No file is not enough on its own: a
// model that never called write_file leaves none too, so the refusal itself must be in the output
// (owner's amendment). The short substring survives small rewordings of agy's message. Every
// canary failure says so, so the marker shows agy never reviewed. A canary timeout is a timeout.
const CANARY_FAILED = 'canary failed, review not run: ';
const DENY_RULE = /deny rule/i;

export function classifyCanary(
  adapter: Pick<ReviewerAdapter, 'errorLine'>,
  r: ProcessOutcome,
  fileExists: boolean,
): Extract<RunVerdict, { kind: 'failed' }> | null {
  const failed = (detail: string, timeout = false) => ({ kind: 'failed' as const, reason: CANARY_FAILED + detail, timeout });
  if (fileExists) return failed('deny rule ineffective (canary file was written)');
  if (r.timedOut) return failed(TIMEOUT_REASON, true);
  if (r.spawnError !== undefined) return failed(`did not run to completion: ${r.spawnError}`);
  if (r.exitCode !== 0) return failed(errorTail(adapter, r.stdout, r.stderr) ?? `exited with code ${r.exitCode}`);
  if (!DENY_RULE.test(r.stdout) && !DENY_RULE.test(r.stderr)) return failed('no "deny rule" in its output');
  return null;
}

export type ChainResult =
  | { kind: 'ok'; reviewer: ChainEntry['id']; model?: string; findings: number; fallbacks: ReviewerFailure[] }
  | { kind: 'failed'; failures: ReviewerFailure[] };

// Down the chain until the first success. A timeout stops it: the reviewer worked and did not
// finish, and another 15 min is not worth it. An exception inside an attempt (worktree add, a file
// write) is that attempt's failure, not the chain's.
export function runChain(chain: readonly ChainEntry[], attempt: (entry: ChainEntry) => RunVerdict): ChainResult {
  const failures: ReviewerFailure[] = [];
  for (const entry of chain) {
    let v: RunVerdict;
    try {
      v = attempt(entry);
    } catch (error) {
      v = { kind: 'failed', reason: markerReason(error instanceof Error ? error.message : String(error)), timeout: false };
    }
    if (v.kind === 'ok') {
      const ok: ChainResult = { kind: 'ok', reviewer: entry.id, findings: v.findings, fallbacks: failures };
      if (entry.model !== undefined) ok.model = entry.model;
      return ok;
    }
    failures.push({ reviewer: entry.id, reason: v.reason });
    if (v.timeout) break;
  }
  return { kind: 'failed', failures };
}

export interface AttemptContext {
  root: string; // the repository root; git runs here
  tmpDir: string; // absolute; run directories are created in it
  sha: string;
  branch: string;
  mode: Mode;
  diff: string; // written to the run directory in diff mode
  prompt: (paths: { diff: string }) => string;
  env: Env;
  platform: NodeJS.Platform;
  timeoutMs: number;
  progress: (line: string) => void;
}

function git(root: string, env: Env, args: string[]): void {
  const r = spawnSync('git', args, { cwd: root, env: { ...env }, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
}

// Best-effort cleanup of a snapshot worktree; a failure here must not mask the review's own result.
function removeSnapshot(root: string, env: Env, dir: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, env: { ...env }, encoding: 'utf8', windowsHide: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root, env: { ...env }, encoding: 'utf8', windowsHide: true });
}

function spawnReviewer(plan: LaunchPlan, args: string[], cwd: string, ctx: AttemptContext): ProcessOutcome & { errorText: string } {
  const r = spawnSync(plan.cmd, [...plan.prefixArgs, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // codex reads an open stdin as more input (probe П-В0)
    timeout: ctx.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    env: { ...ctx.env, CROSS_REVIEW_ACTIVE: '1' },
    windowsHide: true,
  });
  const err = r.error as NodeJS.ErrnoException | undefined;
  const o = spawnOutcome({ status: r.status, signal: r.signal, errorCode: err?.code, errorMessage: err?.message });
  const outcome: ProcessOutcome & { errorText: string } = {
    exitCode: r.status, timedOut: o.timedOut, stdout: r.stdout ?? '', stderr: r.stderr ?? '', errorText: err ? err.message : '',
  };
  if (o.spawnError !== undefined) outcome.spawnError = o.spawnError;
  return outcome;
}

function logSection(title: string, o: ProcessOutcome & { errorText: string }): string {
  return `--- ${title} ---\n${o.stdout}\n${o.stderr}${o.errorText ? `\n${o.errorText}` : ''}\n`;
}

// One reviewer of the chain: a missing binary fails without a process; otherwise the attempt owns
// a fresh run directory and a snapshot worktree of exactly `sha`, which `finally` removes.
export function runAttempt(entry: ChainEntry, ctx: AttemptContext, adapters: Readonly<Record<ChainEntry['id'], ReviewerAdapter>> = ADAPTERS): RunVerdict {
  const adapter = adapters[entry.id];
  const found = findExecutable(entry.id, { env: ctx.env, platform: ctx.platform }); // every adapter's cmd is its id
  if (found === null) {
    const hint = entry.id === 'agy' && ctx.platform === 'win32' ? ` (${AGY_WIN32_HINT})` : '';
    ctx.progress(`cross-review: ${entry.id} is not installed (not in PATH)${hint}`);
    return { kind: 'failed', reason: `not installed${hint}`, timeout: false };
  }
  const launch = launchPlan(found);
  if (!launch.ok) {
    ctx.progress(`cross-review: ${entry.id} — ${launch.reason}`);
    return { kind: 'failed', reason: launch.reason, timeout: false };
  }

  mkdirSync(ctx.tmpDir, { recursive: true });
  const runDir = mkdtempSync(runDirPrefix(ctx.tmpDir, entry.id, ctx.branch, ctx.sha, ctx.mode));
  const paths = runArtifacts(runDir);
  if (ctx.mode === 'diff') writeFileSync(paths.diff, ctx.diff);
  const prompt = ctx.prompt({ diff: paths.diff });
  const command = entry.model === undefined
    ? adapter.command({ prompt, reportPath: paths.report, runDir })
    : adapter.command({ model: entry.model, prompt, reportPath: paths.report, runDir });

  let log = '';
  try {
    git(ctx.root, ctx.env, ['worktree', 'add', '--detach', paths.snapshot, ctx.sha]);

    if (adapter.canary !== undefined) {
      if (entry.model === undefined) throw new Error(`${entry.id} canary needs an explicit model`);
      const canary = adapter.canary({ runDir, model: entry.model });
      ctx.progress(`cross-review: ${entry.id} canary — proving its deny rule blocks write_file…`);
      const c = spawnReviewer(launch.plan, canary.args, paths.snapshot, ctx);
      log += logSection('canary', c);
      const failed = classifyCanary(adapter, c, existsSync(canary.mustNotExist));
      if (failed !== null) {
        ctx.progress(`cross-review: ${entry.id} failed — ${failed.reason}. Log: ${paths.log}`);
        return failed;
      }
    }

    ctx.progress(`cross-review: ${entry.id}${entry.model === undefined ? '' : `/${entry.model}`} reviewing (up to ${ctx.timeoutMs / 1000} s)…`);
    const r = spawnReviewer(launch.plan, command.args, paths.snapshot, ctx);
    log += logSection('review', r);
    if (command.report === 'stdout') writeFileSync(paths.report, r.stdout);
    const report = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : '';
    const v = classifyRun(adapter, { ...r, report });
    if (v.kind === 'failed') ctx.progress(`cross-review: ${entry.id} failed — ${v.reason}. Log: ${paths.log}`);
    else ctx.progress(`cross-review: ${entry.id} — ${v.findings} finding(s). Report: ${paths.report}`);
    return v;
  } finally {
    // The snapshot goes even when the log cannot be written (a full disk): cleanup is guaranteed.
    try {
      if (log !== '') writeFileSync(paths.log, log);
    } finally {
      removeSnapshot(ctx.root, ctx.env, paths.snapshot);
    }
  }
}
