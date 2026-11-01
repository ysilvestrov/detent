import { describe, test, expect } from 'vitest';
import { parseCrossReviewArgs } from './args.js';

const NO_AUTHOR = { ok: false, error: '--author claude|codex|agy (or DETENT_AUTHOR) is required: the author cannot be detected' };

describe('parseCrossReviewArgs — author', () => {
  test('empty argv and no DETENT_AUTHOR: the author is required, never guessed', () => {
    expect(parseCrossReviewArgs([], {})).toEqual(NO_AUTHOR);
  });
  test('--author alone is enough; nothing else is defaulted here', () => {
    expect(parseCrossReviewArgs(['--author', 'claude'], {})).toEqual({ ok: true, opts: { author: 'claude' } });
  });
  test('DETENT_AUTHOR stands in for --author', () => {
    expect(parseCrossReviewArgs([], { DETENT_AUTHOR: 'codex' })).toEqual({ ok: true, opts: { author: 'codex' } });
  });
  test('an empty DETENT_AUTHOR counts as absent', () => {
    expect(parseCrossReviewArgs([], { DETENT_AUTHOR: '' })).toEqual(NO_AUTHOR);
  });
  test('the flag wins over the variable', () => {
    expect(parseCrossReviewArgs(['--author', 'agy'], { DETENT_AUTHOR: 'codex' })).toEqual({ ok: true, opts: { author: 'agy' } });
  });
  test('the flag wins over an invalid variable', () => {
    expect(parseCrossReviewArgs(['--author', 'agy'], { DETENT_AUTHOR: 'gpt' })).toEqual({ ok: true, opts: { author: 'agy' } });
  });
  test('an unknown author from the flag is named', () => {
    expect(parseCrossReviewArgs(['--author', 'gemini'], {})).toEqual({ ok: false, error: 'unknown author "gemini" (expected claude|codex|agy)' });
  });
  test('an unknown author from DETENT_AUTHOR is named', () => {
    expect(parseCrossReviewArgs([], { DETENT_AUTHOR: 'Claude' })).toEqual({ ok: false, error: 'unknown author "Claude" (expected claude|codex|agy)' });
  });
  test('an unrelated variable is not the author', () => {
    expect(parseCrossReviewArgs([], { CLAUDECODE: '1' })).toEqual(NO_AUTHOR);
  });
});

describe('parseCrossReviewArgs — flags and values', () => {
  test('every flag is carried as given', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--reviewer', 'codex', '--base', 'origin/dev', '--model', 'gpt-5.5'], {})).toEqual({
      ok: true, opts: { author: 'claude', reviewer: 'codex', base: 'origin/dev', model: 'gpt-5.5' },
    });
  });
  test('--spec is carried as given, without --base', () => {
    expect(parseCrossReviewArgs(['--author', 'codex', '--spec', 'docs\\specs\\2026-11\\x.md'], {})).toEqual({
      ok: true, opts: { author: 'codex', spec: 'docs\\specs\\2026-11\\x.md' },
    });
  });
  test('a repeated flag keeps its last value', () => {
    expect(parseCrossReviewArgs(['--author', 'codex', '--author', 'claude'], {})).toEqual({ ok: true, opts: { author: 'claude' } });
  });
  test('a flag at the end without its value is rejected', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--base'], {})).toEqual({ ok: false, error: '--base needs a value' });
  });
  test('a value that looks like a flag is rejected', () => {
    expect(parseCrossReviewArgs(['--author', '--reviewer', 'codex'], {})).toEqual({ ok: false, error: '--author needs a value' });
  });
  test('an empty value is rejected, so --model "$UNSET" cannot drop a pin', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--reviewer', 'codex', '--model', ''], {})).toEqual({ ok: false, error: '--model needs a value' });
  });
  test('an empty --author is rejected even when DETENT_AUTHOR is set', () => {
    expect(parseCrossReviewArgs(['--author', ''], { DETENT_AUTHOR: 'codex' })).toEqual({ ok: false, error: '--author needs a value' });
  });
  test('a value starting with a single dash is a value', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--base', '-x'], {})).toEqual({ ok: true, opts: { author: 'claude', base: '-x' } });
  });
  test('an unknown flag is rejected', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--fast'], {})).toEqual({ ok: false, error: 'unknown argument "--fast"' });
  });
  test('a positional argument is rejected', () => {
    expect(parseCrossReviewArgs(['claude'], {})).toEqual({ ok: false, error: 'unknown argument "claude"' });
  });
  test('the single-dash form of a flag is unknown', () => {
    expect(parseCrossReviewArgs(['-author', 'claude'], {})).toEqual({ ok: false, error: 'unknown argument "-author"' });
  });
});

describe('parseCrossReviewArgs — combinations', () => {
  test('an unknown reviewer is named', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--reviewer', 'gemini'], {})).toEqual({
      ok: false, error: 'unknown reviewer "gemini" (expected claude|codex|agy)',
    });
  });
  test('--spec with --base is a usage error: a spec review has no base', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--spec', 'a.md', '--base', 'origin/main'], {})).toEqual({
      ok: false, error: '--spec and --base cannot be combined: a spec review has no base',
    });
  });
  test('--model without --reviewer is a usage error: a model belongs to one CLI', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--model', 'gpt-6.1-sol'], {})).toEqual({
      ok: false, error: '--model needs --reviewer: a model id belongs to one reviewer CLI',
    });
  });
  test('a missing author is reported before an unknown reviewer', () => {
    expect(parseCrossReviewArgs(['--reviewer', 'gemini'], {})).toEqual(NO_AUTHOR);
  });
  test('the same id as author and reviewer passes here: selection judges families', () => {
    expect(parseCrossReviewArgs(['--author', 'claude', '--reviewer', 'claude'], {})).toEqual({
      ok: true, opts: { author: 'claude', reviewer: 'claude' },
    });
  });
});
