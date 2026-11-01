import { describe, test, expect } from 'vitest';
import { join } from 'node:path';
import { isNestedRun, preflight, specPreflight, normalizeSpecPath, specPathError, runDirPrefix, runArtifacts } from './preflight.js';

const DIRTY = 'working tree is dirty — commit first; the review is pinned to a SHA';

describe('isNestedRun', () => {
  test('set to 1 means a reviewer is calling a reviewer', () => {
    expect(isNestedRun({ CROSS_REVIEW_ACTIVE: '1' })).toBe(true);
  });
  test('absent means a top-level run', () => {
    expect(isNestedRun({})).toBe(false);
  });
  test('any other value is not the guard', () => {
    expect([isNestedRun({ CROSS_REVIEW_ACTIVE: '0' }), isNestedRun({ CROSS_REVIEW_ACTIVE: '' }), isNestedRun({ CROSS_REVIEW_ACTIVE: 'true' })]).toEqual([false, false, false]);
  });
});

describe('preflight', () => {
  test('clean tree with a diff passes', () => {
    expect(preflight({ dirty: false, diffBytes: 120 })).toBeNull();
  });
  test('a one-byte diff passes', () => {
    expect(preflight({ dirty: false, diffBytes: 1 })).toBeNull();
  });
  test('dirty tree is refused: the marker names a SHA', () => {
    expect(preflight({ dirty: true, diffBytes: 120 })).toBe(DIRTY);
  });
  test('empty diff is refused', () => {
    expect(preflight({ dirty: false, diffBytes: 0 })).toBe('empty diff against the base — nothing to review');
  });
  test('dirty wins over empty (the first thing to fix)', () => {
    expect(preflight({ dirty: true, diffBytes: 0 })).toBe(DIRTY);
  });
});

describe('specPreflight', () => {
  test('clean tree with the spec committed passes', () => {
    expect(specPreflight({ dirty: false, inHead: true })).toBeNull();
  });
  test('a spec missing from HEAD is refused', () => {
    expect(specPreflight({ dirty: false, inHead: false })).toBe('the spec is not committed at HEAD — commit it first; the review is pinned to a SHA');
  });
  test('dirty wins over a missing spec (the first thing to fix)', () => {
    expect(specPreflight({ dirty: true, inHead: false })).toBe(DIRTY);
  });
  test('dirty is refused with the spec committed', () => {
    expect(specPreflight({ dirty: true, inHead: true })).toBe(DIRTY);
  });
});

describe('normalizeSpecPath', () => {
  test('Windows separators become forward slashes', () => {
    expect(normalizeSpecPath('docs\\specs\\2026-11\\x-design.md')).toBe('docs/specs/2026-11/x-design.md');
  });
  test('a leading ./ is dropped', () => {
    expect(normalizeSpecPath('./docs/specs/2026-11/x-design.md')).toBe('docs/specs/2026-11/x-design.md');
  });
  test('a leading .\\ is dropped too', () => {
    expect(normalizeSpecPath('.\\docs\\specs\\2026-11\\x-design.md')).toBe('docs/specs/2026-11/x-design.md');
  });
  test('a plain repo-relative path is unchanged', () => {
    expect(normalizeSpecPath('docs/specs/2026-11/x-design.md')).toBe('docs/specs/2026-11/x-design.md');
  });
  test('an empty path stays empty', () => {
    expect(normalizeSpecPath('')).toBe('');
  });
});

describe('specPathError', () => {
  test('a markdown file in a month folder under specsDir passes', () => {
    expect(specPathError('docs/specs/2026-11/2026-11-01-x-design.md', 'docs/specs')).toBeNull();
  });
  test('a file at the top of specsDir is refused: specs live in month folders', () => {
    expect(specPathError('docs/specs/x-design.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/x-design.md"');
  });
  test('a plan is not a spec', () => {
    expect(specPathError('docs/plans/2026-11/x.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/plans/2026-11/x.md"');
  });
  test('a nested folder under the month is refused', () => {
    expect(specPathError('docs/specs/2026-11/a/x.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/2026-11/a/x.md"');
  });
  test('a month folder in the wrong shape is refused', () => {
    expect(specPathError('docs/specs/2026-1/x.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/2026-1/x.md"');
  });
  test('a non-markdown file is refused', () => {
    expect(specPathError('docs/specs/2026-11/x.txt', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/2026-11/x.txt"');
  });
  test('a bare .md name is refused', () => {
    expect(specPathError('docs/specs/2026-11/.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/2026-11/.md"');
  });
  test('an empty path is refused', () => {
    expect(specPathError('', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got ""');
  });
  test('a path that only starts like specsDir is refused', () => {
    expect(specPathError('docs/specs-old/2026-11/x.md', 'docs/specs')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs-old/2026-11/x.md"');
  });
  test('specsDir with a leading ./ and a trailing / is normalised', () => {
    expect(specPathError('docs/specs/2026-11/x.md', './docs/specs/')).toBeNull();
  });
  test('specsDir with backslashes is normalised, in the error too', () => {
    expect(specPathError('docs/specs/x.md', '.\\docs\\specs\\')).toBe('--spec must name a .md file under docs/specs/<YYYY-MM>/, got "docs/specs/x.md"');
  });
  test('a custom specsDir is honoured', () => {
    expect(specPathError('design/2026-11/x.md', 'design')).toBeNull();
  });
  test('a dot in specsDir is a literal dot, not any character', () => {
    expect(specPathError('docs/specsXv2/2026-11/x.md', 'docs/specs.v2')).toBe('--spec must name a .md file under docs/specs.v2/<YYYY-MM>/, got "docs/specsXv2/2026-11/x.md"');
  });
  test('a dot in specsDir still matches itself', () => {
    expect(specPathError('docs/specs.v2/2026-11/x.md', 'docs/specs.v2')).toBeNull();
  });
  test('other regex characters in specsDir are literal', () => {
    expect([specPathError('a+b/2026-11/x.md', 'a+b'), specPathError('aab/2026-11/x.md', 'a+b')]).toEqual([
      null, '--spec must name a .md file under a+b/<YYYY-MM>/, got "aab/2026-11/x.md"',
    ]);
  });
});

describe('runDirPrefix', () => {
  // The prefix is joined by the platform's path module; mkdtemp appends to the trailing dash.
  test('diff mode: reviewer, branch with slashes as dashes, sha cut to 7, open for the mkdtemp suffix', () => {
    expect(runDirPrefix('tmp', 'codex', 'feat/cross-review', '0123456789abcdef', 'diff')).toBe(join('tmp', 'cross-review-codex-feat-cross-review-0123456-'));
  });
  test('spec mode is told apart by its own prefix', () => {
    expect(runDirPrefix('tmp', 'agy', 'main', '0123456789abcdef', 'spec')).toBe(join('tmp', 'cross-review-spec-agy-main-0123456-'));
  });
  test('a sha shorter than 7 is kept whole', () => {
    expect(runDirPrefix('tmp', 'claude', 'b', 'abc', 'diff')).toBe(join('tmp', 'cross-review-claude-b-abc-'));
  });
});

describe('runArtifacts', () => {
  test('every artifact of a run lives inside its own directory', () => {
    const dir = join('tmp', 'cross-review-codex-b-0123456-Ab12Cd');
    expect(runArtifacts(dir)).toEqual({
      diff: join(dir, 'branch.diff'),
      report: join(dir, 'report.md'),
      log: join(dir, 'reviewer.log'),
      snapshot: join(dir, 'snapshot'),
    });
  });
});
