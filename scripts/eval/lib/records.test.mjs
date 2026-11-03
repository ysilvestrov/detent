import { describe, expect, it } from 'vitest';
import { callUsd, isScorable, parseKeys, parseRecords, scrubKeys, totalSpend } from './records.mjs';

const catalog = {
  candidates: [],
  prices: {
    'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
    'plain-model': { input: 2, output: 10 },
  },
};

describe('parseKeys', () => {
  it('reads export, quotes, comments and blank lines', () => {
    expect(parseKeys('export OPENAI_API_KEY="a"\n\n# c\nANTHROPIC_API_KEY=b\n')).toEqual({
      OPENAI_API_KEY: 'a',
      ANTHROPIC_API_KEY: 'b',
    });
  });
});

describe('parseRecords', () => {
  it('drops a torn last line', () => {
    expect(parseRecords('{"type":"call"}\n{"type":"ru')).toEqual([{ type: 'call' }]);
  });

  it('names the line of a broken line in the middle', () => {
    expect(() => parseRecords('{"ty\n{"type":"call"}\n')).toThrow('line 1');
  });
});

describe('scrubKeys', () => {
  const key = 'sk-or-v1-0123456789abcdefXYZ';

  it('replaces the whole value', () => {
    expect(scrubKeys('x sk-or-v1-0123456789abcdefXYZ y', { K: key })).toEqual({ text: 'x *** y', leaked: true });
  });

  it('replaces the first 16 characters of a cut value', () => {
    expect(scrubKeys('x sk-or-v1-0123456 y', { K: key })).toEqual({ text: 'x *** y', leaked: true });
  });

  it('leaves a shorter start alone', () => {
    expect(scrubKeys('sk-or-v1- y', { K: key })).toEqual({ text: 'sk-or-v1- y', leaked: false });
  });

  it('ignores an empty value', () => {
    expect(scrubKeys('abc', { K: '' })).toEqual({ text: 'abc', leaked: false });
  });
});

describe('callUsd', () => {
  it('takes usage.cost over the table', () => {
    const line = { type: 'call', model: 'gpt-5.6-sol', usage: { cost: 0.2, prompt_tokens: 1000, completion_tokens: 100 } };
    expect(callUsd(line, catalog)).toEqual({ usd: 0.2, source: 'cost' });
  });

  it('prices reads and writes apart from the plain input', () => {
    const line = {
      type: 'call',
      model: 'gpt-5.6-sol',
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } },
    };
    expect(callUsd(line, catalog)).toEqual({ usd: 0.00558, source: 'table' });
  });

  it('prices a write at the input price when the model has no write price', () => {
    const line = {
      type: 'call',
      model: 'plain-model',
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } },
    };
    expect(callUsd(line, catalog)).toEqual({ usd: 0.003, source: 'table' });
  });

  it('prefers requestedModel to model', () => {
    const line = { type: 'call', requestedModel: 'plain-model', model: 'gpt-5.6-sol', usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    expect(callUsd(line, catalog)).toEqual({ usd: 0.003, source: 'table' });
  });

  it('is unpriced without usage', () => {
    expect(callUsd({ type: 'call', model: 'plain-model', usage: null }, catalog)).toEqual({ usd: 0, source: 'unpriced' });
  });

  it('is unpriced for a model outside the catalog', () => {
    const line = { type: 'call', model: 'ghost', usage: { prompt_tokens: 10, completion_tokens: 10 } };
    expect(callUsd(line, catalog)).toEqual({ usd: 0, source: 'unpriced' });
  });

  it('is unpriced for a usage object with no token fields', () => {
    expect(callUsd({ type: 'call', model: 'plain-model', usage: {} }, catalog)).toEqual({ usd: 0, source: 'unpriced' });
  });

  it('is unpriced for a usage object missing the output tokens', () => {
    expect(callUsd({ type: 'call', model: 'plain-model', usage: { prompt_tokens: 10 } }, catalog)).toEqual({ usd: 0, source: 'unpriced' });
  });
});

describe('totalSpend', () => {
  it('stays a number with a call whose usage is empty', () => {
    const lines = [{ type: 'call', model: 'plain-model', usage: {} }, { type: 'manual', usd: 1, reason: 'judge' }];
    expect(totalSpend(lines, catalog)).toEqual({ usd: 1, unpriced: 1 });
  });

  it('counts a manual line with no finite usd as unpriced', () => {
    expect(totalSpend([{ type: 'manual', reason: 'judge' }, { type: 'manual', usd: 'two' }, { type: 'manual', usd: 2 }], catalog)).toEqual({ usd: 2, unpriced: 2 });
  });

  it('counts the calls of a run with no run line, the manual lines and the unpriced calls', () => {
    const lines = [
      { type: 'call', runId: 'a', model: 'plain-model', usage: { prompt_tokens: 250000, completion_tokens: 0 } },
      { type: 'call', runId: 'a', model: 'ghost', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { type: 'call', runId: 'b', model: 'plain-model', usage: { cost: 0.25 } },
      { type: 'manual', usd: 1, reason: 'judge' },
    ];
    expect(totalSpend(lines, catalog)).toEqual({ usd: 1.75, unpriced: 1 });
  });
});

describe('isScorable', () => {
  it('accepts a clean exit', () => {
    expect(isScorable({ exit: 0, error: null })).toBe(true);
  });

  it('rejects an error with exit 0', () => {
    expect(isScorable({ exit: 0, error: 'verify failed' })).toBe(false);
  });

  it('rejects exit 5', () => {
    expect(isScorable({ exit: 5, error: null })).toBe(false);
  });
});
