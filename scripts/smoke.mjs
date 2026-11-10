// `npm run smoke`: packs this repository, installs the archive into a temp folder and checks the
// installed `detent` as a user would run it (spec 2026-11-02-ci-gate-design.md). The folder stays:
// recursive deletion is not used in this repository, the owner removes `detent-smoke-*` by hand.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotPackage } from '../dist/runtime/contract.js';

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

// `npm` and the `detent` shim are .cmd files on Windows, which need a shell. Node deprecates a shell
// with an argument list, hence one command line there. A temp path can hold spaces or `&`.
function run(command, args, cwd, env = process.env, input = undefined) {
  const options = { cwd, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) };
  const quote = (arg) => (/^[\w./:\\=-]+$/.test(arg) ? arg : `"${arg}"`);
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].map(quote).join(' '), { ...options, shell: true })
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
// `pr-review` reads the event of a CI run; a smoke run in Actions must not look like one.
for (const name of ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN']) delete detentEnv[name];
// No provider key: `--replay` then stops at the key check, after the settings (and the prompts) are loaded.
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete detentEnv[name];

// The local shim itself: `npx` would fall back to a global detent if the package lost its `bin`.
const shim = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'detent.cmd' : 'detent');

function detent(args, { code, stdout, stderr, cwd = consumer, input }) {
  const name = `detent ${args.join(' ')}`;
  const result = run(shim, args, cwd, detentEnv, input);
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
step('npm', ['install', `../pack/${archive}`, '--no-audit', '--no-fund', '--silent'], consumer);
// `install` needs a repository, and this one is the nearest whatever the temp folder lies in.
step('git', ['init', '-q'], consumer);

const installed = join(consumer, 'node_modules', '@ysilvestrov', 'detent');
for (const dir of ['skills', 'prompts', 'constitution']) {
  for (const file of filesUnder(join(root, dir))) requireFile(installed, `${dir}/${file}`, 'the installed package');
}
requireFile(installed, 'dist/pr-review/index.d.ts', 'the installed package');
console.log('smoke: ok: the package has every file of skills, prompts and constitution');
// The Action comes from git and the code from npm: the archive does not carry action.yml.
requireFile(root, 'action.yml', 'the repository');
if (existsSync(join(installed, 'action.yml'))) fail('the installed package has action.yml');
console.log('smoke: ok: action.yml is in the repository and not in the package');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
detent(['--version'], { code: 0, stdout: (out) => out.trim() === version });
detent(['--help'], { code: 0, stdout: (out) => out.includes('mcp') });
detent([], { code: 2, stderr: (err) => err.includes('Usage:') });
for (const command of ['cross-review', 'pr-review', 'install']) detent([command, '--help'], { code: 0 });
detent(['mcp', '--help'], { code: 0, stdout: (out) => out.includes('detent mcp --registration') });
detent(['mcp', '--registration', join(base, 'missing-registration.json')], { code: 1, stderr: (err) => err.includes('ENOENT') || err.toLowerCase().includes('no such file or directory') });
const mcpRepo = join(base, 'mcp-repo');
mkdirSync(mcpRepo);
step('git', ['init', '-q', '-b', 'main'], mcpRepo);
step('git', ['config', 'user.name', 'Detent smoke'], mcpRepo);
step('git', ['config', 'user.email', 'smoke@example.invalid'], mcpRepo);
writeFileSync(join(mcpRepo, 'readme.txt'), 'MCP fixture\n');
step('git', ['add', '.'], mcpRepo);
step('git', ['commit', '-q', '-m', 'fixture'], mcpRepo);
const identity = snapshotPackage(installed).contract;
const gitExecPath = run('git', ['--exec-path'], mcpRepo).stdout.trim();
const mcpRegistration = join(base, 'mcp-registration.json');
writeFileSync(mcpRegistration, JSON.stringify({
  schemaVersion: 1,
  projectId: 'smoke-fixture',
  revision: 1,
  enabled: true,
  mainRoot: realpathSync(mcpRepo),
  gitCommonDir: realpathSync(join(mcpRepo, '.git')),
  gitExecutable: realpathSync(join(gitExecPath, process.platform === 'win32' ? 'git.exe' : 'git')),
  capabilities: [{ version: identity.version, digest: identity.digest, reviewers: [{ id: 'claude', executable: realpathSync(process.execPath), model: 'claude-haiku-5-5' }] }],
  worktrees: [{ root: realpathSync(mcpRepo), configPath: join(realpathSync(mcpRepo), '.codex', 'config.toml'), version: identity.version, digest: identity.digest, state: 'active' }],
}));
const mcpInput = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'ping' },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/design.md', revision: 'HEAD', unexpected: true } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cross_review', arguments: { author: 'claude', kind: 'spec', path: 'docs/specs/2026-11/design.md', revision: 'HEAD' } } },
].map((message) => JSON.stringify(message)).join('\n') + '\n';
const mcpResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(installed, 'dist', 'cli.js'), 'mcp', '--registration', mcpRegistration], {
    cwd: mcpRepo, env: detentEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = { status: null, stdout: '', stderr: '' };
  const timer = setTimeout(() => { child.kill(); fail('MCP smoke timed out', result); }, 15_000);
  child.stdout.on('data', (chunk) => {
    result.stdout += chunk.toString();
    if ((result.stdout.match(/\n/g) ?? []).length >= 5 && !child.stdin.writableEnded) child.stdin.end();
  });
  child.stderr.on('data', (chunk) => { result.stderr += chunk.toString(); });
  child.on('error', (error) => fail(`MCP smoke failed to start: ${error.message}`, result));
  child.on('close', (code) => { clearTimeout(timer); result.status = code; resolve(result); });
  child.stdin.write(mcpInput);
});
if (mcpResult.status !== 0 || (mcpResult.stdout.match(/\n/g) ?? []).length !== 5 || !((out) => {
  const messages = out.trim().split('\n').map((line) => JSON.parse(line));
  return messages[0].result.protocolVersion === '2024-11-05'
    && messages[1].result.tools[0].name === 'cross_review'
    && messages[2].result !== undefined
    && messages[3].result.isError === true
    && messages[3].result.structuredContent.status === 'failed'
    && messages[4].result.isError === true
    && messages[4].result.structuredContent.status === 'failed';
})(mcpResult.stdout) || mcpResult.stderr !== '') fail('MCP smoke returned unexpected responses', mcpResult);
console.log('smoke: ok: detent mcp --registration');
if (mcpResult.stdout.includes('CROSS-REVIEW-RESULT')) fail('MCP smoke unexpectedly ran a paid review', mcpResult);
const unregisteredRepo = join(base, 'unregistered-repo');
mkdirSync(unregisteredRepo);
step('git', ['init', '-q', '-b', 'main'], unregisteredRepo);
detent(['mcp', '--registration', mcpRegistration], { code: 1, cwd: unregisteredRepo, stderr: (err) => err.includes('active registered worktree') });
detent(['nope'], { code: 2, stderr: (err) => err.includes('unknown command') });
detent(['cross-review'], { code: 2, stderr: (err) => err.includes('--author') });
detent(['pr-review'], { code: 2, stderr: (err) => err.includes('pull_request') });
// loadSettings runs before the key check and reads the shipped prompts of the installed package; no network.
detent(['pr-review', '--replay', '1'], { code: 2, stderr: (err) => err.includes('is not set') });

// The `exports` of the package: the subpath that warsaw-beer-bot imports resolves from a consumer folder.
writeFileSync(join(consumer, 'exports-check.mjs'), "const m = await import('@ysilvestrov/detent/pr-review');\nconsole.log(typeof m.verifyAll);\n");
const exportsCheck = run(process.execPath, ['exports-check.mjs'], consumer, detentEnv);
if (exportsCheck.status !== 0 || exportsCheck.stdout.trim() !== 'function') fail("import('@ysilvestrov/detent/pr-review') does not give verifyAll as a function", exportsCheck);
console.log('smoke: ok: @ysilvestrov/detent/pr-review exports verifyAll');

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
