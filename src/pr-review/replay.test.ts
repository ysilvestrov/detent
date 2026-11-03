import { describe, expect, it } from 'vitest';
import { PROVIDERS } from './providers.js';
import { ensureHeadCommit, formatContextBudget, resolveReplayArgs, resolveReplayBase, stageExtraBody } from './replay.js';

describe('stageExtraBody', () => {
  it('pins OpenRouter to the named executors and forbids fallbacks', () => {
    expect(stageExtraBody({ provider: PROVIDERS.openrouter, model: 'm', only: 'openai,azure', cacheOff: false, cacheOffModels: undefined })).toEqual({
      provider: { only: ['openai', 'azure'], allow_fallbacks: false, require_parameters: true },
    });
  });

  it('treats a blank pin as no pin', () => {
    expect(stageExtraBody({ provider: PROVIDERS.openrouter, model: 'm', only: ' ', cacheOff: false, cacheOffModels: undefined })).toEqual({
      provider: { require_parameters: true },
    });
  });

  it('turns cache writes off for a model on the list', () => {
    expect(
      stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.6-sol', only: undefined, cacheOff: true, cacheOffModels: 'gpt-5.6-sol, gpt-6.1-sol' }),
    ).toEqual({ prompt_cache_options: { mode: 'explicit' } });
  });

  it('combines the pin and the cache switch', () => {
    expect(stageExtraBody({ provider: PROVIDERS.openrouter, model: 'gpt-5.6-sol', only: 'azure', cacheOff: true, cacheOffModels: 'gpt-5.6-sol' })).toEqual({
      provider: { only: ['azure'], allow_fallbacks: false, require_parameters: true },
      prompt_cache_options: { mode: 'explicit' },
    });
  });

  it('leaves a model that is not on the list alone', () => {
    expect(stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.5', only: undefined, cacheOff: true, cacheOffModels: 'gpt-5.6-sol' })).toBeUndefined();
  });

  it('turns nothing off when the list is not set', () => {
    expect(stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.6-sol', only: undefined, cacheOff: true, cacheOffModels: undefined })).toBeUndefined();
  });
});

describe('resolveReplayArgs', () => {
  it('reads a bare PR number', () => {
    expect(resolveReplayArgs(['418'])).toEqual({ pr: '418' });
  });

  it('takes --base, --head and --provider in any order around the PR number', () => {
    expect(resolveReplayArgs(['--head', 'deadbee', '418', '--base', 'abc123', '--provider', 'openrouter'])).toEqual({
      pr: '418',
      explicitBase: 'abc123',
      headOverride: 'deadbee',
      provider: 'openrouter',
    });
  });

  it('rejects --head with no value rather than silently replaying the merged head', () => {
    expect(() => resolveReplayArgs(['418', '--head'])).toThrow('--head needs a commit sha');
  });

  it('rejects --base with no value', () => {
    expect(() => resolveReplayArgs(['418', '--base', '--head', 'x'])).toThrow('--base needs a commit sha');
  });

  it('rejects an empty --head, as an empty shell variable gives', () => {
    expect(() => resolveReplayArgs(['418', '--head', ''])).toThrow('--head needs a commit sha');
  });

  it('rejects an empty --base', () => {
    expect(() => resolveReplayArgs(['418', '--base', ''])).toThrow('--base needs a commit sha');
  });

  it('rejects a missing PR number', () => {
    expect(() => resolveReplayArgs([])).toThrow('--replay needs a PR number');
  });

  it('rejects a PR number that is not a number', () => {
    expect(() => resolveReplayArgs(['abc'])).toThrow('PR number');
  });

  it('rejects an unrecognised --flag instead of silently treating it as a positional', () => {
    expect(() => resolveReplayArgs(['418', '--head=deadbee'])).toThrow('unrecognised option: --head=deadbee');
  });

  it('rejects a second positional: the base is a flag now', () => {
    expect(() => resolveReplayArgs(['418', 'abc123'])).toThrow('unexpected argument: abc123');
  });

  it('lets the last --head win', () => {
    expect(resolveReplayArgs(['418', '--head', 'first', '--head', 'second'])).toEqual({ pr: '418', headOverride: 'second' });
  });

  it('names the providers when --provider is not one of them', () => {
    expect(() => resolveReplayArgs(['418', '--provider', 'x'])).toThrow('openai|anthropic|openrouter');
  });

  it('takes --record with a file path', () => {
    expect(resolveReplayArgs(['418', '--record', 'r.jsonl'])).toEqual({ pr: '418', record: 'r.jsonl' });
  });

  it('rejects --record with no path', () => {
    expect(() => resolveReplayArgs(['418', '--record'])).toThrow('--record needs a file path');
  });

  it('takes --context-only, which has no value', () => {
    expect(resolveReplayArgs(['418', '--context-only'])).toEqual({ pr: '418', contextOnly: true });
  });

  it('rejects --context-only together with --record', () => {
    expect(() => resolveReplayArgs(['418', '--context-only', '--record', 'r'])).toThrow(
      '--context-only cannot be combined with --record',
    );
  });

  it('takes --find-only with --save-findings', () => {
    expect(resolveReplayArgs(['418', '--find-only', '--save-findings', 'f.json'])).toEqual({
      pr: '418',
      findOnly: true,
      saveFindings: 'f.json',
    });
  });

  it('rejects --find-only without --save-findings', () => {
    expect(() => resolveReplayArgs(['418', '--find-only'])).toThrow('--find-only needs --save-findings');
  });

  it('rejects --save-findings without --find-only', () => {
    expect(() => resolveReplayArgs(['418', '--save-findings', 'f.json'])).toThrow('--find-only needs --save-findings');
  });

  it('rejects --save-findings with no path', () => {
    expect(() => resolveReplayArgs(['418', '--find-only', '--save-findings'])).toThrow('--save-findings needs a file path');
  });

  it('takes --verify-from with a file path', () => {
    expect(resolveReplayArgs(['418', '--verify-from', 'f.json'])).toEqual({ pr: '418', verifyFrom: 'f.json' });
  });

  it.each([['--find-only'], ['--head', 'abc'], ['--base', 'abc']])('rejects --verify-from together with %s', (...flag) => {
    expect(() => resolveReplayArgs(['418', '--verify-from', 'f.json', ...flag])).toThrow(
      '--verify-from takes the head and the base from its file',
    );
  });

  it.each([
    ['--find-only', ['--find-only']],
    ['--save-findings', ['--save-findings', 'f.json']],
    ['--verify-from', ['--verify-from', 'f.json']],
  ])('rejects --context-only together with %s', (flag, extra) => {
    expect(() => resolveReplayArgs(['418', '--context-only', ...extra])).toThrow(
      `--context-only cannot be combined with ${flag}`,
    );
  });
});

describe('formatContextBudget', () => {
  it('names the files sent as diff only', () => {
    expect(formatContextBudget(['a.test.ts', 'b.test.ts'])).toBe(
      'Context budget: 2 file(s) sent as diff only: a.test.ts, b.test.ts',
    );
  });

  it('says so when every file went in whole', () => {
    expect(formatContextBudget([])).toBe('Context budget: 0 file(s) sent as diff only.');
  });
});

describe('resolveReplayBase', () => {
  it('uses the merge-base with the PR base branch by default', () => {
    const base = resolveReplayBase({
      explicit: undefined,
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: (a, b) => `merge-base(${a},${b})`,
    });
    expect(base).toBe('merge-base(refs/remotes/origin/main,head-sha)');
  });

  it('uses an explicit base verbatim so an incremental push can be replayed', () => {
    const base = resolveReplayBase({
      explicit: 'abc123',
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: () => 'should-not-be-called',
    });
    expect(base).toBe('abc123');
  });
});

describe('ensureHeadCommit', () => {
  const spy = () => {
    const calls: string[] = [];
    return { calls, fn: (m: string) => calls.push(m) };
  };

  it('does nothing when the head commit is already local', () => {
    const fetched = spy();
    const log = spy();
    ensureHeadCommit({ pr: '352', head: 'abc123', hasCommit: () => true, fetchHead: () => fetched.fn('fetch'), log: log.fn });
    expect(fetched.calls).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it('fetches the PR head when the object is missing and says so', () => {
    const log = spy();
    let fetches = 0;
    ensureHeadCommit({
      pr: '352',
      head: 'abc123',
      hasCommit: () => fetches > 0,
      fetchHead: () => {
        fetches += 1;
      },
      log: log.fn,
    });
    expect(fetches).toBe(1);
    expect(log.calls.join('\n')).toContain('pull/352/head');
  });

  it('fails loudly when the fetch does not produce the head commit', () => {
    expect(() =>
      ensureHeadCommit({ pr: '352', head: 'abc123', hasCommit: () => false, fetchHead: () => undefined, log: () => undefined }),
    ).toThrow(/abc123/);
  });

  it('reports the failing fetch instead of a bare git error', () => {
    expect(() =>
      ensureHeadCommit({
        pr: '352',
        head: 'abc123',
        hasCommit: () => false,
        fetchHead: () => {
          throw new Error('fatal: could not read from remote');
        },
        log: () => undefined,
      }),
    ).toThrow(/pull\/352\/head/);
  });
});
