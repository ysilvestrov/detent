import { describe, test, expect } from 'vitest';
import { parseInstallArgs } from './args.js';

describe('parseInstallArgs — targets', () => {
  test('no flags: both targets, not a dry run, no Superpowers override', () => {
    expect(parseInstallArgs([])).toEqual({ ok: true, opts: { targets: ['claude', 'agents'], dryRun: false } });
  });
  test('--claude alone', () => {
    expect(parseInstallArgs(['--claude'])).toEqual({ ok: true, opts: { targets: ['claude'], dryRun: false } });
  });
  test('--agents alone', () => {
    expect(parseInstallArgs(['--agents'])).toEqual({ ok: true, opts: { targets: ['agents'], dryRun: false } });
  });
  test('both flags in reverse order give the fixed order', () => {
    expect(parseInstallArgs(['--agents', '--claude'])).toEqual({ ok: true, opts: { targets: ['claude', 'agents'], dryRun: false } });
  });
  test('a repeated target flag counts once', () => {
    expect(parseInstallArgs(['--claude', '--claude'])).toEqual({ ok: true, opts: { targets: ['claude'], dryRun: false } });
  });
});

describe('parseInstallArgs — --dry-run and --superpowers', () => {
  test('--dry-run', () => {
    expect(parseInstallArgs(['--dry-run'])).toEqual({ ok: true, opts: { targets: ['claude', 'agents'], dryRun: true } });
  });
  test('--superpowers yes', () => {
    expect(parseInstallArgs(['--superpowers', 'yes'])).toEqual({ ok: true, opts: { targets: ['claude', 'agents'], dryRun: false, superpowers: 'yes' } });
  });
  test('--superpowers no with a target and --dry-run', () => {
    expect(parseInstallArgs(['--agents', '--superpowers', 'no', '--dry-run'])).toEqual({
      ok: true, opts: { targets: ['agents'], dryRun: true, superpowers: 'no' },
    });
  });
  test('a repeated --superpowers keeps its last value', () => {
    expect(parseInstallArgs(['--superpowers', 'yes', '--superpowers', 'no'])).toEqual({
      ok: true, opts: { targets: ['claude', 'agents'], dryRun: false, superpowers: 'no' },
    });
  });
});

describe('parseInstallArgs — errors', () => {
  test('an unknown flag', () => {
    expect(parseInstallArgs(['--force'])).toEqual({ ok: false, error: 'unknown argument "--force"' });
  });
  test('a positional argument', () => {
    expect(parseInstallArgs(['claude'])).toEqual({ ok: false, error: 'unknown argument "claude"' });
  });
  test('the = form is not a flag', () => {
    expect(parseInstallArgs(['--superpowers=yes'])).toEqual({ ok: false, error: 'unknown argument "--superpowers=yes"' });
  });
  test('--superpowers at the end without a value', () => {
    expect(parseInstallArgs(['--superpowers'])).toEqual({ ok: false, error: '--superpowers needs a value: yes|no' });
  });
  test('--superpowers followed by a flag', () => {
    expect(parseInstallArgs(['--superpowers', '--claude'])).toEqual({ ok: false, error: '--superpowers needs a value: yes|no' });
  });
  test('--superpowers with an empty value', () => {
    expect(parseInstallArgs(['--superpowers', ''])).toEqual({ ok: false, error: '--superpowers needs a value: yes|no' });
  });
  test('--superpowers with an unknown value', () => {
    expect(parseInstallArgs(['--superpowers', 'true'])).toEqual({ ok: false, error: 'unknown --superpowers value "true" (expected yes|no)' });
  });
  test('the value is case-sensitive', () => {
    expect(parseInstallArgs(['--superpowers', 'Yes'])).toEqual({ ok: false, error: 'unknown --superpowers value "Yes" (expected yes|no)' });
  });
});
