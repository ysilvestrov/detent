import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { assertMcpDirectory, serveMcp } from '../mcp/server.js';
import { readAdmission } from '../mcp/registration.js';
import { snapshotPackage } from '../runtime/contract.js';

export const USAGE = 'Usage: detent mcp --registration <absolute-file>';

export interface McpCommandIO {
  cwd: string;
  input: Readable;
  output: Writable;
  err: (line: string) => void;
}

export async function mcp(argv: readonly string[], io: McpCommandIO): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    io.output.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== '--registration' || !isAbsolute(argv[1] as string)) {
    io.err(`${USAGE}`);
    return 2;
  }
  const registrationPath = argv[1] as string;
  try {
    const packageRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
    const identity = snapshotPackage(packageRoot).contract;
    const admission = readAdmission(registrationPath, io.cwd, identity);
    assertMcpDirectory(admission, packageRoot, 'installed package root');
    assertMcpDirectory(admission, realpathSync(tmpdir()), 'neutral reviewer parent');
    const neutralCwd = mkdtempSync(join(tmpdir(), 'detent-mcp-'));
    await serveMcp({ registrationPath, cwd: io.cwd, identity, neutralCwd, packageRoot, input: io.input, output: io.output, err: io.err });
    return 0;
  } catch (error) {
    io.err(`mcp: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
