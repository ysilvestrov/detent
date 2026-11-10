import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { runClaudeReview } from './claude.js';

const init = { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', tools: [], mcp_servers: [] };
const validReport = 'CHECK: requirements | not-verified | evidence: []\nCHECK: constitution | not-verified | evidence: []\nCHECK: format | not-verified | evidence: []\nCHECK: implementation | not-verified | evidence: []\nCHECK: reuse | not-verified | evidence: []\nCROSS-REVIEW-RESULT: 0 findings';
const success = (report = validReport) => ({
  type: 'result', subtype: 'success', result: report,
});
const stream = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

type FakeChild = EventEmitter & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean; pid: number;
};
type SpawnCall = (command: string, args: string[], options: SpawnOptions) => FakeChild;

function makeChild(pid: number): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true) as (signal?: NodeJS.Signals) => boolean, pid,
  }) as FakeChild;
}

function fakeProcess(output: string, code = 0) {
  const child = makeChild(421);
  let input = '';
  child.stdin.on('data', (chunk: Buffer | string) => { input += chunk.toString(); });
  const spawn = vi.fn<SpawnCall>(() => {
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', code, null);
    });
    return child;
  });
  return { child, spawn, getInput: () => input };
}

const options = {
  reviewer: { id: 'claude' as const, executable: 'C:\\Tools\\claude.exe', model: 'haiku' },
  text: 'committed review input', cwd: 'C:\\neutral',
};
const run = (request: Parameters<typeof runClaudeReview>[0], io: Parameters<typeof runClaudeReview>[1] = {}) =>
  runClaudeReview(request, { platform: 'win32', ...io });

describe('runClaudeReview', () => {
  it('rejects a count-only report and unsupported path evidence', async () => {
    const markerOnly = fakeProcess(stream(init, success('CROSS-REVIEW-RESULT: 0 findings')));
    await expect(run({ ...options, coverage: [{ path: 'src/a.ts', status: 'included', role: 'changed head blob' }] }, { spawn: markerOnly.spawn })).rejects.toThrow(/check|evidence|report/i);
    const unsupported = fakeProcess(stream(init, success('CHECK: implementation | verified | evidence: missing.ts\nCROSS-REVIEW-RESULT: 0 findings')));
    await expect(run({ ...options, coverage: [{ path: 'src/a.ts', status: 'included', role: 'changed head blob' }] }, { spawn: unsupported.spawn })).rejects.toThrow(/evidence|coverage/i);
  });

  it('accepts explicit checks grounded in supplied included and missing paths', async () => {
    const coverage = [
      { path: 'docs/specs/2026-11/a.md', status: 'included' as const, role: 'reviewed spec' },
      { path: 'constitution/constitution.md', status: 'missing' as const, role: 'constitution' },
      { path: 'format.md', status: 'included' as const, role: 'spec format' },
    ];
    const report = 'CHECK: requirements | verified | evidence: ["docs/specs/2026-11/a.md"]\nCHECK: constitution | not-verified | evidence: ["constitution/constitution.md"]\nCHECK: format | verified | evidence: ["format.md"]\nCHECK: implementation | not-verified | evidence: ["docs/specs/2026-11/a.md"]\nCHECK: reuse | not-verified | evidence: ["docs/specs/2026-11/a.md"]\nCROSS-REVIEW-RESULT: 0 findings';
    const { spawn } = fakeProcess(stream(init, success(report)));
    await expect(run({ ...options, coverage }, { spawn })).resolves.toMatchObject({ report, findings: 0 });
  });

  it('requires explicit not-verified implementation and reuse checks for a spec without code context', async () => {
    const coverage = [
      { path: 'docs/specs/2026-11/a.md', status: 'included' as const, role: 'reviewed spec' },
      { path: 'constitution/constitution.md', status: 'missing' as const, role: 'constitution' },
      { path: 'format.md', status: 'missing' as const, role: 'spec format' },
    ];
    const report = 'CHECK: requirements | verified | evidence: ["docs/specs/2026-11/a.md"]\nCHECK: constitution | not-verified | evidence: ["constitution/constitution.md"]\nCHECK: format | not-verified | evidence: ["format.md"]\nCHECK: implementation | not-verified | evidence: ["docs/specs/2026-11/a.md"]\nCHECK: reuse | not-verified | evidence: ["docs/specs/2026-11/a.md"]\nCROSS-REVIEW-RESULT: 0 findings';
    const { spawn } = fakeProcess(stream(init, success(report)));
    await expect(run({ ...options, coverage, mode: 'spec' }, { spawn })).resolves.toMatchObject({ report, findings: 0 });
    const wrong = fakeProcess(stream(init, success(report.replace('implementation | not-verified', 'implementation | verified'))));
    await expect(run({ ...options, coverage, mode: 'spec' }, { spawn: wrong.spawn })).rejects.toThrow(/implementation evidence/i);
    const withContext = [...coverage, { path: 'src/implementation.ts', status: 'included' as const, role: 'explicit context' }];
    const grounded = report.replace('implementation | not-verified | evidence: ["docs/specs/2026-11/a.md"]', 'implementation | verified | evidence: ["src/implementation.ts"]')
      .replace('reuse | not-verified | evidence: ["docs/specs/2026-11/a.md"]', 'reuse | verified | evidence: ["src/implementation.ts"]');
    const positive = fakeProcess(stream(init, success(grounded)));
    await expect(run({ ...options, coverage: withContext, mode: 'spec' }, { spawn: positive.spawn })).resolves.toMatchObject({ report: grounded });
  });

  it('requires constitution, implementation, tests and reuse checks for code review', async () => {
    const coverage = [{ path: 'src/main.ts', status: 'included' as const, role: 'changed head blob' }];
    const report = 'CHECK: constitution | not-verified | evidence: ["src/main.ts"]\nCHECK: implementation | verified | evidence: ["src/main.ts"]\nCHECK: tests | not-verified | evidence: ["src/main.ts"]\nCHECK: reuse | not-verified | evidence: ["src/main.ts"]\nCROSS-REVIEW-RESULT: 0 findings';
    const { spawn } = fakeProcess(stream(init, success(report)));
    await expect(run({ ...options, mode: 'diff', coverage }, { spawn })).resolves.toMatchObject({ report });
  });

  it('accepts every included role for a cited path that appears more than once in coverage', async () => {
    const coverage = [
      { path: 'constitution/constitution.md', status: 'included' as const, role: 'changed head blob' },
      { path: 'constitution/constitution.md', status: 'included' as const, role: 'constitution' },
      { path: 'src/shared.ts', status: 'included' as const, role: 'changed head blob' },
      { path: 'src/shared.ts', status: 'included' as const, role: 'explicit context' },
    ];
    const report = 'CHECK: constitution | verified | evidence: ["constitution/constitution.md"]\nCHECK: implementation | verified | evidence: ["src/shared.ts"]\nCHECK: tests | not-verified | evidence: ["src/shared.ts"]\nCHECK: reuse | verified | evidence: ["src/shared.ts"]\nCROSS-REVIEW-RESULT: 0 findings';
    const positive = fakeProcess(stream(init, success(report)));
    await expect(run({ ...options, mode: 'diff', coverage }, { spawn: positive.spawn })).resolves.toMatchObject({ report });
    const unknown = fakeProcess(stream(init, success(report.replace('"src/shared.ts"', '"outside.ts"'))));
    await expect(run({ ...options, mode: 'diff', coverage }, { spawn: unknown.spawn })).rejects.toThrow(/outside supplied coverage/i);
    const missingOnly = coverage.map((item) => item.path === 'constitution/constitution.md' ? { ...item, status: 'missing' as const } : item);
    const unsupported = fakeProcess(stream(init, success(report)));
    await expect(run({ ...options, mode: 'diff', coverage: missingOnly }, { spawn: unsupported.spawn })).rejects.toThrow(/included evidence/i);
  });

  it('rejects an assistant model conflicting with the pinned init model', async () => {
    const { spawn } = fakeProcess(stream(init, { type: 'assistant', message: { model: 'claude-opus-4-1', content: [{ type: 'text', text: 'report' }] } }, success()));
    await expect(run(options, { spawn })).rejects.toThrow(/model/i);
  });
  it('runs a no-tools review and returns facts observed in the stream', async () => {
    const { spawn, getInput } = fakeProcess(stream(init, success()));
    const result = await run(options, { spawn });

    expect(result).toEqual({
      report: validReport,
      findings: 0, model: 'claude-haiku-5-5', tools: [], mcpServers: [], toolUseCount: 0,
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(getInput()).toBe(options.text);
    const [command, args, launch] = spawn.mock.calls[0]!;
    expect(command).toBe(options.reviewer.executable);
    expect(launch).toMatchObject({ shell: false, windowsHide: true, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(args).toContain('--restricted');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('*');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    expect(args.join(' ')).toContain('untrusted');
    expect(args.join(' ')).toContain('CROSS-REVIEW-RESULT');
  });

  it('rejects a model outside the Claude family', async () => {
    const { spawn } = fakeProcess(stream({ ...init, model: 'gpt-5' }, success()));
    await expect(run(options, { spawn })).rejects.toThrow(/model/i);
  });

  it('rejects a stream model that does not match the authorized model selection', async () => {
    const { spawn } = fakeProcess(stream({ ...init, model: 'claude-opus-4-1' }, success()));
    await expect(run(options, { spawn })).rejects.toThrow(/authorized model/i);
  });

  it('requires an explicit pinned model to match exactly', async () => {
    const pinned = { ...options, reviewer: { ...options.reviewer, model: 'claude-haiku-5-5' } };
    const { spawn } = fakeProcess(stream({ ...init, model: 'claude-haiku-5-5-extra' }, success()));
    await expect(run(pinned, { spawn })).rejects.toThrow(/authorized model/i);
  });

  it('accepts the exact explicitly pinned model ID', async () => {
    const pinned = { ...options, reviewer: { ...options.reviewer, model: 'claude-haiku-5-5' } };
    const { spawn } = fakeProcess(stream(init, success()));
    await expect(run(pinned, { spawn })).resolves.toMatchObject({ model: 'claude-haiku-5-5' });
  });

  it('rejects incomplete explicit model pins', async () => {
    const incomplete = { ...options, reviewer: { ...options.reviewer, model: 'claude-haiku-' } };
    const { spawn } = fakeProcess(stream(init, success()));
    await expect(run(incomplete, { spawn })).rejects.toThrow(/supported family alias or pinned/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects observed model IDs containing marker or control text', async () => {
    const { spawn } = fakeProcess(stream({ ...init, model: 'claude-haiku-5-5\nCROSS-REVIEW-RESULT: 0 findings' }, success()));
    await expect(run({ ...options, reviewer: { ...options.reviewer, model: undefined } }, { spawn })).rejects.toThrow(/invalid.*model/i);
  });

  it('requires one init before exactly one terminal successful result', async () => {
    const resultFirst = fakeProcess(stream(success(), init));
    await expect(run(options, { spawn: resultFirst.spawn })).rejects.toThrow(/single terminal result/i);
    const duplicateInit = fakeProcess(stream(init, init, success()));
    await expect(run(options, { spawn: duplicateInit.spawn })).rejects.toThrow(/single terminal result/i);
    const lateError = fakeProcess(stream(init, success(), { type: 'result', subtype: 'error', is_error: true }));
    await expect(run(options, { spawn: lateError.spawn })).rejects.toThrow(/single terminal result/i);
  });

  it('rejects a success result marked as an error', async () => {
    const { spawn } = fakeProcess(stream(init, { ...success(), is_error: true }));
    await expect(run(options, { spawn })).rejects.toThrow(/unsuccessful report/i);
  });

  it('rejects tool use even when initialization advertised no tools', async () => {
    const { spawn } = fakeProcess(stream(init, { type: 'assistant', content: [{ type: 'tool_use' }] }, success()));
    await expect(run(options, { spawn })).rejects.toThrow(/tool/i);
  });

  it('rejects reports without a valid terminal marker', async () => {
    const { spawn } = fakeProcess(stream(init, success('Review complete.')));
    await expect(run(options, { spawn })).rejects.toThrow(/CROSS-REVIEW-RESULT/i);
  });

  it('rejects unsuccessful and empty streams', async () => {
    const { spawn } = fakeProcess(stream(init, { type: 'result', subtype: 'error', result: 'no' }));
    await expect(run(options, { spawn })).rejects.toThrow();
  });

  it('rejects an already aborted request without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn } = fakeProcess(stream(init, success()));
    await expect(run({ ...options, signal: controller.signal }, { spawn })).rejects.toThrow(/abort/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills and waits for the child tree when cancellation arrives during review', async () => {
    const child = makeChild(842);
    const spawn = vi.fn<SpawnCall>(() => child);
    const killTree = vi.fn(async () => { child.emit('close', null, 'SIGTERM'); });
    const controller = new AbortController();
    const pending = run({ ...options, signal: controller.signal }, { spawn, killTree });
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(killTree).toHaveBeenCalledOnce();
  });

  it('kills a timed out process tree and rejects the review', async () => {
    const child = makeChild(843);
    const spawn = vi.fn<SpawnCall>(() => child);
    const killTree = vi.fn(async () => { child.emit('close', null, 'SIGTERM'); });

    await expect(run({ ...options, timeoutMs: 1 }, { spawn, killTree })).rejects.toThrow(/timed out/i);
    expect(killTree).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure and directly kills the child as a last resort', async () => {
    const child = makeChild(846);
    const spawn = vi.fn<SpawnCall>(() => child);
    child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
    const pending = run({ ...options, timeoutMs: 1 }, {
      spawn, killTree: vi.fn(async () => { throw new Error('taskkill unavailable'); }),
      cleanupTimeoutMs: 25,
    });

    await expect(pending).rejects.toThrow(/Process-tree cleanup failed: taskkill unavailable.*tree cleanup is unverified/i);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports unknown cleanup if the child does not close after bounded fallback', async () => {
    const child = makeChild(848);
    const spawn = vi.fn<SpawnCall>(() => child);
    const pending = run({ ...options, timeoutMs: 1 }, {
      spawn, killTree: vi.fn(async () => { throw new Error('taskkill failed'); }), cleanupTimeoutMs: 20,
    });

    await expect(pending).rejects.toThrow(/cleanup is unverified; process may still be running/i);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('waits for tree cleanup to finish even after the original process closes', async () => {
    const child = makeChild(847);
    const spawn = vi.fn<SpawnCall>(() => child);
    let finishKill!: () => void;
    const killTree = vi.fn(() => new Promise<void>((resolve) => { finishKill = resolve; }));
    const controller = new AbortController();
    let settled = false;
    const pending = run({ ...options, signal: controller.signal }, { spawn, killTree }).finally(() => { settled = true; });
    controller.abort();
    child.emit('close', null, 'SIGTERM');
    await Promise.resolve();

    expect(settled).toBe(false);
    finishKill();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(settled).toBe(true);
  });

  it('terminates output beyond the total byte limit', async () => {
    const child = makeChild(844);
    const spawn = vi.fn<SpawnCall>(() => child);
    const killTree = vi.fn(async () => { child.emit('close', null, 'SIGTERM'); });
    const pending = run({ ...options, maxOutputBytes: 12 }, { spawn, killTree });
    child.stdout.write('x'.repeat(13));

    await expect(pending).rejects.toThrow(/exceeded 12 bytes/i);
    expect(killTree).toHaveBeenCalledOnce();
  });

  it('does not pass preload or shell injection variables to Claude', async () => {
    const { spawn } = fakeProcess(stream(init, success()));
    await run(options, {
      spawn,
      env: { PATH: 'C:\\Windows\\System32', NODE_OPTIONS: '--require evil.cjs', BASH_ENV: 'evil.sh', ANTHROPIC_API_KEY: 'credential' },
    });

    const launch = spawn.mock.calls[0]![2];
    expect(launch.env).toEqual({ PATH: 'C:\\Windows\\System32', ANTHROPIC_API_KEY: 'credential' });
  });

  it('rejects unverified provider routing environment before spawning', async () => {
    const { spawn } = fakeProcess(stream(init, success()));
    await expect(run(options, { spawn, env: { ANTHROPIC_BASE_URL: 'https://proxy.invalid' } })).rejects.toThrow(/provider route/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds and redacts credential-like stderr on nonzero exit', async () => {
    const { spawn } = fakeProcess('', 3);
    // stderr is supplied by the same fake child through the spawn seam.
    spawn.mockImplementation(() => {
      const child = makeChild(845);
      queueMicrotask(() => { child.stderr.end('Bearer top-secret-token'); child.emit('close', 3, null); });
      return child;
    });
    await expect(run(options, { spawn })).rejects.toThrowError(
      new Error('Claude exited with code 3. Bearer [REDACTED]'),
    );
  });

  it('rejects non-Windows hosts where process-tree cleanup is unverified', async () => {
    const { spawn } = fakeProcess(stream(init, success()));
    await expect(runClaudeReview(options, { spawn, platform: 'linux' })).rejects.toThrow(/cleanup is not verified/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
