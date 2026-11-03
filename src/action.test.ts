// The GitHub Action and the example workflow. No YAML parser among the dependencies: exact strings.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('action.yml', () => {
  const text = read('action.yml');
  const lines = text.split(/\r?\n/);
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle));

  test.each([
    'using: composite',
    'ref: ${{ github.event.pull_request.head.sha }}',
    'fetch-depth: 0',
    'persist-credentials: false',
    'node-version: 24',
    '--ignore-scripts',
    'npm i --prefix "$RUNNER_TEMP/detent"',
    'dist/cli.js" pr-review',
  ])('has %s', (needle) => {
    expect(text.includes(needle)).toBe(true);
  });

  test('checkout is the first step: the default ref of pull_request is a merge commit', () => {
    const first = lines.findIndex((l) => l.trim().startsWith('- uses:') || l.trim().startsWith('- name:'));
    expect(lines[first]!.trim()).toBe('- uses: actions/checkout@v7');
  });

  test('the secrets reach only the review step', () => {
    const review = lineOf('name: Review');
    expect(review).toBeGreaterThan(lineOf('name: Install'));
    const keys = lines.flatMap((l, i) => (l.includes('_API_KEY:') ? [i] : []));
    expect(keys.length).toBe(3);
    expect(Math.min(...keys)).toBeGreaterThan(review);
    const token = lines.flatMap((l, i) => (l.includes('GITHUB_TOKEN:') ? [i] : []));
    expect(token.length).toBe(1);
    expect(token[0]).toBeGreaterThan(review);
  });

  test('every run step names its shell', () => {
    const runs = lines.filter((l) => /^\s+run:/.test(l)).length;
    expect(runs).toBe(2);
    expect(lines.filter((l) => l.trim() === 'shell: bash').length).toBe(runs);
  });

  test('the version comes from the package.json of the same revision of the Action', () => {
    expect(text.includes(`require(process.env.GITHUB_ACTION_PATH + '/package.json').version`)).toBe(true);
    expect(text.includes('"@ysilvestrov/detent@$version"')).toBe(true);
  });

  test('the code of the PR is not installed or run', () => {
    expect(lines.filter((l) => l.includes('npm ci') || l.includes('npx'))).toEqual([]);
  });
});

describe('examples/pr-review.workflow.yml', () => {
  const text = read('examples/pr-review.workflow.yml');

  test.each([
    'types: [opened, reopened, synchronize]',
    'pull-requests: write',
    "github.event.pull_request.user.login != 'dependabot[bot]'",
    'cancel-in-progress: true',
    'uses: ysilvestrov/detent@',
    'openai-api-key: ${{ secrets.OPENAI_API_KEY }}',
  ])('has %s', (needle) => {
    expect(text.includes(needle)).toBe(true);
  });

  test('does not run on pull_request_target, where the secrets meet the code of a fork', () => {
    expect(text.includes('pull_request_target')).toBe(false);
  });
});
