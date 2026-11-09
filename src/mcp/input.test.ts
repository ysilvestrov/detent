import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseReviewRequest, prepareReview } from './input.js';

const git = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim()
  : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'detent-mcp-input-'));
  const run = (...args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8' }).trim();
  run('init', '-q'); run('config', 'user.email', 'test@example.invalid'); run('config', 'user.name', 'Test');
  const put = (path: string, value: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = (message: string) => { run('add', '-A'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  return { root, run, put, commit };
}

describe('parseReviewRequest', () => {
  test('rejects unknown fields and unsafe repository paths', () => {
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD', extra: true })).toThrow();
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: '../secret.md', revision: 'HEAD' })).toThrow();
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD', contextPaths: ['x/../secret'] })).toThrow();
  });
});

describe('prepareReview', () => {
  test('reads spec and optional context from the requested commit, excluding working tree changes', () => {
    const r = repo();
    r.put('detent.json', JSON.stringify({ specFile: 'SPEC.md', specsDir: 'docs/specs', reviewContext: 'database uses sqlite' }));
    r.put('SPEC.md', 'root spec'); r.put('constitution/constitution.md', 'constitution');
    r.put('docs/specs/2026-11/a.md', 'committed spec'); r.put('AGENTS.md', 'guide');
    const revision = r.commit('baseline');
    r.put('docs/specs/2026-11/a.md', 'uncommitted canary');
    const result = prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }));
    expect(result).toMatchObject({ mode: 'spec', author: 'codex', commits: { head: revision } });
    expect(result.text).toContain('committed spec');
    expect(result.text).not.toContain('uncommitted canary');
    expect(result.text).toContain('database uses sqlite');
    expect(result.coverage).toContainEqual({ path: 'AGENTS.md', status: 'included', role: 'project guidance' });
    expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('reports absent optional references and errors on absent explicit context', () => {
    const r = repo(); r.put('docs/specs/2026-11/a.md', 'spec'); const revision = r.commit('spec');
    const result = prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }));
    expect(result.coverage).toContainEqual({ path: 'constitution/constitution.md', status: 'missing', role: 'constitution' });
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision, contextPaths: ['missing.md'] }))).toThrow(/context/i);
  });

  test('uses the unique merge base and full head blobs for divergent changes, including rename and deletion', () => {
    const r = repo(); r.put('old.txt', 'old'); r.put('delete.txt', 'deleted'); const base = r.commit('base');
    r.run('checkout', '-qb', 'feature'); r.put('old.txt', 'new full head content'); r.run('mv', 'old.txt', 'renamed.txt'); r.run('rm', 'delete.txt');
    const head = r.commit('feature changes');
    r.run('checkout', '-q', 'master'); r.put('base-only.txt', 'base side'); r.commit('diverge');
    const result = prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base: 'master', head }));
    expect(result.commits).toEqual({ head, base: expect.any(String), mergeBase: base });
    expect(result.text).toContain('new full head content');
    expect(result.text).toContain('renamed.txt');
    expect(result.text).toContain('deleted');
  });

  test('rejects empty diff and payloads over one MiB', () => {
    const r = repo(); r.put('x.txt', 'x'); const base = r.commit('base');
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head: base }))).toThrow(/empty/i);
    r.run('checkout', '-qb', 'large'); r.put('large.txt', 'x'.repeat(1024 * 1024 + 1)); const head = r.commit('large');
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).toThrow(/1 MiB|1048576|payload/i);
  });

  test('rejects unsafe revisions and committed binary, invalid UTF-8, symlink, and LFS blobs', () => {
    const r = repo(); r.put('safe.txt', 'safe'); const base = r.commit('base');
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head: '--help' }))).toThrow(/revision/i);
    r.run('checkout', '-qb', 'bad');
    r.put('binary.bin', Buffer.from([0, 1, 2]));
    r.put('invalid.txt', Buffer.from([0xc3, 0x28]));
    r.put('pointer.bin', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
    r.put('target.txt', 'target');
    r.commit('unsupported content');
    r.put('link-target', 'target.txt');
    const linkOid = r.run('hash-object', '-w', 'link-target');
    r.run('update-index', '--add', '--cacheinfo', `120000,${linkOid},link.txt`);
    r.run('commit', '-qm', 'symlink');
    const head = r.run('rev-parse', 'HEAD');
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).toThrow(/binary|UTF-8|symlink|LFS/i);
  });

  test.each([
    ['binary', (r: ReturnType<typeof repo>) => {
      r.put('replace.txt', Buffer.from([0, 1, 2]));
      r.run('add', '--', 'replace.txt');
    }],
    ['invalid UTF-8', (r: ReturnType<typeof repo>) => {
      r.put('replace.txt', Buffer.from([0xc3, 0x28]));
      r.run('add', '--', 'replace.txt');
    }],
    ['LFS pointer', (r: ReturnType<typeof repo>) => {
      r.put('replace.txt', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
      r.run('add', '--', 'replace.txt');
    }],
    ['symlink', (r: ReturnType<typeof repo>) => {
      r.put('link-target', 'replace.txt');
      const oid = r.run('hash-object', '-w', 'link-target');
      r.run('update-index', '--add', '--cacheinfo', `120000,${oid},replace.txt`);
    }],
    ['submodule', (r: ReturnType<typeof repo>) => {
      const oid = r.run('rev-parse', 'HEAD');
      r.run('update-index', '--add', '--cacheinfo', `160000,${oid},replace.txt`);
    }],
  ])('rejects a %s base blob replaced with ordinary text', (_kind, addUnsupportedBlob) => {
    const r = repo();
    r.put('replace.txt', 'ordinary text');
    r.commit('initial');
    addUnsupportedBlob(r);
    r.run('commit', '-qm', 'unsupported base blob');
    const base = r.run('rev-parse', 'HEAD');
    r.put('replace.txt', 'safe replacement text');
    const head = r.commit('replace unsupported blob');

    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head })))
      .toThrow(/binary|UTF-8|symlink|submodule|LFS/i);
  });

  test('rejects flat spec.md even when it is committed', () => {
    const r = repo(); r.put('spec.md', 'probe fixture'); const revision = r.commit('probe');
    expect(() => prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'spec.md', revision }))).toThrow(/specsDir|\.md file/i);
  });
});
