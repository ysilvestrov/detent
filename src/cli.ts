#!/usr/bin/env node
// The `detent` command: a router over its subcommands.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crossReview, USAGE as CROSS_REVIEW_USAGE } from './commands/cross-review.js';
import { install, USAGE as INSTALL_USAGE } from './commands/install.js';
import { prReview, USAGE as PR_REVIEW_USAGE } from './commands/pr-review.js';
import { TIMEOUT_MS } from './review/cli-runner.js';

const USAGE = `Usage: npx -y @ysilvestrov/detent <command>

Commands:
  cross-review   review the branch or a spec by a reviewer of another model family
                 ${CROSS_REVIEW_USAGE.replace('Usage: ', '')}
  pr-review      review a pull request with an AI model (in GitHub Actions), or replay one locally
                 ${PR_REVIEW_USAGE.replace('Usage: ', '')}
  install        copy the skills and the constitution block into the project
                 ${INSTALL_USAGE.replace('Usage: ', '')}

Options:
  --version      print the version of detent`;

function version(): string {
  const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function main(argv: readonly string[]): number | Promise<number> {
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
  if (command === 'pr-review') {
    return prReview(rest, {
      cwd: process.cwd(),
      env: process.env,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (command === 'install') {
    return install(rest, {
      cwd: process.cwd(),
      env: process.env,
      home: homedir(),
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

process.exitCode = await main(process.argv.slice(2));
