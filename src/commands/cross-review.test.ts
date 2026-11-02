// End to end: crossReview in a fresh git repository, with fake reviewers on a PATH that shows
// nothing but them, node and git (src/review/fixtures/fake-reviewer.ts).
// Leftover temp directories are not removed: recursive deletion is not used in this repository.
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { crossReview } from './cross-review.js';
import { installFakeReviewers } from '../review/fixtures/fake-reviewer.js';

const E2E_TIMEOUT = 60_000;

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(repo: string, env: Record<string, string>, path: string, text: string, message: string): void {
  const parts = path.split('/');
  mkdirSync(join(repo, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(repo, ...parts), text);
  git(repo, env, 'add', '--', path);
  git(repo, env, 'commit', '-q', '-m', message);
}

// main with one commit; feat/x one commit ahead of it, checked out.
function setup(fakes: readonly ('codex' | 'claude' | 'agy')[]) {
  const base = mkdtempSync(join(tmpdir(), 'detent-e2e-'));
  const { env, logDir } = installFakeReviewers(base, fakes);
  const repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'tmp/\n');
  writeFileSync(join(repo, 'package.json'), '{ "name": "acme" }\n');
  git(repo, env, 'add', '.');
  git(repo, env, 'commit', '-q', '-m', 'init');
  git(repo, env, 'checkout', '-q', '-b', 'feat/x');
  commitFile(repo, env, 'src/math.js', 'export const sub = (a, b) => a + b;\n', 'feat: sub');

  const out: string[] = [];
  const err: string[] = [];
  const run = (argv: string[], extraEnv: Record<string, string> = {}, timeoutMs = 30_000) => crossReview(argv, {
    cwd: repo, env: { ...env, ...extraEnv }, timeoutMs, out: (l) => out.push(l), err: (l) => err.push(l),
  });
  const calls = (id: string): Record<string, unknown>[] => readFileSync(join(logDir, `${id}.jsonl`), 'utf8')
    .trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const called = (id: string) => existsSync(join(logDir, `${id}.jsonl`));
  const sha7 = () => git(repo, env, 'rev-parse', '--short=7', 'HEAD');
  const worktrees = () => git(repo, env, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  const toplevel = git(repo, env, 'rev-parse', '--show-toplevel');
  return { repo, env, out, err, run, calls, called, sha7, worktrees, toplevel };
}

describe('crossReview: a review that runs', () => {
  test('success: the marker, the snapshot removed, the reviewer saw a closed stdin and the guard', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:2' })).toBe(0);
    expect(s.out).toEqual([`PR marker: Cross-review: codex/gpt-6.1-sol @ ${s.sha7()} (author: claude) — 2 findings: <f> fixed, <r> rejected`]);
    const [call] = s.calls('codex');
    expect([call?.kind, call?.active, call?.stdin, call?.promptHead]).toEqual([
      'review', '1', 'closed', 'You are reviewing a branch of the acme repository before its pull request opens.',
    ]);
    expect(basename(call?.cwd as string)).toBe('snapshot');
    expect(s.calls('codex').length).toBe(1);
    expect(s.worktrees()).toEqual([`worktree ${s.toplevel}`]);
  }, E2E_TIMEOUT);

  test('claude reviews a codex author with its CLI default model, from stdout', () => {
    const s = setup(['claude']);
    expect(s.run(['--author', 'codex', '--base', 'main'], { FAKE_CLAUDE: 'ok:4' })).toBe(0);
    expect(s.out).toEqual([`PR marker: Cross-review: claude/default @ ${s.sha7()} (author: codex) — 4 findings: <f> fixed, <r> rejected`]);
  }, E2E_TIMEOUT);

  test('a spec review: the spec marker and the spec prompt', () => {
    const s = setup(['codex']);
    commitFile(s.repo, s.env, 'docs/specs/2026-11/x-design.md', '# X\n', 'docs: spec');
    expect(s.run(['--author', 'claude', '--spec', 'docs/specs/2026-11/x-design.md'], { FAKE_CODEX: 'ok:0' })).toBe(0);
    expect(s.out).toEqual([`Spec marker: Spec-review: codex/gpt-6.1-sol @ ${s.sha7()} (author: claude) — 0 findings: <f> fixed, <r> rejected`]);
    expect(s.calls('codex')[0]?.promptHead).toBe('You are reviewing a design spec of the acme repository before its owner reads it.');
  }, E2E_TIMEOUT);

  test('codex not installed: agy reviews after its canary, and the marker names the fallback', () => {
    const s = setup(['agy']);
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_AGY: 'ok:1' })).toBe(0);
    expect(s.out).toEqual([
      `PR marker: Cross-review: agy/gemini-4-argon @ ${s.sha7()} (author: claude) — 1 findings: <f> fixed, <r> rejected (fallback: codex — not installed)`,
    ]);
    expect(s.calls('agy').map((c) => c.kind)).toEqual(['canary', 'review']);
    expect(s.worktrees()).toEqual([`worktree ${s.toplevel}`]);
  }, E2E_TIMEOUT);

  test('the agy canary wrote its file: failed, and the review never ran', () => {
    const s = setup(['agy']);
    expect(s.run(['--author', 'claude', '--reviewer', 'agy', '--base', 'main'], { FAKE_AGY: 'ok:1', FAKE_AGY_CANARY: 'writes' })).toBe(5);
    expect(s.out).toEqual(['PR marker: Cross-review: failed (author: claude; agy: canary failed, review not run: deny rule ineffective (canary file was written))']);
    expect(s.calls('agy').map((c) => c.kind)).toEqual(['canary']);
  }, E2E_TIMEOUT);

  test('the agy canary neither wrote nor reported a refusal: the review never ran, and the fallback says why', () => {
    const s = setup(['codex', 'agy']);
    commitFile(s.repo, s.env, 'detent.json', '{ "reviewers": ["agy", "codex"] }\n', 'chore: agy first');
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:2', FAKE_AGY: 'ok:1', FAKE_AGY_CANARY: 'silent' })).toBe(0);
    expect(s.out).toEqual([
      `PR marker: Cross-review: codex/gpt-6.1-sol @ ${s.sha7()} (author: claude) — 2 findings: <f> fixed, <r> rejected (fallback: agy — canary failed, review not run: no "deny rule" in its output)`,
    ]);
    expect(s.calls('agy').map((c) => c.kind)).toEqual(['canary']);
  }, E2E_TIMEOUT);

  test('agy exits 0 with an empty stdout and a jetski refusal: failed for the missing result line', () => {
    const s = setup(['agy']);
    expect(s.run(['--author', 'claude', '--reviewer', 'agy', '--base', 'main'], { FAKE_AGY: 'jetski' })).toBe(5);
    expect(s.out).toEqual(['PR marker: Cross-review: failed (author: claude; agy: output does not end with a CROSS-REVIEW-RESULT line)']);
  }, E2E_TIMEOUT);

  test('a codex timeout stops the chain: agy never runs, the snapshot is removed', () => {
    const s = setup(['codex', 'agy']);
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'sleep', FAKE_AGY: 'ok:1' }, 2_000)).toBe(5);
    expect(s.out).toEqual(['PR marker: Cross-review: failed (author: claude; codex: timeout after 15 min)']);
    expect(s.calls('codex').map((c) => c.kind)).toEqual(['review']);
    expect(s.called('agy')).toBe(false);
    expect(s.worktrees()).toEqual([`worktree ${s.toplevel}`]);
  }, E2E_TIMEOUT);

  test('every reviewer fails: exit 5 with each reason in chain order', () => {
    const s = setup(['agy']);
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_AGY: 'jetski' })).toBe(5);
    expect(s.out).toEqual(['PR marker: Cross-review: failed (author: claude; codex: not installed; agy: output does not end with a CROSS-REVIEW-RESULT line)']);
  }, E2E_TIMEOUT);
});

describe('crossReview: refusals before any reviewer runs', () => {
  test('a nested run is refused with 3, before the arguments are read', () => {
    const s = setup(['codex']);
    expect(s.run([], { CROSS_REVIEW_ACTIVE: '1', FAKE_CODEX: 'ok:0' })).toBe(3);
    expect([s.out, s.err]).toEqual([[], ['cross-review: refusing to run inside a cross-review (CROSS_REVIEW_ACTIVE=1)']]);
  }, E2E_TIMEOUT);

  test('a usage error is 2 and prints the usage', () => {
    const s = setup(['codex']);
    expect(s.run(['--base', 'main'])).toBe(2);
    expect(s.err).toEqual([
      'cross-review: --author claude|codex|agy (or DETENT_AUTHOR) is required: the author cannot be detected\n'
      + 'Usage: npx -y @ysilvestrov/detent cross-review --author claude|codex|agy [--reviewer <id>] [--base <ref> | --spec <file>] [--model <id>]',
    ]);
  }, E2E_TIMEOUT);

  test('a dirty tree is refused with 2', () => {
    const s = setup(['codex']);
    writeFileSync(join(s.repo, 'scratch.txt'), 'x\n');
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect([s.out, s.err]).toEqual([[], ['cross-review: working tree is dirty — commit first; the review is pinned to a SHA']]);
    expect(s.called('codex')).toBe(false);
  }, E2E_TIMEOUT);

  test('an empty diff is refused with 2', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'claude', '--base', 'HEAD'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: empty diff against the base — nothing to review']);
    expect(s.called('codex')).toBe(false);
  }, E2E_TIMEOUT);

  test('a base git cannot resolve is a usage error, not a failed review', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'claude', '--base', 'origin/mian'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.out).toEqual([]);
    expect(s.err[0]?.startsWith('cross-review: git diff origin/mian...')).toBe(true);
  }, E2E_TIMEOUT);

  test('--spec outside specsDir is refused with 2', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'claude', '--spec', 'notes/x.md'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: --spec must name a .md file under docs/specs/<YYYY-MM>/, got "notes/x.md"']);
  }, E2E_TIMEOUT);

  test('a spec that is not in HEAD is refused with 2', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'claude', '--spec', 'docs/specs/2026-11/missing.md'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: the spec is not committed at HEAD — commit it first; the review is pinned to a SHA']);
  }, E2E_TIMEOUT);

  test('an unknown placeholder in a .detent/prompts override is refused with 2', () => {
    const s = setup(['codex']);
    commitFile(s.repo, s.env, '.detent/prompts/review-diff.md', 'Review {{project}} for {{nope}}.\n', 'chore: prompt');
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: unfilled placeholder {{nope}}']);
    expect(s.called('codex')).toBe(false);
  }, E2E_TIMEOUT);

  test('a .detent/prompts override is what the reviewer gets', () => {
    const s = setup(['codex']);
    commitFile(s.repo, s.env, '.detent/prompts/review-diff.md', 'Review {{project}} at {{sha}}.\n', 'chore: prompt');
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:0' })).toBe(0);
    expect(s.calls('codex')[0]?.promptHead).toBe(`Review acme at ${s.sha7()}.`);
  }, E2E_TIMEOUT);

  test('a broken detent.json is a config error, 2', () => {
    const s = setup(['codex']);
    commitFile(s.repo, s.env, 'detent.json', '{ "reviewers": ["gemini"] }\n', 'chore: config');
    expect(s.run(['--author', 'claude', '--base', 'main'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: detent.json: unknown reviewer "gemini" in "reviewers" (expected claude|codex|agy)']);
  }, E2E_TIMEOUT);

  test('an explicit reviewer of the author\'s family is refused with 2', () => {
    const s = setup(['codex']);
    expect(s.run(['--author', 'codex', '--reviewer', 'codex', '--base', 'main'], { FAKE_CODEX: 'ok:0' })).toBe(2);
    expect(s.err).toEqual(['cross-review: --reviewer codex: same family as the author (openai)']);
  }, E2E_TIMEOUT);
});
