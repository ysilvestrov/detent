#!/usr/bin/env node
// The `detent` command: a router over its subcommands.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crossReview, USAGE as CROSS_REVIEW_USAGE } from './commands/cross-review.js';
import { TIMEOUT_MS } from './review/cli-runner.js';

const USAGE = `Usage: detent <command>

Commands:
  cross-review   review the branch or a spec by a reviewer of another model family
                 ${CROSS_REVIEW_USAGE.replace('Usage: ', '')}

Options:
  --version      print the version of detent`;

function version(): string {
  const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === 'cross-review') {
    return crossReview(rest, {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: TIMEOUT_MS,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (command === '--version' && rest.length === 0) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  process.stderr.write(`${command === undefined || command === '--help' ? '' : `detent: unknown command "${command}"\n`}${USAGE}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
