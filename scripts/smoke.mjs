// `npm run smoke`: packs this repository, installs the archive into a temp folder and checks the
// installed `detent` as a user would run it (spec 2026-11-02-ci-gate-design.md). The folder stays:
// recursive deletion is not used in this repository, the owner removes `detent-smoke-*` by hand.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'detent-smoke-'));
const pack = join(base, 'pack');
const consumer = join(base, 'consumer');
const home = join(base, 'home');
for (const dir of [pack, consumer, home]) mkdirSync(dir);
console.log(`smoke: working in ${base}`);

function fail(message, result) {
  console.error(`smoke: FAILED: ${message}`);
  if (result !== undefined) {
    console.error(`exit code: ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  }
  process.exit(1);
}

// `npm` and `npx` are .cmd files on Windows, which need a shell; the arguments here are fixed and
// contain no spaces. Node deprecates a shell with an argument list, hence one command line there.
function run(command, args, cwd, env = process.env) {
  const options = { cwd, env, encoding: 'utf8' };
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { ...options, shell: true })
    : spawnSync(command, args, options);
  if (result.error) fail(`${command} ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function step(command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) fail(`${command} ${args.join(' ')}`, result);
}

// The result must not depend on who runs the script or on the home of the machine: `install` reads
// ~/.claude/settings.json and the Codex plugin cache before it looks at any flag.
const detentEnv = { ...process.env, HOME: home, USERPROFILE: home };
delete detentEnv.DETENT_AUTHOR;
delete detentEnv.CROSS_REVIEW_ACTIVE;

function detent(args, { code, stdout, stderr }) {
  const name = `detent ${args.join(' ')}`;
  const result = run('npx', ['--no-install', 'detent', ...args], consumer, detentEnv);
  if (result.status !== code) fail(`${name}: expected exit code ${code}`, result);
  if (stdout !== undefined && !stdout(result.stdout)) fail(`${name}: unexpected stdout`, result);
  if (stderr !== undefined && !stderr(result.stderr)) fail(`${name}: unexpected stderr`, result);
  console.log(`smoke: ok: ${name}`);
  return result;
}

// Every file under `dir`, as `/`-separated paths relative to it.
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(join(dir, entry.name), rel) : [rel];
  });
}

const requireFile = (dir, path, what) => {
  if (!existsSync(join(dir, ...path.split('/')))) fail(`${what}: ${path} is missing`);
};

step('npm', ['pack', '--silent', '--pack-destination', pack], root);
const archive = readdirSync(pack).find((name) => name.endsWith('.tgz'));
if (archive === undefined) fail('npm pack produced no archive');

writeFileSync(join(consumer, 'package.json'), '{"private":true}\n');
// A relative path: through the shell on Windows an absolute one could contain a space.
step('npm', ['install', `../pack/${archive}`, '--no-audit', '--no-fund', '--silent'], consumer);
// `install` needs a repository, and this one is the nearest whatever the temp folder lies in.
step('git', ['init', '-q'], consumer);

const installed = join(consumer, 'node_modules', '@ysilvestrov', 'detent');
for (const dir of ['skills', 'prompts', 'constitution']) {
  for (const file of filesUnder(join(root, dir))) requireFile(installed, `${dir}/${file}`, 'the installed package');
}
console.log('smoke: ok: the package has every file of skills, prompts and constitution');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
detent(['--version'], { code: 0, stdout: (out) => out.trim() === version });
detent(['nope'], { code: 2, stderr: (err) => err.includes('unknown command') });
detent(['cross-review'], { code: 2, stderr: (err) => err.includes('--author') });

const install = ['install', '--claude', '--agents'];
detent([...install, '--dry-run'], { code: 0, stdout: (out) => out.includes('nothing written') });
if (existsSync(join(consumer, 'CLAUDE.md'))) fail('install --dry-run wrote CLAUDE.md');

detent(install, { code: 0 });
for (const path of ['CLAUDE.md', 'AGENTS.md', 'detent.json', '.detent/manifest.json']) requireFile(consumer, path, 'install');
for (const file of filesUnder(join(root, 'skills'))) {
  const [name, ...rest] = file.split('/');
  for (const target of ['.claude', '.agents']) requireFile(consumer, `${target}/skills/detent-${name}/${rest.join('/')}`, 'install');
}
console.log('smoke: ok: install wrote the blocks and every skill file');

detent(install, { code: 0, stdout: (out) => !/^(create|update)\b/m.test(out) });

console.log(`smoke: passed. Left behind, remove by hand: ${base}`);
