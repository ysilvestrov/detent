// Test fixture: fake reviewer CLIs on a PATH that shows nothing else but node and git, so a
// reviewer that is not faked is "not installed" whatever the machine has. Not part of the build.
//
// The platform choice lives here, never in test bodies: on POSIX a fake is a `#!/usr/bin/env node`
// script; on win32 it is an npm-format `.cmd` shim next to a `.js`, so the tests run the runner's
// shim unwrapping exactly as a real npm-installed codex or claude would need it (probe П-Д).
//
// A fake's behaviour comes from the env the test passes to crossReview:
//   FAKE_<ID>=ok:<n>    a report ending in `CROSS-REVIEW-RESULT: <n> findings` (codex: to its -o file)
//   FAKE_<ID>=jetski    exit 0, empty stdout, agy's headless permission refusal on stderr
//   FAKE_<ID>=sleep     never finishes (for the timeout)
//   FAKE_AGY_CANARY=writes   the agy canary creates the file it is asked to (deny rule ineffective)
// Every call is appended to <logDir>/<id>.jsonl: kind, cwd, CROSS_REVIEW_ACTIVE, stdin, first prompt line.
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const IDS = ['codex', 'claude', 'agy'] as const;
type Id = (typeof IDS)[number];

const BODY = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prompt = args[args.length - 1] || '';
const canary = /^Use the write_file tool to create the file (.+) containing the word canary\. Do nothing else\.$/.exec(prompt);

let stdin;
try {
  const n = fs.readSync(0, Buffer.alloc(16));
  stdin = n === 0 && fs.fstatSync(0).isCharacterDevice() ? 'closed' : 'open';
} catch (e) {
  stdin = 'error ' + e.code;
}
fs.appendFileSync(path.join(process.env.FAKE_LOG_DIR, ID + '.jsonl'), JSON.stringify({
  kind: canary ? 'canary' : 'review',
  cwd: process.cwd(),
  active: process.env.CROSS_REVIEW_ACTIVE === undefined ? null : process.env.CROSS_REVIEW_ACTIVE,
  stdin,
  promptHead: prompt.split('\n')[0],
}) + '\n');

if (canary) {
  if (process.env.FAKE_AGY_CANARY === 'writes') fs.writeFileSync(canary[1], 'canary');
  else process.stdout.write('Permission denied for write_file. Matches user-configured deny rule.\n');
  process.exit(0);
}

const mode = process.env['FAKE_' + ID.toUpperCase()] || '';
if (mode === 'sleep') {
  setTimeout(() => {}, 600000);
} else if (mode === 'jetski') {
  process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied\n');
  process.exit(0);
} else if (mode.startsWith('ok:')) {
  const report = '1. a finding\n\nCROSS-REVIEW-RESULT: ' + mode.slice(3) + ' findings\n';
  const o = args.indexOf('-o');
  if (ID === 'codex') fs.writeFileSync(args[o + 1], report);
  else process.stdout.write(report);
  process.exit(0);
} else {
  process.stderr.write('ERROR: fake ' + ID + ' got no FAKE_' + ID.toUpperCase() + '\n');
  process.exit(1);
}
`;

// The last line of an npm shim, as npm 11 writes it (probe П-Д; node_modules/.bin/*.cmd).
function npmShim(rel: string): string {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, '',
  ].join('\r\n');
}

function realGit(): string {
  const win = process.platform === 'win32';
  const pathValue = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathValue.split(win ? ';' : ':')) {
    if (dir === '') continue;
    const candidate = join(dir, win ? 'git.exe' : 'git');
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error('fake-reviewer fixture: git is not in PATH');
}

// The directory that gives the fakes node and the command git, and nothing a real reviewer could be.
function toolDir(base: string): string {
  if (process.platform === 'win32') {
    // node is not needed in PATH: the unwrapped shim runs the node running the tests.
    const dir = dirname(realGit());
    for (const id of IDS) {
      for (const ext of ['', '.exe', '.cmd', '.bat', '.com']) {
        if (existsSync(join(dir, id + ext))) throw new Error(`fake-reviewer fixture: ${join(dir, id + ext)} would shadow the fakes`);
      }
    }
    return dir;
  }
  const dir = join(base, 'tools');
  mkdirSync(dir);
  symlinkSync(process.execPath, join(dir, 'node'));
  symlinkSync(realGit(), join(dir, 'git'));
  return dir;
}

export interface FakeReviewers {
  env: Record<string, string>; // pass to crossReview, adding FAKE_* and DETENT_AUTHOR as the test needs
  logDir: string;
}

// `base` is a fresh empty directory outside any package (an os tmpdir mkdtemp).
export function installFakeReviewers(base: string, ids: readonly Id[]): FakeReviewers {
  const bin = join(base, 'bin');
  const lib = join(base, 'lib');
  const logDir = join(base, 'calls');
  for (const d of [bin, lib, logDir]) mkdirSync(d);
  writeFileSync(join(base, 'package.json'), '{ "type": "commonjs" }\n');
  for (const id of ids) {
    const script = `const ID = ${JSON.stringify(id)};\n${BODY}`;
    if (process.platform === 'win32') {
      writeFileSync(join(lib, `${id}.js`), script);
      writeFileSync(join(bin, `${id}.cmd`), npmShim(`..\\lib\\${id}.js`));
    } else {
      writeFileSync(join(bin, id), `#!/usr/bin/env node\n${script}`);
      chmodSync(join(bin, id), 0o755);
    }
  }

  const gitConfig = join(base, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(path|cross_review_active|detent_author|git_.*|fake_.*)$/i.test(k)) continue;
    env[k] = v;
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  env.PATH = [bin, toolDir(base)].join(sep);
  env.FAKE_LOG_DIR = logDir;
  env.GIT_CONFIG_GLOBAL = gitConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { env, logDir };
}
