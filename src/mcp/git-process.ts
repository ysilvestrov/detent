import { execFile as nodeExecFile, type ChildProcess } from 'node:child_process';

interface GitExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  signal?: AbortSignal;
  timeout?: number;
}
type Callback = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
type Launch = (command: string, args: string[], options: GitExecOptions & { encoding: 'buffer'; shell: false; windowsHide: true }, callback: Callback) => ChildProcess;
const launchDefault = nodeExecFile as unknown as Launch;
const CLOSE_WAIT_MS = 5_000;

/** Git has no allowed transport or helper; wait for its direct child to close after abort. */
export function execGitFile(command: string, args: string[], options: GitExecOptions, launch: Launch = launchDefault): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let callbackResult: { error: Error | null; stdout: Buffer } | undefined;
    let closed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (error?: Error, stdout?: Buffer) => {
      if (settled) return;
      settled = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve(stdout ?? Buffer.alloc(0));
    };
    const finish = () => {
      if (!closed || !callbackResult) return;
      settle(callbackResult.error ?? undefined, callbackResult.stdout);
    };
    try {
      child = launch(command, args, { ...options, encoding: 'buffer', shell: false, windowsHide: true }, (error, stdout) => {
        callbackResult = { error, stdout };
        if (error && !closed) {
          closeTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* uncertainty is reported below */ }
            forceTimer = setTimeout(() => settle(new Error(`Git subprocess cleanup is unverified after ${error.message}`)), CLOSE_WAIT_MS);
          }, CLOSE_WAIT_MS);
        }
        finish();
      });
      child.once('close', () => { closed = true; finish(); });
    } catch (error) {
      settle(error instanceof Error ? error : new Error('Could not start Git subprocess'));
    }
  });
}
