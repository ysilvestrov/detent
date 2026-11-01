import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPrompt } from './protocol.js';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url)), 'utf8');
const diffVars = {
  project: 'acme', branch: 'feat/x', sha: 'abc1234', base: 'origin/main', diffPath: '/t/run/branch.diff',
  specsDir: 'docs/specs', plansDir: 'docs/plans', specFile: 'spec.md', reviewContext: 'one host, SQLite',
};
const specVars = {
  project: 'acme', specPath: 'docs/specs/2026-11/x-design.md', branch: 'main', sha: 'abc1234',
  specFile: 'spec.md', reviewContext: 'none stated',
};

describe('review-diff.md', () => {
  const out = renderPrompt(read('review-diff.md'), diffVars);
  test('names the project, the subject and the diff file', () => {
    expect(out.startsWith('You are reviewing a branch of the acme repository')).toBe(true);
    expect(out.includes('Branch: feat/x at abc1234, compared with origin/main.')).toBe(true);
    expect(out.includes('The full diff is in the file /t/run/branch.diff.')).toBe(true);
  });
  test('points at the configured spec and plan folders and the root spec', () => {
    expect(out.includes('under docs/specs/\nand docs/plans/')).toBe(true);
    expect(out.includes('the root spec.md where')).toBe(true);
  });
  test('carries the project context as given', () => {
    expect(out.includes('Project context: one host, SQLite\n')).toBe(true);
  });
  test('ends by demanding the result line', () => {
    expect(out.trimEnd().endsWith('CROSS-REVIEW-RESULT: <n> findings\nwhere <n> is the number of findings (0 if none).')).toBe(true);
  });
  test('the spec-mode variable set does not fill it', () => {
    expect(() => renderPrompt(read('review-diff.md'), specVars)).toThrow('unfilled placeholder {{base}}');
  });
});

describe('review-spec.md', () => {
  const out = renderPrompt(read('review-spec.md'), specVars);
  test('names the project and the spec under review', () => {
    expect(out.startsWith('You are reviewing a design spec of the acme repository')).toBe(true);
    expect(out.includes('Spec: docs/specs/2026-11/x-design.md on branch main at abc1234.')).toBe(true);
  });
  test('points at the spec format shipped with the design-spec skill', () => {
    expect(out.includes('spec-format.md of the detent-design-spec skill')).toBe(true);
  });
  test('carries the absent-context text as given', () => {
    expect(out.includes('Project context: none stated\n')).toBe(true);
  });
  test('ends by demanding the result line', () => {
    expect(out.trimEnd().endsWith('CROSS-REVIEW-RESULT: <n> findings\nwhere <n> is the number of findings (0 if none).')).toBe(true);
  });
  test('the diff-mode variable set does not fill it', () => {
    expect(() => renderPrompt(read('review-spec.md'), diffVars)).toThrow('unfilled placeholder {{specPath}}');
  });
});

describe('no project-specific text in the core prompts', () => {
  test.each(['review-diff.md', 'review-spec.md'])('%s mentions no warsaw, beer or SQLite', (name) => {
    expect(read(name).match(/warsaw|beer|sqlite/gi)).toBeNull();
  });
});
