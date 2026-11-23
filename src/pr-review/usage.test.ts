import { describe, it, expect } from 'vitest';
import {
  EMPTY_USAGE,
  addUsage,
  costUsd,
  formatCostLine,
  formatTokens,
  parseUsage,
  PRICES,
  PRICES_CHECKED_ON,
  PRICE_CHANGES,
  priceAt,
} from './usage.js';

/** Inside gpt-5.6-sol's promotion, so its promo row applies. */
const PROMO = new Date('2026-11-23T00:00:00.000Z');

describe('parseUsage', () => {
  it('reads the OpenAI usage block including cached and reasoning details', () => {
    const u = parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 512 },
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(u).toEqual({
      calls: 1,
      promptTokens: 1000,
      cachedTokens: 512,
      completionTokens: 200,
      reasoningTokens: 150,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 1000,
    });
  });

  it('counts the call even when the API sends no usage block at all', () => {
    expect(parseUsage(undefined)).toEqual({
      calls: 1,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 0,
    });
  });

  it('ignores non-numeric junk instead of producing NaN totals', () => {
    const u = parseUsage({ prompt_tokens: 'lots', completion_tokens: 7 });
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(7);
  });
});

describe('addUsage', () => {
  it('sums every field across stages', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1, cacheWriteTokens: 0, reportedUsd: null, maxPromptTokens: 10 };
    const b = { calls: 2, promptTokens: 40, cachedTokens: 0, completionTokens: 5, reasoningTokens: 4, cacheWriteTokens: 0, reportedUsd: null, maxPromptTokens: 25 };
    expect(addUsage(a, b)).toEqual({
      calls: 3,
      promptTokens: 50,
      cachedTokens: 2,
      completionTokens: 8,
      reasoningTokens: 5,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 25,
    });
  });

  it('keeps the largest single call, not a sum, whichever side it is on', () => {
    const small = { ...EMPTY_USAGE, calls: 1, promptTokens: 300_000, maxPromptTokens: 100_000 };
    const big = { ...EMPTY_USAGE, calls: 1, promptTokens: 280_000, maxPromptTokens: 280_000 };
    expect(addUsage(small, big).maxPromptTokens).toBe(280_000);
    expect(addUsage(big, small).maxPromptTokens).toBe(280_000);
  });

  it('is the identity on EMPTY_USAGE', () => {
    const a = { calls: 1, promptTokens: 10, cachedTokens: 2, completionTokens: 3, reasoningTokens: 1, cacheWriteTokens: 0, reportedUsd: null, maxPromptTokens: 10 };
    expect(addUsage(EMPTY_USAGE, a)).toEqual(a);
  });
});

describe('costUsd', () => {
  it('bills uncached input, cached input and output at their own rates', () => {
    // gpt-5.5: $5/M input, $0.50/M cached input, $30/M output.
    const cost = costUsd('gpt-5.5', {
      calls: 1,
      promptTokens: 200_000,
      cachedTokens: 80_000,
      completionTokens: 20_000,
      reasoningTokens: 12_000,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 200_000,
    });
    // 120k uncached * $5/M = 0.60; 80k cached * $0.50/M = 0.04; 20k out * $30/M = 0.60
    expect(cost).toBeCloseTo(1.24, 6);
  });

  it('does not bill reasoning tokens twice — they are already inside completion_tokens', () => {
    const withReasoning = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 900,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 0,
    });
    const without = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 0,
    });
    expect(withReasoning).toBe(without);
  });

  it('returns null for a model with no verified price rather than a wrong number', () => {
    // Real usage, not EMPTY_USAGE: a stage that never called anything costs 0
    // at any model, so an empty one would pass this test without testing it.
    expect(
      costUsd('gpt-9-imaginary', {
        calls: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: null,
        maxPromptTokens: 1000,
      }),
    ).toBeNull();
  });

  it('carries the date its prices were last checked', () => {
    expect(PRICES['gpt-5.5']).toEqual({ input: 5, cachedInput: 0.5, output: 30, flatUpTo: 272_000 });
    expect(PRICES_CHECKED_ON).toBe('2026-11-23');
  });
});

describe('dated price changes', () => {
  const usage = { ...EMPTY_USAGE, calls: 1, promptTokens: 100_000, completionTokens: 10_000, maxPromptTokens: 100_000, reportedUsd: null };

  it('bills gpt-5.6-sol at its promo price just before the change', () => {
    // 100k * $4/M + 10k * $20/M
    expect(costUsd('gpt-5.6-sol', usage, new Date('2026-11-30T09:59:59.999Z'))).toBeCloseTo(0.6, 6);
  });

  it('bills gpt-5.6-sol at its list price from the change on', () => {
    // 100k * $5/M + 10k * $30/M
    expect(costUsd('gpt-5.6-sol', usage, new Date('2026-11-30T10:00:00.000Z'))).toBeCloseTo(0.8, 6);
  });

  it('dates the gpt-5.6-sol change at the earliest midnight of December 1 anywhere', () => {
    expect(PRICE_CHANGES['gpt-5.6-sol']).toEqual([
      { from: '2026-11-30T10:00:00Z', price: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30, flatUpTo: 272_000 } },
    ]);
  });

  it('keeps every model\'s changes in ascending order', () => {
    const unordered = Object.entries(PRICE_CHANGES).filter(([, changes]) =>
      changes.some((c, i) => i > 0 && Date.parse(changes[i - 1]!.from) >= Date.parse(c.from)),
    );
    expect(unordered).toEqual([]);
  });

  it('returns the base row for a model with no change', () => {
    expect(priceAt('gpt-5.5', new Date('2027-01-01T00:00:00Z'))).toBe(PRICES['gpt-5.5']);
  });

  it('returns nothing for a model with no row', () => {
    expect(priceAt('gpt-9-imaginary', PROMO)).toBeUndefined();
  });
});

describe('the long-context tier', () => {
  const call = (promptTokens: number) => ({ ...EMPTY_USAGE, calls: 1, promptTokens, maxPromptTokens: promptTokens, reportedUsd: null });

  it('prices a call of exactly 272 000 input tokens on the flat row', () => {
    // 272k * $5/M
    expect(costUsd('gpt-5.5', call(272_000))).toBeCloseTo(1.36, 6);
  });

  it('leaves a call over 272 000 input tokens unpriced, because the row does not cover it', () => {
    expect(costUsd('gpt-5.5', call(272_001))).toBeNull();
  });

  it('judges by the largest call, not by the stage\'s total', () => {
    // Two 150k calls sum to 300k but neither crosses the tier: 300k * $5/M.
    expect(costUsd('gpt-5.5', addUsage(call(150_000), call(150_000)))).toBeCloseTo(1.5, 6);
  });

  it('lets the provider\'s own figure win over the tier', () => {
    expect(costUsd('gpt-5.5', { ...call(400_000), reportedUsd: 3.21 })).toBe(3.21);
  });

  it('prices a usage that never recorded its largest call on the flat row', () => {
    expect(costUsd('gpt-5.5', { ...call(400_000), maxPromptTokens: 0 })).toBeCloseTo(2, 6);
  });

  it('reads the largest call from the usage block', () => {
    expect(parseUsage({ prompt_tokens: 300_000 }).maxPromptTokens).toBe(300_000);
  });

  it('marks the rows whose tier was read on 2026-11-23', () => {
    const tiered = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-sol'].map((m) => [m, PRICES[m]?.flatUpTo]);
    expect(tiered).toEqual([
      ['gpt-5.5', 272_000],
      ['gpt-5.6-sol', 272_000],
      ['gpt-6.1-sol', 272_000],
      ['gpt-6.1-terra', 272_000],
      ['gpt-6.2-sol', 272_000],
    ]);
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands to one decimal and leaves small counts alone', () => {
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatCostLine', () => {
  const find = { calls: 1, promptTokens: 12_300, cachedTokens: 0, completionTokens: 3100, reasoningTokens: 1900, cacheWriteTokens: 0, reportedUsd: null, maxPromptTokens: 12_300 };
  const verify = { calls: 2, promptTokens: 8000, cachedTokens: 0, completionTokens: 900, reasoningTokens: 0, cacheWriteTokens: 0, reportedUsd: null, maxPromptTokens: 4000 };

  it('reports both stages, this run and the PR total', () => {
    const line = formatCostLine({ find, verify, runUsd: 0.07, totalUsd: 0.21, unpriced: 0 });
    expect(line).toBe(
      'find 1 call 12.3k→3.1k (1.9k reasoning) · verify 2 calls 8.0k→900 · this run $0.07 · PR total $0.21',
    );
  });

  it('says so plainly when the find pass was skipped', () => {
    const line = formatCostLine({ find: EMPTY_USAGE, verify, runUsd: 0.02, totalUsd: 0.23, unpriced: 0 });
    expect(line).toContain('find skipped');
  });

  it('marks the total as a lower bound when some runs could not be priced', () => {
    const line = formatCostLine({ find, verify, runUsd: null, totalUsd: 0.21, unpriced: 2 });
    expect(line).toContain('this run — (unpriced model)');
    expect(line).toContain('PR total $0.21+');
  });
});

describe('costUsd — a stage that made no calls', () => {
  it('costs nothing even at a model with no verified price', () => {
    // Zero tokens cost zero dollars whatever the rates are; returning null here
    // would mark a whole run unpriced because a skipped stage had no price.
    expect(costUsd('some-unpriced-model', EMPTY_USAGE)).toBe(0);
    expect(costUsd('gpt-5.5', EMPTY_USAGE)).toBe(0);
  });

  it('still refuses to price real usage at an unknown model', () => {
    expect(costUsd('some-unpriced-model', { ...EMPTY_USAGE, calls: 1, promptTokens: 10, reportedUsd: null })).toBeNull();
  });
});

describe('costUsd — the zero-cost shortcut means "nothing happened at all"', () => {
  it('still prices tokens that arrived without a call count', () => {
    // The guard exists for a stage that never ran; money lives in the token
    // fields, so an inconsistent usage must be priced, never silently zeroed.
    const usd = costUsd('gpt-5.5', {
      calls: 0, promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 1000,
    });
    expect(usd).toBeGreaterThan(0);
  });

  it('prices cached input tokens, which are billable on their own', () => {
    const usd = costUsd('gpt-5.5', {
      calls: 1, promptTokens: 0, cachedTokens: 1000, completionTokens: 0, reasoningTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 0,
    });
    expect(usd).toBeGreaterThan(0);
  });

  it('admits a call on an unpriced model even when the API sent no usage block', () => {
    // parseUsage(undefined) counts the call with zero tokens. The dollars are
    // unknown, not zero: reporting $0 would drop the `+` lower-bound marker and
    // claim a precision we do not have.
    expect(costUsd('some-unpriced-model', parseUsage(undefined))).toBeNull();
  });
});

describe('costUsd — a call whose usage block never arrived', () => {
  it('is unknown cost, not zero, even at a priced model', () => {
    // A completion always consumed tokens; if the API did not tell us how many,
    // printing $0.00 claims a precision we do not have. Unknown is admitted the
    // same way an unpriced model is: no dollars, and the PR total marked `+`.
    expect(costUsd('gpt-5.5', parseUsage(undefined))).toBeNull();
  });
});

describe('costUsd: cache writes', () => {
  const usage = { calls: 1, promptTokens: 200_000, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, reportedUsd: null, maxPromptTokens: 200_000 };

  it('bills nothing extra when nothing was written', () => {
    expect(costUsd('gpt-5.6-sol', usage, PROMO)).toBeCloseTo(0.8, 6);
  });

  it('bills every token at the write tariff when all of them were written', () => {
    expect(costUsd('gpt-5.6-sol', { ...usage, cacheWriteTokens: 200_000 }, PROMO)).toBeCloseTo(1, 6);
  });

  it('splits plain, cached and written input', () => {
    // 100k plain * $4/M + 50k cached * $0.40/M + 50k written * $5/M
    expect(costUsd('gpt-5.6-sol', { ...usage, cachedTokens: 50_000, cacheWriteTokens: 50_000 }, PROMO)).toBeCloseTo(0.67, 6);
  });

  it('bills a write at the input price on a model with no write tariff', () => {
    expect(costUsd('gpt-5.5', { ...usage, cacheWriteTokens: 200_000 })).toBeCloseTo(1, 6);
  });

  it('bills a cached token at the input price on a model with no cached price', () => {
    expect(costUsd('claude-sonnet-5-5', { ...usage, cachedTokens: 200_000 })).toBeCloseTo(0.4, 6);
  });

  it('leaves claude-haiku-5-5 unpriced, because its tier over 100k tokens has no row', () => {
    expect(costUsd('claude-haiku-5-5', parseUsage({ prompt_tokens: 110_000, completion_tokens: 1000 }))).toBeNull();
  });

  it('reads the write counter from the usage block', () => {
    expect(parseUsage({ prompt_tokens: 18649, prompt_tokens_details: { cache_write_tokens: 18646 } }).cacheWriteTokens).toBe(18646);
  });

  it('adds writes across stages', () => {
    expect(addUsage({ ...usage, cacheWriteTokens: 3 }, { ...usage, cacheWriteTokens: 4 }).cacheWriteTokens).toBe(7);
  });
});

describe('costUsd: usage.cost', () => {
  const priced = { prompt_tokens: 1000, completion_tokens: 10, cost: 0.1234 };

  it('prefers the figure in the response to the table', () => {
    expect(costUsd('gpt-5.5', parseUsage(priced))).toBe(0.1234);
  });

  it('prices a model the table does not know', () => {
    expect(costUsd('vendor/unlisted', parseUsage(priced))).toBe(0.1234);
  });

  it('falls back to the table without the figure', () => {
    expect(costUsd('gpt-5.5', parseUsage({ prompt_tokens: 200_000 }))).toBeCloseTo(1, 6);
  });

  it.each([['a string', '0.12'], ['a negative number', -1], ['null', null]])('ignores %s', (_name, cost) => {
    expect(parseUsage({ prompt_tokens: 1, cost }).reportedUsd).toBeNull();
  });

  it('keeps a reported zero as a price', () => {
    expect(costUsd('vendor/free', parseUsage({ prompt_tokens: 10, cost: 0 }))).toBe(0);
  });

  it('leaves zero tokens unpriced even with a figure', () => {
    expect(costUsd('gpt-5.5', parseUsage({ cost: 0.5 }))).toBeNull();
  });

  it('sums the figures of several calls', () => {
    const sum = addUsage(addUsage(EMPTY_USAGE, parseUsage(priced)), parseUsage(priced));
    expect(sum.reportedUsd).toBeCloseTo(0.2468, 6);
  });

  it('drops the figure when one call did not report it, so the table prices the whole stage', () => {
    const sum = addUsage(parseUsage(priced), parseUsage({ prompt_tokens: 1000 }));
    expect(sum.reportedUsd).toBeNull();
    expect(costUsd('vendor/unlisted', sum)).toBeNull();
  });
});

describe('gpt-5.6 tiers', () => {
  it('prices every tier the reviewer might be pointed at', () => {
    expect(PRICES['gpt-5.6-luna']).toEqual({ input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 });
    expect(PRICES['gpt-5.6-terra']).toEqual({ input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 });
    expect(PRICES['gpt-5.6-sol']).toEqual({ input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20, flatUpTo: 272_000 });
  });

  it('bills a luna find pass at luna rates, not gpt-5.5 rates', () => {
    const usage = {
      calls: 1,
      promptTokens: 200_000,
      cachedTokens: 0,
      completionTokens: 20_000,
      reasoningTokens: 18_000,
      cacheWriteTokens: 0,
      reportedUsd: null,
      maxPromptTokens: 200_000,
    };
    // luna: 200k * $0.20/M + 20k * $1.20/M; gpt-5.5: 200k * $5/M + 20k * $30/M
    expect(costUsd('gpt-5.6-luna', usage)).toBeCloseTo(0.064, 6);
    expect(costUsd('gpt-5.5', usage)).toBeCloseTo(1.6, 6);
  });

  it('prices gpt-6.2-sol as read from the vendor page on 2026-11-23', () => {
    expect(PRICES['gpt-6.2-sol']).toEqual({ input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, flatUpTo: 272_000 });
  });
});
