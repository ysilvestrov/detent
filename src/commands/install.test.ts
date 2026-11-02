// End to end: install in a fresh git repository, with a fresh `home`. The expected skill texts
// are the package's own files in skills/ and constitution/ (the source being copied).
// Leftover temp directories are not removed: recursive deletion is not used in this repository.
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './install.js';

const E2E_TIMEOUT = 60_000;

const BEGIN = '<!-- detent:constitution v1 begin — edit outside these markers; `npx -y @ysilvestrov/detent install` rewrites this block -->';
const END = '<!-- detent:constitution end -->';
const DEV = 'Without Superpowers, start any behaviour change with `detent-dev-cycle`';
const CLAUDE_AUTHOR = 'You are Claude: pass --author claude.';
const AGENTS_AUTHOR =
  'You are Codex or Antigravity: pass --author codex in Codex and --author agy in Antigravity on a Gemini model; if Antigravity runs you on a Claude model, pass --author claude, because the rule is about the model family that wrote the work.';

const SKILL_FILES = ['cross-review/SKILL.md', 'design-spec/SKILL.md', 'design-spec/spec-format.md', 'dev-cycle/SKILL.md', 'pr-slicing/SKILL.md'];
const CLAUDE_SKILLS = SKILL_FILES.map((f) => `.claude/skills/detent-${f}`);
const AGENTS_SKILLS = SKILL_FILES.map((f) => `.agents/skills/detent-${f}`);

const DETENT_JSON = `{
  "language": "uk",
  "specFile": "spec.md",
  "specsDir": "docs/specs",
  "plansDir": "docs/plans",
  "gate": "npm test && npm run typecheck",
  "baseBranch": "origin/main",
  "tmpDir": "tmp",
  "reviewers": [
    "codex",
    "claude",
    "agy"
  ],
  "models": {
    "codex": "gpt-6.1-sol",
    "agy": "gemini-4-argon"
  }
}
`;

const packageFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const VERSION = (JSON.parse(packageFile('package.json')) as { version: string }).version;
const CONSTITUTION = packageFile('constitution/constitution.md').replace(/\s+$/, '');
const INNER_DEV = `${CONSTITUTION}\n\n${DEV}\n`;
const INNER_NO_DEV = `${CONSTITUTION}\n`;
const BLOCK_DEV = `${BEGIN}\n${INNER_DEV}${END}\n`;
const BLOCK_NO_DEV = `${BEGIN}\n${INNER_NO_DEV}${END}\n`;

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'detent-install-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const plain = join(base, 'plain'); // not a git repository
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(plain);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: base } as Record<string, string>;
  const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);

  let out: string[] = [];
  let err: string[] = [];
  const run = (argv: string[], cwd = repo) => {
    out = [];
    err = [];
    return install(argv, { cwd, env, home, out: (l) => out.push(l), err: (l) => err.push(l) });
  };
  const put = (dir: string, path: string, text: string) => {
    const file = join(dir, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const read = (path: string) => readFileSync(join(repo, ...path.split('/')), 'utf8');
  // Every file of the repository outside .git, sorted.
  const tree = (dir = repo, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true })
    .filter((e) => !(prefix === '' && e.name === '.git'))
    .flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
  // Path → bytes (base64) of every file outside .git.
  const snapshot = () => Object.fromEntries(tree().map((p) => [p, readFileSync(join(repo, ...p.split('/'))).toString('base64')]));
  return {
    repo, home, plain, run, read, tree, snapshot,
    putRepo: (path: string, text: string) => put(repo, path, text),
    putHome: (path: string, text: string) => put(home, path, text),
    out: () => out,
    err: () => err,
  };
}

const FULL_TREE = [...AGENTS_SKILLS, ...CLAUDE_SKILLS, '.detent/manifest.json', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'detent.json'];
const PLAN_ORDER = [...CLAUDE_SKILLS, ...AGENTS_SKILLS, 'CLAUDE.md', 'AGENTS.md', 'detent.json', '.gitignore', '.detent/manifest.json'];
const NO_SUPERPOWERS = [
  'claude: Superpowers not found; detent-dev-cycle line in CLAUDE.md: yes',
  'agents: Superpowers not found; detent-dev-cycle line in AGENTS.md: yes',
];

describe('install: first install', () => {
  test('both targets: the file tree, the copied skills, both blocks, detent.json, .gitignore and the output', () => {
    const s = setup();
    expect(s.run([])).toBe(0);
    expect(s.err()).toEqual([]);
    expect(s.tree()).toEqual(FULL_TREE);
    expect(s.out()).toEqual([...PLAN_ORDER.map((p) => `create    ${p}`), ...NO_SUPERPOWERS]);

    expect(CLAUDE_SKILLS.map((p) => s.read(p))).toEqual(SKILL_FILES.map((f) => packageFile(`skills/${f}`)));
    expect(AGENTS_SKILLS.slice(1).map((p) => s.read(p))).toEqual(SKILL_FILES.slice(1).map((f) => packageFile(`skills/${f}`)));
    expect(s.read('.claude/skills/detent-cross-review/SKILL.md')).toContain(`<!-- detent:author begin -->\n${CLAUDE_AUTHOR}\n<!-- detent:author end -->`);
    expect(s.read('.agents/skills/detent-cross-review/SKILL.md')).toBe(packageFile('skills/cross-review/SKILL.md').replace(CLAUDE_AUTHOR, AGENTS_AUTHOR));

    expect(s.read('CLAUDE.md')).toBe(BLOCK_DEV);
    expect(s.read('AGENTS.md')).toBe(BLOCK_DEV);
    expect(s.read('detent.json')).toBe(DETENT_JSON);
    expect(s.read('.gitignore')).toBe('tmp\n');
  }, E2E_TIMEOUT);

  test('the manifest: the version, a hash of every written skill file, and of each block\'s inner text', () => {
    const s = setup();
    expect(s.run([])).toBe(0);
    const manifest = JSON.parse(s.read('.detent/manifest.json')) as { detentVersion: string; files: Record<string, unknown>; blocks: Record<string, unknown> };
    expect(manifest.detentVersion).toBe(VERSION);
    expect(Object.keys(manifest.files)).toEqual([...AGENTS_SKILLS, ...CLAUDE_SKILLS]);
    expect(Object.values(manifest.files)).toEqual([...AGENTS_SKILLS, ...CLAUDE_SKILLS].map((p) => ({ sha256: sha(s.read(p)), version: VERSION })));
    expect(manifest.blocks).toEqual({
      'AGENTS.md': { sha256: sha(INNER_DEV), version: VERSION },
      'CLAUDE.md': { sha256: sha(INNER_DEV), version: VERSION },
    });
  }, E2E_TIMEOUT);

  test('--claude: only .claude/ and CLAUDE.md, plus detent.json, .gitignore and the manifest', () => {
    const s = setup();
    expect(s.run(['--claude'])).toBe(0);
    expect(s.tree()).toEqual([...CLAUDE_SKILLS, '.detent/manifest.json', '.gitignore', 'CLAUDE.md', 'detent.json']);
    expect(s.out()).toEqual([
      ...[...CLAUDE_SKILLS, 'CLAUDE.md', 'detent.json', '.gitignore', '.detent/manifest.json'].map((p) => `create    ${p}`),
      NO_SUPERPOWERS[0],
    ]);
    const manifest = JSON.parse(s.read('.detent/manifest.json')) as { files: Record<string, unknown>; blocks: Record<string, unknown> };
    expect(Object.keys(manifest.files)).toEqual(CLAUDE_SKILLS);
    expect(Object.keys(manifest.blocks)).toEqual(['CLAUDE.md']);
  }, E2E_TIMEOUT);

  test('--dry-run prints the exact list and writes nothing', () => {
    const s = setup();
    expect(s.run(['--claude', '--dry-run'])).toBe(0);
    expect(s.tree()).toEqual([]);
    expect(s.out()).toEqual([
      ...[...CLAUDE_SKILLS, 'CLAUDE.md', 'detent.json', '.gitignore', '.detent/manifest.json'].map((p) => `dry-run: create    ${p}`),
      `dry-run: ${NO_SUPERPOWERS[0]}`,
      'dry-run: nothing written',
    ]);
    expect(s.err()).toEqual([]);
  }, E2E_TIMEOUT);
});

describe('install: again', () => {
  test('a second install changes no byte and reports everything unchanged', () => {
    const s = setup();
    expect(s.run([])).toBe(0);
    const before = s.snapshot();
    expect(s.run([])).toBe(0);
    expect(s.snapshot()).toEqual(before);
    expect(s.out()).toEqual([...PLAN_ORDER.map((p) => `unchanged ${p}`), ...NO_SUPERPOWERS]);
  }, E2E_TIMEOUT);

  test('a block the previous version wrote (old marker, old command, its manifest record): rewritten, the text outside stays', () => {
    const s = setup();
    const head = '# Acme\n\nOur own rules.\n';
    const tail = '\n## After the block\nStill ours.\n';
    s.putRepo('CLAUDE.md', head);
    expect(s.run(['--claude'])).toBe(0);
    // What the previous version wrote: the old command in the marker and in the constitution text,
    // and the manifest record, a hash of that inner text.
    const OLD = (text: string) => text.replaceAll('npx -y @ysilvestrov/detent', 'npx detent');
    const oldInner = OLD(INNER_DEV);
    expect(oldInner).not.toBe(INNER_DEV);
    s.putRepo('CLAUDE.md', `${head}\n${OLD(BEGIN)}\n${oldInner}${END}\n${tail}`);
    const manifest = JSON.parse(s.read('.detent/manifest.json')) as { blocks: Record<string, { sha256: string; version: string }> };
    manifest.blocks['CLAUDE.md'] = { sha256: sha(oldInner), version: '0.2.0' };
    s.putRepo('.detent/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    expect(s.run(['--claude'])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(`${head}\n${BLOCK_DEV}${tail}`);
    expect(s.out()).toContain('update    CLAUDE.md');
  }, E2E_TIMEOUT);

  test('a skill edited by hand: exit 4, the list, and every file byte-identical (an outdated .gitignore not appended)', () => {
    const s = setup();
    expect(s.run([])).toBe(0);
    s.putRepo('.claude/skills/detent-design-spec/SKILL.md', 'my own version\n');
    s.putRepo('.gitignore', 'node_modules/\n');
    const before = s.snapshot();
    expect(s.run([])).toBe(4);
    expect(s.snapshot()).toEqual(before);
    expect(s.read('.gitignore')).toBe('node_modules/\n');
    expect(s.out()).toEqual([]);
    expect(s.err()).toEqual([
      'install: conflict: .claude/skills/detent-design-spec/SKILL.md: changed since detent wrote it (sha256 differs from the manifest)',
      'install: nothing written; restore this file by hand or move the change outside the markers, then run install again',
    ]);
  }, E2E_TIMEOUT);

  test('conflicts with no manifest: nothing written at all, not even detent.json, .gitignore or the manifest', () => {
    const s = setup();
    s.putRepo('.agents/skills/detent-pr-slicing/SKILL.md', 'copied by hand, edited\n');
    s.putRepo('CLAUDE.md', `# Acme\n\n${BEGIN}\nhalf a block\n`);
    const before = s.snapshot();
    expect(s.run([])).toBe(4);
    expect(s.snapshot()).toEqual(before);
    expect(s.tree()).toEqual(['.agents/skills/detent-pr-slicing/SKILL.md', 'CLAUDE.md']);
    expect(s.err()).toEqual([
      'install: conflict: .agents/skills/detent-pr-slicing/SKILL.md: differs from what detent would write and has no manifest record',
      'install: conflict: CLAUDE.md: broken constitution markers: a begin marker without an end marker',
      'install: nothing written; restore these files by hand or move the change outside the markers, then run install again',
    ]);
  }, E2E_TIMEOUT);

  test('CLAUDE.md: the text outside the markers stays byte for byte, on append and on replace', () => {
    const s = setup();
    const head = '# Acme\r\n\r\nOur own rules.\r\n';
    s.putRepo('CLAUDE.md', head);
    expect(s.run(['--claude'])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(`${head}\n${BLOCK_DEV}`);

    const tail = '\r\n## After the block\r\nStill ours.\r\n';
    s.putRepo('CLAUDE.md', `${s.read('CLAUDE.md')}${tail}`);
    expect(s.run(['--claude', '--superpowers', 'yes'])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(`${head}\n${BLOCK_NO_DEV}${tail}`);
    expect(s.out()).toContain('update    CLAUDE.md');
    expect(s.out()).toContain('claude: Superpowers not found, overridden by --superpowers yes; detent-dev-cycle line in CLAUDE.md: no');
  }, E2E_TIMEOUT);

  test('a skill the manifest records and the package no longer ships: kept, and named as stale', () => {
    const s = setup();
    expect(s.run(['--claude'])).toBe(0);
    s.putRepo('.claude/skills/detent-old/SKILL.md', 'old\n');
    const manifest = JSON.parse(s.read('.detent/manifest.json')) as { files: Record<string, unknown> };
    manifest.files['.claude/skills/detent-old/SKILL.md'] = { sha256: sha('old\n'), version: '0.0.9' };
    s.putRepo('.detent/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    expect(s.run(['--claude'])).toBe(0);
    expect(s.read('.claude/skills/detent-old/SKILL.md')).toBe('old\n');
    expect(s.out()).toEqual([
      ...[...CLAUDE_SKILLS, 'CLAUDE.md', 'detent.json', '.gitignore'].map((p) => `unchanged ${p}`),
      'update    .detent/manifest.json',
      NO_SUPERPOWERS[0],
      'note: .claude/skills/detent-old/SKILL.md: stale, delete with a script if not needed',
    ]);
  }, E2E_TIMEOUT);
});

describe('install: Superpowers, per target', () => {
  test('enabled for Claude in ~/.claude/settings.json: no dev-cycle line in CLAUDE.md only', () => {
    const s = setup();
    s.putHome('.claude/settings.json', '{ "enabledPlugins": { "superpowers@claude-plugins-official": true } }\n');
    expect(s.run([])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(BLOCK_NO_DEV);
    expect(s.read('AGENTS.md')).toBe(BLOCK_DEV);
    expect(s.out().slice(-2)).toEqual([
      'claude: Superpowers found (~/.claude/settings.json: enabledPlugins["superpowers@claude-plugins-official"]); detent-dev-cycle line in CLAUDE.md: no',
      'agents: Superpowers not found; detent-dev-cycle line in AGENTS.md: yes',
    ]);
  }, E2E_TIMEOUT);

  test('in the Codex plugin cache: no dev-cycle line in AGENTS.md only', () => {
    const s = setup();
    mkdirSync(join(s.home, '.codex', 'plugins', 'cache', 'x', 'superpowers', '7.0.1'), { recursive: true });
    expect(s.run([])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(BLOCK_DEV);
    expect(s.read('AGENTS.md')).toBe(BLOCK_NO_DEV);
    expect(s.out().slice(-2)).toEqual([
      'claude: Superpowers not found; detent-dev-cycle line in CLAUDE.md: yes',
      'agents: Superpowers found (~/.codex/plugins/cache/x/superpowers/); detent-dev-cycle line in AGENTS.md: no',
    ]);
  }, E2E_TIMEOUT);

  test('--superpowers no overrides a finding', () => {
    const s = setup();
    s.putHome('.claude/settings.json', '{ "enabledPlugins": { "superpowers@m": true } }\n');
    expect(s.run(['--claude', '--superpowers', 'no'])).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(BLOCK_DEV);
    expect(s.out().at(-1)).toBe('claude: Superpowers found (~/.claude/settings.json: enabledPlugins["superpowers@m"]), overridden by --superpowers no; detent-dev-cycle line in CLAUDE.md: yes');
  }, E2E_TIMEOUT);
});

describe('install: the detent plugin enabled in the project', () => {
  const WARNING = 'install: warning: the detent plugin is enabled in .claude/settings.json; with the skills copied into .claude/skills/ as well, Claude sees each skill twice (detent:design-spec and detent-design-spec)';

  test('a Claude install warns about duplicates and still installs', () => {
    const s = setup();
    s.putRepo('.claude/settings.json', '{ "enabledPlugins": { "detent@x": true } }\n');
    expect(s.run(['--claude'])).toBe(0);
    expect(s.err()).toEqual([WARNING]);
    expect(s.read('CLAUDE.md')).toBe(BLOCK_DEV);
  }, E2E_TIMEOUT);

  test('an --agents install copies nothing into .claude/ and does not warn', () => {
    const s = setup();
    s.putRepo('.claude/settings.json', '{ "enabledPlugins": { "detent@x": true } }\n');
    expect(s.run(['--agents'])).toBe(0);
    expect(s.err()).toEqual([]);
    expect(s.tree()).toEqual([...AGENTS_SKILLS, '.claude/settings.json', '.detent/manifest.json', '.gitignore', 'AGENTS.md', 'detent.json']);
  }, E2E_TIMEOUT);
});

// Links are made with what Windows allows without admin rights: a hard link for a file, a
// junction for a directory (the type is ignored on POSIX, where it is a plain symlink).
describe('install: target paths that are one thing on disk', () => {
  test('CLAUDE.md hard-linked to AGENTS.md: exit 2, nothing written', () => {
    const s = setup();
    s.putRepo('AGENTS.md', '# shared\n');
    linkSync(join(s.repo, 'AGENTS.md'), join(s.repo, 'CLAUDE.md'));
    const before = s.snapshot();
    expect(s.run([])).toBe(2);
    expect(s.err()).toEqual(['install: CLAUDE.md and AGENTS.md are the same on disk (a link); install one target: --claude or --agents']);
    expect(s.snapshot()).toEqual(before);
  }, E2E_TIMEOUT);

  test('.claude/skills linked to .agents/skills: exit 2, nothing written', () => {
    const s = setup();
    s.putRepo('.agents/skills/mine/SKILL.md', 'mine\n');
    mkdirSync(join(s.repo, '.claude'));
    symlinkSync(join(s.repo, '.agents', 'skills'), join(s.repo, '.claude', 'skills'), 'junction');
    expect(s.run([])).toBe(2);
    expect(s.err()).toEqual(['install: .claude/skills and .agents/skills are the same on disk (a link); install one target: --claude or --agents']);
    expect(s.tree()).toEqual(['.agents/skills/mine/SKILL.md', '.claude/skills']); // tree() lists a link, it does not follow it
  }, E2E_TIMEOUT);

  test('one target alone is not checked for aliases: the link is that target\'s own business', () => {
    const s = setup();
    s.putRepo('AGENTS.md', '# shared\n');
    linkSync(join(s.repo, 'AGENTS.md'), join(s.repo, 'CLAUDE.md'));
    expect(s.run(['--claude'])).toBe(0);
    expect(s.read('AGENTS.md')).toBe(s.read('CLAUDE.md'));
  }, E2E_TIMEOUT);
});

describe('install: a Superpowers skill linked into .agents/skills', () => {
  test('a linked using-superpowers directory counts as found', () => {
    const s = setup();
    s.putHome('superpowers/skills/using-superpowers/SKILL.md', 'sp\n');
    mkdirSync(join(s.repo, '.agents', 'skills'), { recursive: true });
    symlinkSync(join(s.home, 'superpowers', 'skills', 'using-superpowers'), join(s.repo, '.agents', 'skills', 'using-superpowers'), 'junction');
    expect(s.run(['--agents', '--dry-run'])).toBe(0);
    expect(s.out()).toContain('dry-run: agents: Superpowers found (.agents/skills/using-superpowers/); detent-dev-cycle line in AGENTS.md: no');
  }, E2E_TIMEOUT);
});

describe('install: errors (exit 2, nothing written)', () => {
  test('not inside a git repository', () => {
    const s = setup();
    expect(s.run([], s.plain)).toBe(2);
    expect(s.err()).toEqual(['install: not inside a git repository (git rev-parse --show-toplevel: fatal: not a git repository (or any of the parent directories): .git)']);
    expect(readdirSync(s.plain)).toEqual([]);
  }, E2E_TIMEOUT);

  test('a broken manifest', () => {
    const s = setup();
    s.putRepo('.detent/manifest.json', '{ "detentVersion": 1 }\n');
    expect(s.run([])).toBe(2);
    expect(s.err()).toEqual(['install: .detent/manifest.json: "detentVersion" must be a string']);
    expect(s.tree()).toEqual(['.detent/manifest.json']);
  }, E2E_TIMEOUT);

  test('a bad argument', () => {
    const s = setup();
    expect(s.run(['--superpowers', 'maybe'])).toBe(2);
    expect(s.err()).toEqual(['install: unknown --superpowers value "maybe" (expected yes|no)\nUsage: detent install [--claude] [--agents] [--dry-run] [--superpowers yes|no]']);
    expect(s.tree()).toEqual([]);
  }, E2E_TIMEOUT);
});
