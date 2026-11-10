import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseReviewRequest, prepareReview } from './input.js';
import { renderBlock } from '../install/blocks.js';

const git = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim()
  : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'detent-mcp-input-'));
  const run = (...args: string[]) => execFileSync(git, args, { cwd: root, encoding: 'utf8' }).trim();
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 'test@example.invalid'); run('config', 'user.name', 'Test'); run('config', 'core.autocrlf', 'false');
  const put = (path: string, value: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = (message: string) => { run('add', '-A'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  return { root, run, put, commit };
}

describe('parseReviewRequest', () => {
  test('rejects unknown fields and unsafe repository paths', () => {
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD', extra: true })).toThrow('unknown review request field');
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: '../secret.md', revision: 'HEAD' })).toThrow(/unsafe|relative|spec path/);
    expect(() => parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision: 'HEAD', contextPaths: ['x/../secret'] })).toThrow('contextPaths must contain at most 64 safe repository-relative paths');
  });
});

describe('prepareReview', () => {
  test('reads spec and optional context from the requested commit, excluding working tree changes', async () => {
    const r = repo();
    r.put('detent.json', JSON.stringify({ specFile: 'SPEC.md', specsDir: 'docs/specs', reviewContext: 'database uses sqlite' }));
    r.put('SPEC.md', 'root spec'); r.put('constitution/constitution.md', 'constitution');
    r.put('docs/specs/2026-11/a.md', 'committed spec'); r.put('AGENTS.md', 'guide');
    const revision = r.commit('baseline');
    r.put('docs/specs/2026-11/a.md', 'uncommitted canary');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }));
    expect(result).toMatchObject({ mode: 'spec', author: 'codex', commits: { head: revision } });
    expect(result.text).toContain('committed spec');
    expect(result.text).not.toContain('uncommitted canary');
    expect(result.text).toContain('database uses sqlite');
    expect(result.coverage).toContainEqual({ path: 'AGENTS.md', status: 'included', role: 'project guidance' });
    expect(result.text).toContain('"path":"AGENTS.md","status":"included"');
    expect(result.inputSha256).toBe(createHash('sha256').update(Buffer.from(result.text, 'utf8')).digest('hex'));
  });

  test('marks a valid installed AGENTS constitution block without repeating its committed blob in a spec review', async () => {
    const r = repo();
    r.put('docs/specs/2026-11/a.md', 'installed project spec');
    r.put('AGENTS.md', `# Project guidance\n\n${renderBlock('Installed constitution sentence.\n')}`);
    const revision = r.commit('installed layout');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision, contextPaths: ['AGENTS.md', 'docs/specs/2026-11/a.md'] }));
    expect(result.coverage).toEqual(expect.arrayContaining([
      { path: 'AGENTS.md', status: 'included', role: 'project guidance' },
      { path: 'AGENTS.md', status: 'included', role: 'constitution' },
      { path: 'AGENTS.md', status: 'included', role: 'explicit context' },
      { path: 'docs/specs/2026-11/a.md', status: 'included', role: 'reviewed spec' },
      { path: 'docs/specs/2026-11/a.md', status: 'included', role: 'explicit context' },
    ]));
    expect(result.text.split('Installed constitution sentence.').length - 1).toBe(1);
    expect(result.text.split('installed project spec').length - 1).toBe(1);
    expect(result.text).toContain('"path":"AGENTS.md","status":"included","role":"constitution"');
  });

  test('marks a valid installed CLAUDE constitution block in a code review and leaves broken guidance untrusted', async () => {
    const r = repo();
    r.put('src/a.ts', 'export const value = 1;\n');
    r.put('CLAUDE.md', renderBlock('Code constitution sentence.\n'));
    r.put('AGENTS.md', '<!-- detent:constitution v1 begin -->\nbroken without end');
    const base = r.commit('installed base');
    r.put('src/a.ts', 'export const value = 2;\n');
    const head = r.commit('change code');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }));
    expect(result.coverage).toContainEqual({ path: 'CLAUDE.md', status: 'included', role: 'constitution' });
    expect(result.coverage).not.toContainEqual({ path: 'AGENTS.md', status: 'included', role: 'constitution' });
    expect(result.text.split('Code constitution sentence.').length - 1).toBe(1);
  });

  test('includes the Detent root spec-format fallback as untrusted committed context', async () => {
    const r = repo();
    r.put('docs/specs/2026-11/a.md', 'root project spec');
    r.put('skills/design-spec/spec-format.md', 'root format requirements');
    const revision = r.commit('root format');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }));
    expect(result.coverage).toContainEqual({ path: 'skills/design-spec/spec-format.md', status: 'included', role: 'spec format' });
    expect(result.text).toContain('root format requirements');
  });

  test('admits a large changed AGENTS blob once while retaining changed, guidance and explicit roles', async () => {
    const r = repo(); r.put('AGENTS.md', 'old guidance\n'); const base = r.commit('base');
    const unique = 'LARGE-COMMITTED-GUIDANCE:' + 'x'.repeat(430_000);
    r.put('AGENTS.md', `${unique}\n`);
    const head = r.commit('guidance edit');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head, contextPaths: ['AGENTS.md'] }));
    expect(result.coverage).toEqual(expect.arrayContaining([
      { path: 'AGENTS.md', status: 'included', role: 'changed head blob' },
      { path: 'AGENTS.md', status: 'included', role: 'project guidance' },
      { path: 'AGENTS.md', status: 'included', role: 'explicit context' },
    ]));
    expect(result.text.split('===== changed head blob: AGENTS.md').length - 1).toBe(1);
    expect(result.text).not.toContain('===== project guidance: AGENTS.md');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThan(1024 * 1024);
  });

  test.each(['working', 'info'] as const)('ignores %s uncommitted Git attributes when rendering a committed text patch', async (source) => {
    const r = repo(); r.put('a.txt', 'alpha\n'); const base = r.commit('base');
    r.put('a.txt', 'bravo\n'); const head = r.commit('head');
    if (source === 'working') r.put('.gitattributes', 'a.txt -diff\n');
    else r.put('.git/info/attributes', 'a.txt -diff\n');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }));
    expect(result.text).toContain('-alpha');
    expect(result.text).toContain('+bravo');
    expect(result.text).not.toContain('GIT binary patch');
  });

  test('ignores mutable replacement refs for selected committed blobs', async () => {
    const r = repo();
    const path = 'docs/specs/2026-11/a.md';
    r.put(path, 'original committed spec');
    const revision = r.commit('original');
    r.put('replacement.txt', 'substitute bytes');
    const replacement = r.run('hash-object', '-w', 'replacement.txt');
    const original = r.run('rev-parse', `${revision}:${path}`);
    r.run('replace', original, replacement);
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path, revision }));
    expect(result.text).toContain('original committed spec');
    expect(result.text).not.toContain('substitute bytes');
  });

  test('refuses a missing promised blob without invoking a configured transport', async () => {
    const r = repo(); r.put('ordinary.txt', 'first'); const base = r.commit('base');
    r.put('ordinary.txt', 'second');
    const ordinary = r.run('hash-object', '-w', 'ordinary.txt');
    const missing = 'f'.repeat(40);
    const rows = Buffer.from(`100644 blob ${ordinary}\tordinary.txt\0` + `100644 blob ${missing}\tpromised.txt\0`);
    const tree = execFileSync(git, ['mktree', '-z', '--missing'], { cwd: r.root, input: rows, encoding: 'utf8' }).trim();
    const head = r.run('commit-tree', tree, '-p', base, '-m', 'promised blob');
    const canary = join(r.root, 'transport-canary');
    r.put('canary.sh', `#!/bin/sh\nprintf touched > '${canary.replaceAll('\\', '/')}'\nexit 1\n`);
    r.run('config', 'remote.origin.url', 'ext::sh ./canary.sh');
    r.run('config', 'remote.origin.promisor', 'true');
    r.run('config', 'remote.origin.partialclonefilter', 'blob:none');
    r.run('config', 'protocol.ext.allow', 'always');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow(missing);
    expect(existsSync(canary)).toBe(false);
  });

  test('rejects a changed gitlink despite project submodule ignore settings', async () => {
    const r = repo(); r.put('ordinary.txt', 'first'); const first = r.commit('first');
    r.run('update-index', '--add', '--cacheinfo', `160000,${first},module`);
    r.run('commit', '-qm', 'gitlink base');
    const base = r.run('rev-parse', 'HEAD');
    r.put('ordinary.txt', 'second');
    r.run('add', 'ordinary.txt');
    r.run('update-index', '--add', '--cacheinfo', `160000,${base},module`);
    r.run('commit', '-qm', 'ordinary and gitlink changed');
    const head = r.run('rev-parse', 'HEAD');
    r.run('config', 'diff.ignoreSubmodules', 'all');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow(/submodule|gitlink/i);
  });

  test('rejects distinct invalid UTF-8 Git tree names before path lookup', async () => {
    const r = repo(); r.put('source.txt', 'safe'); r.commit('parent');
    const oid = r.run('hash-object', '-w', 'source.txt');
    const row = (byte: number) => Buffer.concat([Buffer.from(`100644 blob ${oid}\tbad`), Buffer.from([byte]), Buffer.from('.txt\0')]);
    const tree = execFileSync(git, ['mktree', '-z'], { cwd: r.root, input: Buffer.concat([row(0xfe), row(0xff)]), encoding: 'utf8' }).trim();
    const head = r.run('commit-tree', tree, '-p', 'HEAD', '-m', 'invalid names');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base: 'HEAD', head }))).rejects.toThrow(/invalid UTF-8 Git tree path/i);
  });

  test('does not alias a BOM-prefixed Git path to the requested normal spec path', async () => {
    const r = repo();
    r.put('\uFEFFdocs/specs/2026-11/a.md', 'BOM-prefixed path content');
    const revision = r.commit('BOM path');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }))).rejects.toThrow(/spec does not exist/i);
  });

  test('accepts a shrinking text file when only its old blob exceeds remaining stdin budget', async () => {
    const r = repo();
    const lines = (character: string, count: number) => `${`${character.repeat(99)}\n`.repeat(count)}`;
    r.put('a.txt', `${lines('A', 6700)}old\n`);
    r.put('b.txt', lines('B', 3600));
    const base = r.commit('large base');
    r.put('a.txt', `${lines('A', 6700)}new\n`);
    r.put('b.txt', lines('B', 3400));
    const head = r.commit('small visible change and shrinking blob');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }));
    expect(result.coverage).toContainEqual({ path: 'b.txt', status: 'included', role: 'changed head blob' });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThan(1024 * 1024);
  });

  test('rejects the full text patch when an attribute would otherwise hide over-budget removed lines', async () => {
    const r = repo();
    const lines = (character: string, count: number) => `${`${character.repeat(99)}\n`.repeat(count)}`;
    r.put('.gitattributes', 'b.txt -diff\n');
    r.put('a.txt', `${lines('A', 6900)}old\n`); r.put('b.txt', lines('B', 3600));
    const base = r.commit('large base');
    r.put('a.txt', `${lines('A', 6900)}new\n`); r.put('b.txt', lines('B', 3400));
    const head = r.commit('shrinking text');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow('review payload exceeds 1 MiB');
  });

  test('bounds cumulative full head blobs when diffs are small', async () => {
    const r = repo();
    for (let i = 0; i < 8; i++) r.put(`file-${i}.txt`, `${'A'.repeat(140_000)}\nold\n`);
    const base = r.commit('large base');
    for (let i = 0; i < 8; i++) r.put(`file-${i}.txt`, `${'A'.repeat(140_000)}\nnew\n`);
    const head = r.commit('small changes');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow(/payload exceeds 1 MiB/i);
  });

  test('reports absent optional references and errors on absent explicit context', async () => {
    const r = repo(); r.put('docs/specs/2026-11/a.md', 'spec'); const revision = r.commit('spec');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision }));
    expect(result.coverage).toContainEqual({ path: 'constitution/constitution.md', status: 'missing', role: 'constitution' });
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'docs/specs/2026-11/a.md', revision, contextPaths: ['missing.md'] }))).rejects.toThrow('explicit context path is missing at commit: missing.md');
  });

  test('uses the unique merge base and full head blobs for divergent changes, including rename and deletion', async () => {
    const r = repo(); r.put('old.txt', `${'shared unchanged line\n'.repeat(30)}old line\n`); r.put('delete.txt', 'deleted content'); const base = r.commit('base');
    r.run('checkout', '-qb', 'feature'); r.put('old.txt', `${'shared unchanged line\n'.repeat(30)}new full head content\n`); r.run('mv', 'old.txt', 'renamed.txt'); r.run('rm', 'delete.txt');
    const head = r.commit('feature changes');
    r.run('checkout', '-q', 'main'); r.put('base-only.txt', 'base side'); const divergedBase = r.commit('diverge');
    const result = await prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base: 'main', head }));
    expect(result.commits).toEqual({ head, base: divergedBase, mergeBase: base });
    expect(result.text).toContain('new full head content');
    expect(result.coverage).toEqual(expect.arrayContaining([
      { path: 'old.txt', status: 'included', role: 'rename source' },
      { path: 'renamed.txt', status: 'included', role: 'renamed head blob' },
      { path: 'delete.txt', status: 'included', role: 'deleted path' },
    ]));
  });

  test('rejects empty diff and payloads over one MiB', async () => {
    const r = repo(); r.put('x.txt', 'x'); const base = r.commit('base');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head: base }))).rejects.toThrow(/empty/i);
    r.run('checkout', '-qb', 'large'); r.put('large.txt', 'x'.repeat(1024 * 1024 + 1)); const head = r.commit('large');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow('review payload exceeds 1 MiB');
  });

  test('rejects an option-like Git revision before lookup', async () => {
    const r = repo(); r.put('safe.txt', 'safe'); const base = r.commit('base');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head: '--help' }))).rejects.toThrow('unsafe Git revision');
  });

  test.each([
    ['binary', 'binary.bin', Buffer.from([0, 1, 2]), 'binary Git blob is not reviewable: binary.bin'],
    ['invalid UTF-8', 'invalid.txt', Buffer.from([0xc3, 0x28]), 'invalid UTF-8 committed diff'],
    ['LFS pointer', 'pointer.txt', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n', 'Git LFS pointer is not reviewable: pointer.txt'],
  ] as const)('rejects an isolated %s head blob', async (_kind, path, content, expected) => {
    const r = repo(); r.put('safe.txt', 'safe'); const base = r.commit('base');
    r.put(path, content); const head = r.commit('unsupported head');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow(expected);
  });

  test('rejects an isolated symlink head entry through Git plumbing', async () => {
    const r = repo(); r.put('safe.txt', 'safe'); const base = r.commit('base');
    r.put('link-target', 'safe.txt');
    const oid = r.run('hash-object', '-w', 'link-target');
    r.run('update-index', '--add', '--cacheinfo', `120000,${oid},link.txt`);
    r.run('commit', '-qm', 'symlink head'); const head = r.run('rev-parse', 'HEAD');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head }))).rejects.toThrow('unsupported symlink or submodule: link.txt');
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
  ])('rejects a %s base blob replaced with ordinary text', async (_kind, addUnsupportedBlob) => {
    const r = repo();
    r.put('replace.txt', 'ordinary text');
    r.commit('initial');
    addUnsupportedBlob(r);
    r.run('commit', '-qm', 'unsupported base blob');
    const base = r.run('rev-parse', 'HEAD');
    r.put('replace.txt', 'safe replacement text');
    const head = r.commit('replace unsupported blob');

    const expected = _kind === 'binary' ? 'binary Git blob is not reviewable: replace.txt'
      : _kind === 'invalid UTF-8' ? 'invalid UTF-8 committed diff'
        : _kind === 'LFS pointer' ? 'Git LFS pointer is not reviewable: replace.txt'
          : 'unsupported symlink or submodule: replace.txt';
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'code', base, head })))
      .rejects.toThrow(expected);
  });

  test('rejects flat spec.md even when it is committed', async () => {
    const r = repo(); r.put('spec.md', 'probe fixture'); const revision = r.commit('probe');
    await expect(prepareReview(r.root, git, parseReviewRequest({ author: 'codex', kind: 'spec', path: 'spec.md', revision }))).rejects.toThrow(/specsDir|\.md file/i);
  });
});
