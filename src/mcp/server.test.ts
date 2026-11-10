import { describe, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveMcp } from './server.js';

const neutral = (): string => mkdtempSync(join(tmpdir(), 'detent-mcp-test-neutral-'));
const repo = (): string => mkdtempSync(join(tmpdir(), 'detent-mcp-test-repo-'));
async function waitForMessages(getText: () => string, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (getText().trim().split('\n').filter(Boolean).length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} MCP messages before timeout`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const admitted = (root: string, roots = [root]) => ({
  registration: { projectId: 'p', revision: 3, gitCommonDir: mkdtempSync(join(tmpdir(), 'detent-mcp-test-git-')), worktrees: roots.map((worktreeRoot) => ({ root: worktreeRoot })) },
  capability: { reviewers: [{ id: 'claude', executable: '/claude', model: 'claude-haiku-5-5' }] },
  root,
  gitExecutable: '/git',
});

describe('serveMcp', () => {
  test('cancels an active review while another call is preparing and waits for cleanup', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
    let secondPreparing!: () => void;
    const preparing = new Promise<void>((resolve) => { secondPreparing = resolve; });
    let preparations = 0;
    let cleaned = false;
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: (_root, _git, _request, options) => {
        preparations += 1;
        if (preparations === 1) return { mode: 'spec', author: 'codex', commits: { head: 'b'.repeat(40) }, coverage: [], text: 'payload', inputSha256: 'c'.repeat(64) } as never;
        secondPreparing();
        return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('preparation aborted')), { once: true }));
      },
      runClaudeReview: ({ signal }) => new Promise((_, reject) => {
        reviewStarted();
        signal?.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(new Error('review cancelled')); }, 10), { once: true });
      }),
    });
    const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const args = { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/x.md', revision: 'HEAD' };
    send({ jsonrpc: '2.0', id: 'first', method: 'tools/call', params: { name: 'cross_review', arguments: args } });
    await started;
    send({ jsonrpc: '2.0', id: 'second', method: 'tools/call', params: { name: 'cross_review', arguments: args } });
    await preparing;
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'first' } });
    await waitForMessages(() => response, 2);
    expect(cleaned).toBe(true);
    expect(response).toContain('review cancelled');
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'second' } });
    await waitForMessages(() => response, 3);
    input.end(); await done;
  });

  test('does not launch Claude after the shared deadline expires during preparation', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    let response = ''; output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    let release!: (value: unknown) => void;
    let preparing!: () => void;
    const entered = new Promise<void>((resolve) => { preparing = resolve; });
    const baseTime = Date.now(); let clock = baseTime;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let launched = 0;
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => new Promise((resolve) => { release = resolve; preparing(); }) as never,
      runClaudeReview: async () => { launched += 1; throw new Error('review should not start'); },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/x.md', revision: 'HEAD' } } })}\n`);
    await entered;
    clock = baseTime + 900_001;
    release({ mode: 'spec', author: 'codex', commits: { head: 'b'.repeat(40) }, coverage: [], text: 'payload', inputSha256: 'c'.repeat(64) });
    for (let i = 0; i < 100 && response.trim().split('\n').filter(Boolean).length < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    now.mockRestore();
    input.end(); await done;
    expect(launched).toBe(0);
    expect(JSON.parse(response.trim().split('\n')[1]!).result.structuredContent).toMatchObject({ status: 'failed', reason: expect.stringMatching(/deadline/) });
  });
  test('initializes, lists the fixed tool, and returns factual success receipts', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => ({ mode: 'spec', author: 'codex', commits: { head: 'b'.repeat(40) }, coverage: [], text: 'payload', inputSha256: 'c'.repeat(64) }) as never,
      runClaudeReview: async () => ({ report: 'Findings\nCROSS-REVIEW-RESULT: 1 finding', findings: 1, model: 'claude-haiku-5-5', tools: [], mcpServers: [], toolUseCount: 0 }),
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages[1].result.structuredContent).toMatchObject({ status: 'completed', authorDeclared: 'codex', reviewer: { id: 'claude', model: 'claude-haiku-5-5', family: 'anthropic' }, effectiveRoot: root, projectId: 'p', revision: 3 });
    const legacy = messages[1].result.content.map((item: { type: string; text: string }) => item.text);
    expect(legacy[0]).toBe('Findings\nCROSS-REVIEW-RESULT: 1 finding');
    expect(JSON.parse(legacy[1])).toMatchObject({ status: 'completed', marker: expect.stringContaining('Spec-review:'), commits: { head: 'b'.repeat(40) }, inputSha256: 'c'.repeat(64), coverage: [] });
  });

  test('allows startup with an absent offline registered worktree while preserving current admission', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const offlineSibling = resolve(root, '..', 'detent-mcp-offline-worktree');
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root, [root, offlineSibling]) as never,
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[1].result.tools[0].name).toBe('cross_review');
  });

  test('returns a framed successful code receipt and paste-ready PR marker', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => ({ mode: 'diff', author: 'agy', commits: { head: 'd'.repeat(40), base: 'b'.repeat(40), mergeBase: 'c'.repeat(40) }, coverage: [{ path: 'src/a.ts', status: 'included', role: 'changed' }], text: 'code payload', inputSha256: 'e'.repeat(64) }) as never,
      runClaudeReview: async () => ({ report: 'No findings\nCROSS-REVIEW-RESULT: 0 findings', findings: 0, model: 'claude-haiku-5-5', tools: [], mcpServers: [], toolUseCount: 0 }),
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'agy', kind: 'code', base: 'main', head: 'HEAD' } } })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[1].result.structuredContent).toMatchObject({ status: 'completed', authorDeclared: 'agy', marker: 'Cross-review: claude/claude-haiku-5-5 @ ddddddd (author: agy) — 0 findings: <f> fixed, <r> rejected', commits: { base: 'b'.repeat(40), head: 'd'.repeat(40), mergeBase: 'c'.repeat(40) }, inputSha256: 'e'.repeat(64) });
  });

  test('rereads disabled admission before preparing a review and ignores call notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    let admissions = 0;
    let prepared = 0;
    let reviews = 0;
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => {
        admissions += 1;
        if (admissions > 1) throw new Error('registration is disabled');
        return admitted(root) as never;
      },
      prepareReview: () => { prepared += 1; return {} as never; },
      runClaudeReview: async () => { reviews += 1; throw new Error('should not run'); },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages[1].result.isError).toBe(true);
    expect(messages[1].result.content[0].text).toContain('disabled');
    expect(messages[1].result.structuredContent).toEqual({ status: 'needs-action', reason: 'registration is disabled' });
    expect([admissions, prepared, reviews]).toEqual([2, 0, 0]);
  });

  test('rejects a same-family declared author before preparing or launching Claude', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    let reviews = 0;
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => { throw new Error('must refuse before preparing'); },
      runClaudeReview: async () => { reviews += 1; throw new Error('must not launch'); },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'claude', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[1].result.isError).toBe(true);
    expect(messages[1].result.structuredContent.status).toBe('failed');
    expect(messages[1].result.structuredContent).not.toHaveProperty('marker');
    expect(messages[1].result.content[0].text).toContain('another model family');
    expect(reviews).toBe(0);
  });

  test.each(['output-close', 'output-error', 'input-close'] as const)('%s aborts a running review and settles', async (disconnect) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const root = repo();
    let started!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => ({ mode: 'spec', author: 'codex', commits: { head: 'b'.repeat(40) }, coverage: [], text: 'payload', inputSha256: 'c'.repeat(64) }) as never,
      runClaudeReview: ({ signal }) => new Promise((_, reject) => {
        started();
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    await reviewStarted;
    if (disconnect === 'output-close') output.destroy();
    else if (disconnect === 'output-error') output.emit('error', new Error('output disconnected'));
    else input.destroy();
    await expect(Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('server did not settle')), 1000))])).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(input.destroyed).toBe(true);
  });

  test('requires notifications/initialized before tools and refuses repeated initialize', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, { readAdmission: () => admitted(root) as never });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })}\n`);
    await waitForMessages(() => response, 4);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[0].result.protocolVersion).toBe('2024-11-05');
    expect(messages[1].error.code).toBe(-32002);
    expect(messages[2].error.code).toBe(-32600);
    expect(messages[3].result.tools).toHaveLength(1);
  });

  test('returns parse and request errors, while unknown and call notifications stay silent', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    let launched = 0;
    const root = repo();
    output.on('data', (chunk) => { response += chunk.toString(); });
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      runClaudeReview: async () => { launched += 1; throw new Error('should not run'); },
    });
    input.write('{broken json}\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/unrecognized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'cross_review', arguments: {} } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_cross_review', arguments: {} } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/x.md', revision: 'HEAD', surprise: true } } })}\n`);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.map((message) => message.id)).toEqual([null, null, 1, 2, 3]);
    expect(messages[0].error.code).toBe(-32700);
    expect(messages[1].error.code).toBe(-32600);
    expect(messages[3].result.structuredContent).toMatchObject({ status: 'failed', reason: 'unknown tool' });
    expect(messages[4].result.structuredContent.status).toBe('failed');
    expect(launched).toBe(0);
  });

  test('handles concurrent IDs and cancellation without retrying or completing cancelled review', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const starts = new Set<string>();
    let firstReady!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstReady = resolve; });
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => { started = resolve; });
    let finishSecond!: (result: { report: string; findings: number; model: string; tools: []; mcpServers: []; toolUseCount: 0 }) => void;
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, {
      readAdmission: () => admitted(root) as never,
      prepareReview: () => ({ mode: 'spec', author: 'codex', commits: { head: 'b'.repeat(40) }, coverage: [], text: 'payload', inputSha256: 'c'.repeat(64) }) as never,
      runClaudeReview: ({ signal }) => new Promise((resolve, reject) => {
        const id = starts.size === 0 ? 'first' : 'second';
        starts.add(id);
        if (starts.size === 1) firstReady();
        if (starts.size === 2) started();
        if (id === 'second') finishSecond = resolve;
        signal?.addEventListener('abort', () => reject(new Error('review cancelled')), { once: true });
      }),
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const args = { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/x.md', revision: 'HEAD' };
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'cross_review', arguments: args } })}\n`);
    await firstStarted;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'cross_review', arguments: args } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'cross_review', arguments: args } })}\n`);
    await bothStarted;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishSecond({ report: 'CROSS-REVIEW-RESULT: 0 findings', findings: 0, model: 'claude-haiku-5-5', tools: [], mcpServers: [], toolUseCount: 0 });
    await waitForMessages(() => response, 4);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.some((message) => message.error?.message === 'Duplicate active request id')).toBe(true);
    expect(messages.find((message) => message.id === 'a' && message.result)?.result.structuredContent).toMatchObject({ status: 'failed', reason: 'review cancelled' });
    expect(messages.find((message) => message.id === 'b')?.result?.structuredContent.status).toBe('completed');
  });

  test('discards an oversized frame through its newline and parses the following frame', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd: neutral(), input, output }, { readAdmission: () => admitted(root) as never });
    input.write('x'.repeat(1024 * 1024 + 1));
    input.write('{"jsonrpc":"2.0","id":77,"method":"ping"}\n');
    input.write('{"jsonrpc":"2.0","id":78,"method":"ping"}\n');
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[0].error.code).toBe(-32600);
    expect(messages.some((message) => message.id === 77)).toBe(false);
    expect(messages.some((message) => message.id === 78)).toBe(true);
  });

  test('refuses a neutral cwd that becomes registered before a review', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const root = repo();
    const neutralCwd = neutral();
    let reads = 0;
    const done = serveMcp({ registrationPath: 'registration', cwd: root, identity: { version: '1.0.0', digest: 'a'.repeat(64) }, neutralCwd, input, output }, {
      readAdmission: () => {
        reads += 1;
        const current = admitted(root);
        if (reads > 1) current.registration.worktrees.push({ root: neutralCwd });
        return current as never;
      },
      prepareReview: () => { throw new Error('must refuse before prepare'); },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD' } } })}\n`);
    await waitForMessages(() => response, 2);
    input.end();
    await done;
    const messages = response.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages[1].result.structuredContent).toMatchObject({ status: 'needs-action' });
    expect(messages[1].result.structuredContent.reason).toContain('inside a registered worktree');
  });
});
