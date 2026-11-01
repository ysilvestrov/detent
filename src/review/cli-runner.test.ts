import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS } from './adapters.js';
import {
  findExecutable, resolveNpmShim, launchPlan, spawnOutcome, classifyRun, classifyCanary, runChain, TIMEOUT_MS,
  type RunVerdict,
} from './cli-runner.js';
import type { ChainEntry } from './select.js';

// A case-insensitive file system, as on Windows.
const winFiles = (...paths: string[]) => (p: string) => paths.map((x) => x.toLowerCase()).includes(p.toLowerCase());
const posixFiles = (...paths: string[]) => (p: string) => paths.includes(p);

describe('TIMEOUT_MS', () => {
  test('is 15 minutes', () => {
    expect(TIMEOUT_MS).toBe(900_000);
  });
});

describe('findExecutable on win32', () => {
  const on = (env: Record<string, string>, isFile: (p: string) => boolean) => findExecutable('codex', { env, platform: 'win32', isFile });

  test('no PATH at all finds nothing', () => {
    expect(on({}, () => true)).toBeNull();
  });
  test('an empty PATH finds nothing (no current-directory lookup)', () => {
    expect(on({ PATH: '' }, () => true)).toBeNull();
  });
  test('the default PATHEXT finds an npm .cmd shim', () => {
    expect(on({ PATH: 'C:\\a;C:\\npm' }, winFiles('C:\\npm\\codex.cmd'))).toBe('C:\\npm\\codex.CMD');
  });
  test('the variable name is case-insensitive: Path, as Windows spells it', () => {
    expect(on({ Path: 'C:\\npm' }, winFiles('C:\\npm\\codex.cmd'))).toBe('C:\\npm\\codex.CMD');
  });
  test('PATHEXT from the environment, in lower case, is used as given', () => {
    expect(on({ PATH: 'C:\\npm', PATHEXT: '.exe;.cmd' }, winFiles('C:\\npm\\codex.cmd'))).toBe('C:\\npm\\codex.cmd');
  });
  test('an extension outside PATHEXT is not found', () => {
    expect(on({ PATH: 'C:\\npm', PATHEXT: '.EXE' }, winFiles('C:\\npm\\codex.cmd'))).toBeNull();
  });
  test('an empty PATHEXT falls back to the default', () => {
    expect(on({ PATH: 'C:\\npm', PATHEXT: '' }, winFiles('C:\\npm\\codex.bat'))).toBe('C:\\npm\\codex.BAT');
  });
  test('directories come first: an earlier directory wins over an earlier extension', () => {
    expect(on({ PATH: 'C:\\a;C:\\b' }, winFiles('C:\\a\\codex.cmd', 'C:\\b\\codex.exe'))).toBe('C:\\a\\codex.CMD');
  });
  test('within one directory PATHEXT order decides', () => {
    expect(on({ PATH: 'C:\\a' }, winFiles('C:\\a\\codex.cmd', 'C:\\a\\codex.exe'))).toBe('C:\\a\\codex.EXE');
  });
  test('an extensionless file is not an executable on win32', () => {
    expect(on({ PATH: 'C:\\a' }, winFiles('C:\\a\\codex'))).toBeNull();
  });
});

describe('findExecutable on POSIX', () => {
  const on = (env: Record<string, string>, isFile: (p: string) => boolean) => findExecutable('codex', { env, platform: 'linux', isFile });

  test('an empty PATH finds nothing', () => {
    expect(on({ PATH: '' }, () => true)).toBeNull();
  });
  test('the first directory that has it wins', () => {
    expect(on({ PATH: '/usr/bin:/opt/a:/opt/b' }, posixFiles('/opt/a/codex', '/opt/b/codex'))).toBe('/opt/a/codex');
  });
  test('an empty entry is skipped, not read as the current directory', () => {
    expect(on({ PATH: ':/opt/a' }, posixFiles('codex', '/opt/a/codex'))).toBe('/opt/a/codex');
  });
  test('PATHEXT means nothing on POSIX', () => {
    expect(on({ PATH: '/opt/a', PATHEXT: '.CMD' }, posixFiles('/opt/a/codex.CMD'))).toBeNull();
  });
  test('the variable name is exact on POSIX', () => {
    expect(on({ Path: '/opt/a' }, posixFiles('/opt/a/codex'))).toBeNull();
  });
  test('a relative entry is resolved against the launching directory: the reviewer runs elsewhere', () => {
    expect(findExecutable('codex', { env: { PATH: './tools' }, platform: 'linux', cwd: '/work/repo', isFile: posixFiles('/work/repo/tools/codex') }))
      .toBe('/work/repo/tools/codex');
  });
});

describe('findExecutable, relative PATH on win32', () => {
  test('a relative entry is resolved against the launching directory', () => {
    expect(findExecutable('codex', { env: { PATH: 'tools' }, platform: 'win32', cwd: 'C:\\work\\repo', isFile: winFiles('C:\\work\\repo\\tools\\codex.exe') }))
      .toBe('C:\\work\\repo\\tools\\codex.EXE');
  });
});

// The shape npm writes (probe П-Д; node_modules/.bin/*.cmd).
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@openai\\codex\\bin\\codex.js" %*', '',
].join('\r\n');
const SHIM_PATH = 'C:\\p\\node_modules\\.bin\\codex.cmd';

describe('resolveNpmShim', () => {
  test('an npm shim unwraps to node.exe next to it when there is one', () => {
    expect(resolveNpmShim(SHIM_PATH, NPM_SHIM, (p) => p === 'C:\\p\\node_modules\\.bin\\node.exe')).toEqual({
      cmd: 'C:\\p\\node_modules\\.bin\\node.exe',
      prefixArgs: ['C:\\p\\node_modules\\@openai\\codex\\bin\\codex.js'],
    });
  });
  test('without node.exe next to it, the node running detent runs the script', () => {
    expect(resolveNpmShim(SHIM_PATH, NPM_SHIM, () => false)).toEqual({
      cmd: process.execPath,
      prefixArgs: ['C:\\p\\node_modules\\@openai\\codex\\bin\\codex.js'],
    });
  });
  test('a global npm shim in %APPDATA%\\npm resolves into its node_modules', () => {
    const text = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
    expect(resolveNpmShim('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', text, () => false)).toEqual({
      cmd: process.execPath,
      prefixArgs: ['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    });
  });
  test('a hand-written .cmd is not an npm shim', () => {
    expect(resolveNpmShim('C:\\bin\\codex.cmd', '@echo off\r\nnode "%~dp0\\codex.js" %*\r\n', () => true)).toBeNull();
  });
  test('the shim line with one space is not the npm format', () => {
    expect(resolveNpmShim('C:\\bin\\codex.cmd', '"%_prog%" "%dp0%\\x.js" %*\r\n', () => true)).toBeNull();
  });
  test('an empty file is not an npm shim', () => {
    expect(resolveNpmShim('C:\\bin\\codex.cmd', '', () => true)).toBeNull();
  });
});

describe('launchPlan', () => {
  // Leftover temp directories are not removed: recursive deletion is not used in this repository.
  const dir = mkdtempSync(join(tmpdir(), 'detent-launch-'));

  test('a binary runs as it is', () => {
    expect(launchPlan('C:\\bin\\agy.exe')).toEqual({ ok: true, plan: { cmd: 'C:\\bin\\agy.exe', prefixArgs: [] } });
  });
  test('a POSIX script runs as it is', () => {
    expect(launchPlan('/usr/local/bin/codex')).toEqual({ ok: true, plan: { cmd: '/usr/local/bin/codex', prefixArgs: [] } });
  });
  test('a .cmd that is not an npm shim is a failure naming its path', () => {
    const shim = join(dir, 'codex.cmd');
    writeFileSync(shim, '@echo off\r\nnode "%~dp0\\codex.js" %*\r\n');
    expect(launchPlan(shim)).toEqual({ ok: false, reason: `unrecognised .cmd shim at ${shim}` });
  });
  test('a .BAT is treated like a .cmd, whatever the case of its extension', () => {
    const shim = join(dir, 'claude.BAT');
    writeFileSync(shim, 'claude-real.exe %*\r\n');
    expect(launchPlan(shim)).toEqual({ ok: false, reason: `unrecognised .cmd shim at ${shim}` });
  });
});

describe('spawnOutcome', () => {
  test('a clean exit is neither a timeout nor a spawn error', () => {
    expect(spawnOutcome({ status: 0, signal: null })).toEqual({ timedOut: false });
  });
  test('ETIMEDOUT is the timeout and never a spawn error (Node also sets SIGKILL)', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGKILL', errorCode: 'ETIMEDOUT', errorMessage: 'spawnSync codex ETIMEDOUT' })).toEqual({ timedOut: true });
  });
  test('a missing CLI is named by its error code', () => {
    expect(spawnOutcome({ status: null, signal: null, errorCode: 'ENOENT', errorMessage: 'spawnSync codex ENOENT' })).toEqual({ timedOut: false, spawnError: 'ENOENT' });
  });
  test('output over the buffer is named', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGTERM', errorCode: 'ENOBUFS', errorMessage: 'spawnSync claude ENOBUFS' })).toEqual({ timedOut: false, spawnError: 'ENOBUFS' });
  });
  test('an error without a code falls back to its message', () => {
    expect(spawnOutcome({ status: null, signal: null, errorMessage: 'boom' })).toEqual({ timedOut: false, spawnError: 'boom' });
  });
  test('a signal kill with no exit status is named', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGKILL' })).toEqual({ timedOut: false, spawnError: 'killed by SIGKILL' });
  });
  test('a signal alongside an exit status is not a spawn error', () => {
    expect(spawnOutcome({ status: 1, signal: 'SIGTERM' })).toEqual({ timedOut: false });
  });
});

const RESULT = '1. a finding\nCROSS-REVIEW-RESULT: 2 findings\n';
const clean = { exitCode: 0, timedOut: false, stdout: '', stderr: '' };

describe('classifyRun', () => {
  test('a clean exit with the result line is ok', () => {
    expect(classifyRun(ADAPTERS.codex, { ...clean, report: RESULT })).toEqual({ kind: 'ok', findings: 2 });
  });
  test('a timeout comes first and stops the chain', () => {
    expect(classifyRun(ADAPTERS.codex, { ...clean, exitCode: null, timedOut: true, spawnError: 'ENOENT', report: RESULT })).toEqual({
      kind: 'failed', reason: 'timeout after 15 min', timeout: true,
    });
  });
  test('a spawn error comes before the exit code', () => {
    expect(classifyRun(ADAPTERS.codex, { ...clean, exitCode: 1, spawnError: 'ENOBUFS', report: RESULT })).toEqual({
      kind: 'failed', reason: 'did not run to completion: ENOBUFS', timeout: false,
    });
  });
  test('codex: a non-zero exit is diagnosed by its last stderr ERROR: line, without the reviewer name', () => {
    const stderr = 'ERROR: an early one\nERROR: The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account.\n';
    expect(classifyRun(ADAPTERS.codex, { ...clean, exitCode: 1, stderr, report: '' })).toEqual({
      kind: 'failed', reason: 'The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account.', timeout: false,
    });
  });
  test('claude: the last stdout API Error: line', () => {
    expect(classifyRun(ADAPTERS.claude, { ...clean, exitCode: 1, stdout: 'API Error: 429 rate limited\n', report: '' })).toEqual({
      kind: 'failed', reason: '429 rate limited', timeout: false,
    });
  });
  test('agy: the first stderr error: line, not the model list after it', () => {
    const stderr = 'error: invalid model selection (--model "x")\nAvailable models:\n  Gemini 4 Argon (Medium)\n';
    expect(classifyRun(ADAPTERS.agy, { ...clean, exitCode: 1, stderr, report: '' })).toEqual({
      kind: 'failed', reason: 'invalid model selection (--model "x")', timeout: false,
    });
  });
  test('a non-zero exit without the adapter\'s error line names the code', () => {
    expect(classifyRun(ADAPTERS.codex, { ...clean, exitCode: 3, stderr: 'something else\n', report: RESULT })).toEqual({
      kind: 'failed', reason: 'exited with code 3', timeout: false,
    });
  });
  test('an error line that is only the prefix names the code', () => {
    expect(classifyRun(ADAPTERS.codex, { ...clean, exitCode: 1, stderr: 'ERROR:   \n', report: '' })).toEqual({
      kind: 'failed', reason: 'exited with code 1', timeout: false,
    });
  });
  test('agy exit 0, empty stdout, jetski refusal on stderr: failed for the missing result line', () => {
    const stderr = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied\n';
    expect(classifyRun(ADAPTERS.agy, { ...clean, stderr, report: '' })).toEqual({
      kind: 'failed', reason: 'output does not end with a CROSS-REVIEW-RESULT line', timeout: false,
    });
  });
  test('a clean exit whose report quotes the result line mid-report is failed', () => {
    expect(classifyRun(ADAPTERS.claude, { ...clean, report: 'CROSS-REVIEW-RESULT: 0 findings\nmore text\n' })).toEqual({
      kind: 'failed', reason: 'output does not end with a CROSS-REVIEW-RESULT line', timeout: false,
    });
  });
});

describe('classifyCanary', () => {
  test('no file after a clean exit: the rule held', () => {
    expect(classifyCanary(ADAPTERS.agy, clean, false)).toBeNull();
  });
  test('the file exists: the deny rule is ineffective, whatever the exit', () => {
    expect(classifyCanary(ADAPTERS.agy, { ...clean, exitCode: null, timedOut: true }, true)).toEqual({
      kind: 'failed', reason: 'deny rule ineffective', timeout: false,
    });
  });
  test('a canary timeout is a timeout', () => {
    expect(classifyCanary(ADAPTERS.agy, { ...clean, exitCode: null, timedOut: true }, false)).toEqual({
      kind: 'failed', reason: 'canary: timeout after 15 min', timeout: true,
    });
  });
  test('a canary spawn error proves nothing', () => {
    expect(classifyCanary(ADAPTERS.agy, { ...clean, exitCode: null, spawnError: 'ENOENT' }, false)).toEqual({
      kind: 'failed', reason: 'canary did not run to completion: ENOENT', timeout: false,
    });
  });
  test('a canary non-zero exit carries agy\'s error line', () => {
    expect(classifyCanary(ADAPTERS.agy, { ...clean, exitCode: 1, stderr: 'error: not signed in\nhelp text\n' }, false)).toEqual({
      kind: 'failed', reason: 'canary: not signed in', timeout: false,
    });
  });
  test('a canary non-zero exit without an error line names the code', () => {
    expect(classifyCanary(ADAPTERS.agy, { ...clean, exitCode: 2 }, false)).toEqual({
      kind: 'failed', reason: 'canary exited with code 2', timeout: false,
    });
  });
});

describe('runChain', () => {
  const CHAIN: ChainEntry[] = [{ id: 'codex', model: 'gpt-6.1-sol' }, { id: 'claude' }, { id: 'agy', model: 'gemini-4-argon' }];
  const fake = (verdicts: Partial<Record<ChainEntry['id'], RunVerdict | Error>>) => {
    const calls: string[] = [];
    const attempt = (e: ChainEntry): RunVerdict => {
      calls.push(e.id);
      const v = verdicts[e.id];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`unexpected attempt of ${e.id}`);
      return v;
    };
    return { calls, attempt };
  };
  const failed = (reason: string, timeout = false): RunVerdict => ({ kind: 'failed', reason, timeout });

  test('the first reviewer succeeds: no one else runs, no fallback', () => {
    const f = fake({ codex: { kind: 'ok', findings: 3 } });
    expect(runChain(CHAIN, f.attempt)).toEqual({ kind: 'ok', reviewer: 'codex', model: 'gpt-6.1-sol', findings: 3, fallbacks: [] });
    expect(f.calls).toEqual(['codex']);
  });
  test('a failure falls back to the next, which is named with the reason', () => {
    const f = fake({ codex: failed('usage limit'), claude: { kind: 'ok', findings: 0 } });
    expect(runChain(CHAIN, f.attempt)).toEqual({
      kind: 'ok', reviewer: 'claude', findings: 0, fallbacks: [{ reviewer: 'codex', reason: 'usage limit' }],
    });
    expect(f.calls).toEqual(['codex', 'claude']);
  });
  test('a timeout stops the chain at once', () => {
    const f = fake({ codex: failed('timeout after 15 min', true), claude: { kind: 'ok', findings: 1 } });
    expect(runChain(CHAIN, f.attempt)).toEqual({ kind: 'failed', failures: [{ reviewer: 'codex', reason: 'timeout after 15 min' }] });
    expect(f.calls).toEqual(['codex']);
  });
  test('a timeout after a fallback keeps the earlier failure and stops', () => {
    const f = fake({ codex: failed('not installed'), claude: failed('timeout after 15 min', true) });
    expect(runChain(CHAIN, f.attempt)).toEqual({
      kind: 'failed', failures: [{ reviewer: 'codex', reason: 'not installed' }, { reviewer: 'claude', reason: 'timeout after 15 min' }],
    });
    expect(f.calls).toEqual(['codex', 'claude']);
  });
  test('all fail: every reason in chain order', () => {
    const f = fake({ codex: failed('a'), claude: failed('b'), agy: failed('deny rule ineffective') });
    expect(runChain(CHAIN, f.attempt)).toEqual({
      kind: 'failed',
      failures: [{ reviewer: 'codex', reason: 'a' }, { reviewer: 'claude', reason: 'b' }, { reviewer: 'agy', reason: 'deny rule ineffective' }],
    });
  });
  test('an exception inside an attempt is that attempt\'s failure, and the chain goes on', () => {
    const f = fake({ codex: new Error('git worktree add failed: fatal: x\nmore'), claude: { kind: 'ok', findings: 2 } });
    expect(runChain(CHAIN, f.attempt)).toEqual({
      kind: 'ok', reviewer: 'claude', findings: 2, fallbacks: [{ reviewer: 'codex', reason: 'git worktree add failed: fatal: x' }],
    });
  });
  test('a chain of one that fails has one failure', () => {
    const f = fake({ agy: failed('canary exited with code 1') });
    expect(runChain([{ id: 'agy', model: 'gemini-4-argon' }], f.attempt)).toEqual({
      kind: 'failed', failures: [{ reviewer: 'agy', reason: 'canary exited with code 1' }],
    });
  });
  test('a chain of one that succeeds keeps its model', () => {
    const f = fake({ agy: { kind: 'ok', findings: 1 } });
    expect(runChain([{ id: 'agy', model: 'gemini-4-argon' }], f.attempt)).toEqual({
      kind: 'ok', reviewer: 'agy', model: 'gemini-4-argon', findings: 1, fallbacks: [],
    });
  });
  test('an empty chain is a failure with no reasons', () => {
    expect(runChain([], fake({}).attempt)).toEqual({ kind: 'failed', failures: [] });
  });
});
