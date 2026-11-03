import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.mjs';

describe('parseArgs', () => {
  it('reads a batch run', () => {
    expect(parseArgs(['--keys', 'k.env', '--batch', '4', '--ceiling', '12.5', '--labels', 'a,b', '--allow-dirty'], '/home/u')).toEqual({
      command: 'batch',
      keys: 'k.env',
      batch: 4,
      ceilingUsd: 12.5,
      labels: ['a', 'b'],
      verifyModel: undefined,
      verifyRoute: undefined,
      judges: undefined,
      repo: join('/home/u', 'projects', 'warsaw-beer-bot'),
      allowDirty: true,
    });
  });

  it('reads the judges as model:route pairs', () => {
    const args = parseArgs(['--keys', 'k', '--batch', '104', '--ceiling', '3', '--judges', 'gpt-5.5:openai,x/y:openrouter'], '/h');
    expect(args.judges).toEqual([{ model: 'gpt-5.5', route: 'openai' }, { model: 'x/y', route: 'openrouter' }]);
  });

  it('reads the other commands', () => {
    expect(parseArgs(['--preflight'], '/h')).toEqual({ command: 'preflight', repo: join('/h', 'projects', 'warsaw-beer-bot') });
    expect(parseArgs(['--endpoints'], '/h')).toEqual({ command: 'endpoints', labels: undefined, excludeHost: undefined });
    expect(parseArgs(['--note-spend', '1.5', '--reason', 'verify-corpus'], '/h')).toEqual({ command: 'note-spend', usd: 1.5, reason: 'verify-corpus' });
  });

  it('reads the retry of --endpoints', () => {
    expect(parseArgs(['--endpoints', '--labels', 'a,b', '--exclude-host', 'alibaba'], '/h')).toEqual({ command: 'endpoints', labels: ['a', 'b'], excludeHost: 'alibaba' });
  });

  it.each([
    [['--batch', '4', '--keys', 'k', '--ceiling', '1', '--detent', '/d', '--out-root', '/o']],
    [['--preflight', '--detent', '/d', '--out-root', '/o']],
    [['--endpoints', '--detent', '/d', '--out-root', '/o']],
    [['--note-spend', '1', '--reason', 'r', '--detent', '/d', '--out-root', '/o']],
  ])('takes the detent path and the output root on %j', (argv) => {
    expect(parseArgs(argv, '/h')).toMatchObject({ detent: '/d', outRoot: '/o' });
  });

  it.each([0, 1, 2, 3, 5, 102, 105])('refuses --labels on batch %i, which ignores them', (batch) => {
    expect(() => parseArgs(['--batch', String(batch), '--keys', 'k', '--ceiling', '1', '--labels', 'a'], '/h')).toThrow(`batch ${batch} ignores --labels`);
  });

  it.each([4, 6, 7, 101, 103, 104, 106])('takes --labels on batch %i', (batch) => {
    expect(parseArgs(['--batch', String(batch), '--keys', 'k', '--ceiling', '1', '--labels', 'a'], '/h').labels).toEqual(['a']);
  });

  it('refuses --exclude-host outside --endpoints', () => {
    expect(() => parseArgs(['--batch', '4', '--keys', 'k', '--ceiling', '1', '--exclude-host', 'x'], '/h')).toThrow('--exclude-host goes with --endpoints');
  });

  it.each([
    [['--batch', 'nope', '--keys', 'k', '--ceiling', '1'], '--batch needs a number'],
    [['--batch', '1', '--ceiling', '1'], '--keys is required'],
    [['--batch', '1', '--keys', 'k'], '--ceiling needs a positive number'],
    [['--batch', '1', '--keys', 'k', '--ceiling', '0'], '--ceiling needs a positive number'],
    [['--batch', '1', '--keys', 'k', '--ceiling', '1', '--judges', 'nocolon'], '--judges needs model:route pairs'],
    [['--batch', '1', '--keys', 'k', '--ceiling', '1', '--judges', 'm:nowhere'], '--judges needs model:route pairs'],
    [['--note-spend', '1'], '--note-spend needs --reason'],
    [['--note-spend', '-1', '--reason', 'x'], '--note-spend needs a number of dollars, zero or more'],
    [['--wat'], 'unrecognised option: --wat'],
    [[], 'nothing to do: pass --batch, --preflight, --endpoints or --note-spend'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv, '/h')).toThrow(message);
  });
});
