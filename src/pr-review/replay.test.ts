import { describe, expect, it } from 'vitest';
import { ensureHeadCommit, resolveReplayArgs, resolveReplayBase } from './replay.js';

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
