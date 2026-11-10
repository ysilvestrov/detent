import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { execGitFile } from './git-process.js';

describe('execGitFile cleanup', () => {
  test('keeps an aborted Git operation pending until the child closes', async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    let callback!: (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
    const pending = execGitFile('C:\\Git\\git.exe', ['rev-parse', 'HEAD'], {
      cwd: 'C:\\repo', env: {}, maxBuffer: 1024, signal: controller.signal,
    }, (_command, _args, options, done) => {
      callback = done;
      options.signal?.addEventListener('abort', () => done(new Error('aborted'), Buffer.alloc(0), Buffer.alloc(0)), { once: true });
      return child;
    });
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    controller.abort();
    await Promise.resolve();
    expect(callback).toBeDefined();
    expect(settled).toBe(false);
    child.emit('close', null);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(settled).toBe(true);
  });
});
