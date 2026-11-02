import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PATTERNS, baseReader, loadSettings } from './settings.js';

const DEFAULT_FIND = 'find {{reviewContext}}';
const DEFAULT_VERIFY = 'verify {{reviewContext}}';
const readDefault = (name: string): string => (name === 'pr-review-find.md' ? DEFAULT_FIND : DEFAULT_VERIFY);

function files(map: Record<string, string>): (path: string) => string | null {
  return (path) => map[path] ?? null;
}

describe('loadSettings', () => {
  it('uses the defaults when the project has no files', () => {
    const s = loadSettings(files({}), readDefault);
    expect(s.patterns).toEqual(DEFAULT_PATTERNS);
    expect(s.findPrompt).toBe('find none stated');
    expect(s.verifyPrompt).toBe('verify none stated');
    expect(s.configured).toEqual({});
    expect(s.scope).toMatch(/^[0-9a-f]{16}$/);
  });

  it('pins the default patterns', () => {
    expect(DEFAULT_PATTERNS).toEqual({
      include: ['**'],
      ignore: ['**/*.md', 'docs/**', 'package-lock.json'],
      bodyExclude: ['**/*.test.*', 'tests/**'],
      bodyInclude: [],
    });
  });

  it('replaces a default list with the configured one, list by list', () => {
    const s = loadSettings(files({ 'detent.json': JSON.stringify({ prReview: { include: ['src/**'], bodyInclude: ['tests/keep.ts'] } }) }), readDefault);
    expect(s.patterns).toEqual({ ...DEFAULT_PATTERNS, include: ['src/**'], bodyInclude: ['tests/keep.ts'] });
    expect(s.configured).toEqual({ include: ['src/**'], bodyInclude: ['tests/keep.ts'] });
  });

  it('takes a project prompt over the one in the package', () => {
    const s = loadSettings(files({ '.detent/prompts/pr-review-find.md': 'mine {{reviewContext}}' }), readDefault);
    expect(s.findPrompt).toBe('mine none stated');
    expect(s.verifyPrompt).toBe('verify none stated');
  });

  it('asks the package for the prompt only when the project has none', () => {
    const asked: string[] = [];
    loadSettings(files({ '.detent/prompts/pr-review-find.md': 'mine' }), (name) => {
      asked.push(name);
      return 'shipped';
    });
    expect(asked).toEqual(['pr-review-verify.md']);
  });

  it('fills the review context into both prompts', () => {
    const s = loadSettings(files({ 'detent.json': JSON.stringify({ reviewContext: 'a bot, not a website' }) }), readDefault);
    expect(s.findPrompt).toBe('find a bot, not a website');
    expect(s.verifyPrompt).toBe('verify a bot, not a website');
  });

  it('refuses a broken detent.json and an unknown key in prReview', () => {
    expect(() => loadSettings(files({ 'detent.json': '{oops' }), readDefault)).toThrow(ConfigError);
    expect(() => loadSettings(files({ 'detent.json': '{"prReview":{"nope":1}}' }), readDefault)).toThrow(/nope/);
  });

  it('refuses a placeholder it does not know, naming the file', () => {
    const read = files({ '.detent/prompts/pr-review-verify.md': 'x {{nope}}' });
    expect(() => loadSettings(read, readDefault)).toThrow(ConfigError);
    expect(() => loadSettings(read, readDefault)).toThrow(/pr-review-verify\.md.*nope/);
  });

  it('refuses an unknown placeholder in the default prompt as well', () => {
    expect(() => loadSettings(files({}), () => '{{nope}}')).toThrow(ConfigError);
  });

  describe('scope', () => {
    const base = { 'detent.json': JSON.stringify({ reviewContext: 'ctx', prReview: { include: ['src/**'] } }) };
    const scopeOf = (map: Record<string, string>) => loadSettings(files(map), readDefault).scope;

    it('is the first 16 hex of the sha256 of the four ingredients', () => {
      const expected = createHash('sha256')
        .update(JSON.stringify([{ include: ['src/**'] }, 'ctx', 'find ctx', 'verify ctx']))
        .digest('hex')
        .slice(0, 16);
      expect(scopeOf(base)).toBe(expected);
    });

    it('is the same for the same settings', () => {
      expect(scopeOf(base)).toBe(scopeOf({ ...base }));
    });

    it('changes with each of the four ingredients', () => {
      const original = scopeOf(base);
      const changed = [
        scopeOf({ 'detent.json': JSON.stringify({ reviewContext: 'ctx', prReview: { include: ['lib/**'] } }) }),
        scopeOf({ 'detent.json': JSON.stringify({ reviewContext: 'other', prReview: { include: ['src/**'] } }) }),
        scopeOf({ ...base, '.detent/prompts/pr-review-find.md': 'another find' }),
        scopeOf({ ...base, '.detent/prompts/pr-review-verify.md': 'another verify' }),
      ];
      for (const c of changed) expect(c).not.toBe(original);
      expect(new Set([original, ...changed]).size).toBe(5);
    });
  });
});

// A real repository: origin/<base> is made with update-ref, as an actions/checkout leaves it.

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(dir: string, path: string, text: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'detent-settings-'));
  git(dir, 'init', '-q');
  return dir;
}

function commit(dir: string, msg: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

describe('baseReader', () => {
  it('reads the settings of the base, not those of the head', () => {
    const dir = repo();
    put(dir, 'detent.json', JSON.stringify({ prReview: { include: ['base/**'] } }));
    put(dir, '.detent/prompts/pr-review-find.md', 'base find');
    const base = commit(dir, 'base');
    git(dir, 'update-ref', 'refs/remotes/origin/main', base);

    put(dir, 'detent.json', JSON.stringify({ prReview: { include: ['head/**'] } }));
    put(dir, '.detent/prompts/pr-review-find.md', 'head find');
    commit(dir, 'head rewrites the settings');

    const s = loadSettings(baseReader(dir, 'main'), readDefault);
    expect(s.patterns.include).toEqual(['base/**']);
    expect(s.findPrompt).toBe('base find');
  });

  it('reads a base whose name has a slash', () => {
    const dir = repo();
    put(dir, 'detent.json', JSON.stringify({ prReview: { ignore: ['legacy/**'] } }));
    const base = commit(dir, 'base');
    git(dir, 'update-ref', 'refs/remotes/origin/release/1.0', base);

    const s = loadSettings(baseReader(dir, 'release/1.0'), readDefault);
    expect(s.patterns.ignore).toEqual(['legacy/**']);
  });

  it('is a ConfigError naming the ref when the base is not in the checkout', () => {
    const dir = repo();
    put(dir, 'a.txt', 'x');
    commit(dir, 'only commit');
    expect(() => baseReader(dir, 'main')).toThrow(ConfigError);
    expect(() => baseReader(dir, 'main')).toThrow(/origin\/main/);
  });

  it('gives null for a file the base does not have, so the defaults apply', () => {
    const dir = repo();
    put(dir, 'README.txt', 'x');
    const base = commit(dir, 'base');
    git(dir, 'update-ref', 'refs/remotes/origin/main', base);

    const read = baseReader(dir, 'main');
    expect(read('detent.json')).toBeNull();
    expect(loadSettings(read, readDefault).patterns).toEqual(DEFAULT_PATTERNS);
  });
});
