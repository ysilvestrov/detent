import { describe, expect, it } from 'vitest';
import { anonymize, applyKey } from './anon.mjs';
import { anthropicThinking, cacheFields, median, paidByRoute, paidUsd, productionUsd, summarize } from './summary.mjs';

const catalog = {
  baseline: { label: 'base', findModel: 'gpt-5.6-sol', verifyModel: 'gpt-5.5', route: 'openai' },
  candidates: [
    { label: 'alpha', model: 'vendor/alpha', route: 'openrouter', only: ['host'], tier: 'cheap', price: { input: 1, output: 2 } },
    { label: 'beta', model: 'beta-1', route: 'anthropic', only: null, tier: 'mid', price: { input: 3, output: 15 } },
  ],
  prices: {
    'gpt-5.6-sol': { input: 4, cacheWrite: 5, output: 20 },
    'gpt-5.5': { input: 5, output: 30 },
  },
  corpus: ['344', '348', '352'],
};

const run = (over) => ({
  type: 'run',
  runId: 'r1',
  batch: 2,
  label: 'alpha',
  provider: 'openrouter',
  findModel: 'vendor/alpha',
  verifyModel: null,
  mode: 'find',
  key: '2|find|alpha|418|1',
  pr: '418',
  draw: 1,
  attempt: 1,
  results: [],
  exit: 0,
  error: null,
  ...over,
});

const call = (over) => ({
  type: 'call',
  runId: 'r1',
  stage: 'find',
  key: '2|find|alpha|418|1',
  attempt: 1,
  requestedModel: 'vendor/alpha',
  finishReason: 'stop',
  contentLength: 400,
  usage: { prompt_tokens: 1000, completion_tokens: 100 },
  ...over,
});

const score = (defects, extra = {}) => ({ defects, findings: 4, ...extra });
const noScores = { batches: {}, judges: {} };
const rowOf = (rows, label) => rows.find((r) => r.label === label);

describe('median', () => {
  it('takes the middle of 1, 1, 5', () => {
    expect(median([1, 1, 5])).toBe(1);
  });

  it('averages the two middle values of an even list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('productionUsd', () => {
  const sol = catalog.prices['gpt-5.6-sol'];
  const usage = { prompt_tokens: 1000, completion_tokens: 100 };

  it('reads the input at the write tariff when the cache rule does not apply', () => {
    expect(productionUsd({ firstRunUsage: usage, price: sol, cacheRuleApplies: false })).toBe((1000 * 5 + 100 * 20) / 1e6);
  });

  it('reads the input at the base tariff when the cache rule applies', () => {
    expect(productionUsd({ firstRunUsage: usage, price: sol, cacheRuleApplies: true })).toBe((1000 * 4 + 100 * 20) / 1e6);
  });

  it('reads the input at the base tariff for a model without a write tariff', () => {
    expect(productionUsd({ firstRunUsage: usage, price: { input: 2, output: 10 }, cacheRuleApplies: false })).toBe((1000 * 2 + 100 * 10) / 1e6);
  });
});

describe('summarize: draws', () => {
  const lines = [1, 2, 3].map((draw) => run({ draw }));
  const scores = { batches: { 2: { alpha: { 1: score(['D1']), 2: score(['D2']), 3: score(['D3']) } } }, judges: {} };

  it('takes the median per draw and the union of defects', () => {
    const row = rowOf(summarize({ lines, catalog, scores, cacheRuleApplies: false }), 'alpha');
    expect([row.draws, row.perDraw, row.medianKnown, row.union]).toEqual([3, [1, 1, 1], 1, 3]);
  });

  it('leaves a draw whose run failed out of perDraw but counts its calls as paid', () => {
    const failed = [run({ draw: 1 }), run({ draw: 2, exit: 1, error: 'killed' }), run({ draw: 3 })];
    const calls = [call({ key: '2|find|alpha|418|2', usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.5 } })];
    const row = rowOf(summarize({ lines: [...failed, ...calls], catalog, scores, cacheRuleApplies: false }), 'alpha');
    expect([row.perDraw, row.paidUsd]).toEqual([[1, 1], 0.5]);
  });

  it('leaves a draw without a run line out of perDraw', () => {
    const row = rowOf(summarize({ lines: [run({ draw: 1 })], catalog, scores, cacheRuleApplies: false }), 'alpha');
    expect(row.perDraw).toEqual([1]);
  });

  it('marks draws that differ by two defects unstable', () => {
    const wide = { batches: { 2: { alpha: { 1: score(['D1']), 2: score(['D1', 'D2', 'D3']) } } }, judges: {} };
    const row = rowOf(summarize({ lines: [run({ draw: 1 }), run({ draw: 2 })], catalog, scores: wide, cacheRuleApplies: false }), 'alpha');
    expect(row.unstable).toBe(true);
  });
});

describe('summarize: verify', () => {
  const verifyRun = (results, over = {}) =>
    run({ batch: 7, mode: 'verify', verifyModel: 'gpt-5.5', key: '7|verify|alpha|418|1|gpt-5.5', results, ...over });
  const verdicts = (...names) => names.map((verdict) => ({ verdict }));

  it('counts the share of error verdicts', () => {
    const lines = [verifyRun(verdicts('confirmed', 'error', 'refuted', 'confirmed'))];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').errorShare).toBe(0.25);
  });

  it('averages refuted per scored run', () => {
    const lines = [verifyRun(verdicts('refuted', 'refuted', 'confirmed')), verifyRun(verdicts('confirmed'), { draw: 2 })];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').refutedMean).toBe(1);
  });

  it('is a composite pair until a verify of this find has run', () => {
    const find = [run({})];
    const before = rowOf(summarize({ lines: find, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha');
    const after = rowOf(summarize({ lines: [...find, verifyRun([])], catalog, scores: noScores, cacheRuleApplies: false }), 'alpha');
    expect([before.composite, after.composite]).toEqual([true, false]);
  });

  it('takes the published median from batch 7 and from batch 1 under the judge label', () => {
    const lines = [verifyRun([], { draw: 1 }), verifyRun([], { draw: 2 }), run({ batch: 1, label: 'alpha', mode: 'verify', draw: 3, verifyModel: 'gpt-5.5' })];
    const scores = {
      batches: {
        7: { alpha: { 1: score(['D1', 'D2']), 2: score(['D1', 'D2', 'D3']) } },
        1: { 'alpha@gpt-5.5': { 3: score(['D1']) } },
      },
      judges: {},
    };
    expect(rowOf(summarize({ lines, catalog, scores, cacheRuleApplies: false }), 'alpha').medianPublished).toBe(2);
  });

  it('takes the #930 median from the score that names the PR', () => {
    const lines = [run({ batch: 101, mode: 'whole', pr: '930', draw: 1 }), run({ batch: 101, mode: 'whole', pr: '930', draw: 2 })];
    const scores = { batches: { 101: { alpha: { 1: score(['D1'], { pr: '930' }), 2: score(['D1', 'D2', 'D3'], { pr: '930' }) } } }, judges: {} };
    expect(rowOf(summarize({ lines, catalog, scores, cacheRuleApplies: false }), 'alpha').medianRecall930).toBe(2);
  });

  it('takes the judge consensus of the judge that checked the find', () => {
    const scores = { batches: {}, judges: { 'gpt-5.5': 15 } };
    expect(rowOf(summarize({ lines: [verifyRun([])], catalog, scores, cacheRuleApplies: false }), 'alpha').judgeConsensus).toBe(15);
  });
});

describe('summarize: corpus, broken calls and production price', () => {
  it('sums the corpus classes over the corpus PRs whose runs closed', () => {
    const lines = [
      run({ batch: 103, mode: 'whole', pr: '344', draw: 1 }),
      run({ batch: 103, mode: 'whole', pr: '348', draw: 1 }),
      run({ batch: 103, mode: 'whole', pr: '352', draw: 1, exit: 1, error: 'killed' }),
    ];
    const corpus = (real, falsy) => ({ real, false: falsy, unfalsifiable: 0, published: real + falsy });
    const scores = { batches: { 103: { alpha: { 1: { corpus: { 344: corpus(2, 0), 348: corpus(1, 1), 352: corpus(5, 0) } } } } }, judges: {} };
    expect(rowOf(summarize({ lines, catalog, scores, cacheRuleApplies: false }), 'alpha').corpus).toEqual({
      real: 3,
      false: 1,
      unfalsifiable: 0,
      published: 4,
      prs: 2,
    });
  });

  it('counts an empty answer and a cut one as broken calls', () => {
    const lines = [
      call({ contentLength: 0 }),
      call({ finishReason: 'length' }),
      call({}),
    ];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').brokenCalls).toBe(2);
  });

  it('prices the first draw only, at the route table price, ignoring usage.cost', () => {
    const lines = [
      run({ draw: 1 }),
      run({ draw: 2, key: '2|find|alpha|418|2' }),
      call({ usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 9 } }),
      call({ key: '2|find|alpha|418|2', usage: { prompt_tokens: 5000, completion_tokens: 500 } }),
    ];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').productionUsd).toBe((1000 * 1 + 100 * 2) / 1e6);
  });

  it('adds the verify of the first draw to the find', () => {
    const lines = [
      run({ draw: 1 }),
      run({ batch: 7, mode: 'verify', verifyModel: 'gpt-5.5', key: '7|verify|alpha|418|1|gpt-5.5' }),
      call({}),
      call({ stage: 'verify', key: '7|verify|alpha|418|1|gpt-5.5', requestedModel: 'gpt-5.5', usage: { prompt_tokens: 2000, completion_tokens: 200 } }),
    ];
    const row = rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha');
    expect(row.productionUsd).toBe((1000 * 1 + 100 * 2) / 1e6 + (2000 * 5 + 200 * 30) / 1e6);
  });

  it('names the pair after the find model and the judge', () => {
    const lines = [run({ label: 'base', batch: 1, mode: 'verify', verifyModel: 'gpt-5.5', key: '1|verify|base|418|1|gpt-5.5' })];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'base').pair).toBe('gpt-5.6-sol + gpt-5.5');
  });

  it('leaves out a label that has no line and no score', () => {
    const rows = summarize({ lines: [run({})], catalog, scores: noScores, cacheRuleApplies: false });
    expect(rows.map((r) => r.label)).toEqual(['alpha']);
  });
});

describe('paidUsd and paidByRoute', () => {
  const lines = [
    call({ runId: 'r1', usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.25 } }),
    call({ runId: 'r2', key: '1|verify|base|418|1|gpt-5.5', requestedModel: 'gpt-5.5', usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
    run({ runId: 'r2', label: 'base', provider: 'openai' }),
    { type: 'manual', usd: 1.5, reason: 'x' },
  ];

  it('sums the call lines only', () => {
    expect(paidUsd(lines, catalog)).toBe(0.25 + (1000 * 5 + 100 * 30) / 1e6);
  });

  it('splits the recorded spend by the route of the run and keeps the manual spend apart', () => {
    expect(paidByRoute(lines, catalog)).toEqual({ byRoute: { openrouter: 0.25, openai: (1000 * 5 + 100 * 30) / 1e6 }, manualUsd: 1.5 });
  });
});

describe('anthropicThinking', () => {
  const at = (completion) => ({ contentLength: 400, usage: { completion_tokens: completion } });

  it('is on when two of three calls spend at least twice the visible tokens', () => {
    expect(anthropicThinking([at(200), at(300), at(100)])).toBe(true);
  });

  it('is off when only one of three does', () => {
    expect(anthropicThinking([at(200), at(150), at(100)])).toBe(false);
  });
});

describe('cacheFields', () => {
  it('lists the cache counters the providers reported, with their largest value', () => {
    const calls = [
      { usage: { prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 } } },
      { usage: { prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 7 } } },
      { usage: {} },
    ];
    expect(cacheFields(calls)).toEqual({ cached_tokens: 30, cache_write_tokens: 7 });
  });
});

describe('summarize: what the anonymizer writes', () => {
  it('reads the corpus scores of real anonymize and applyKey output of batch 102', () => {
    const runs = ['344', '348', '352'].map((pr) => run({ batch: 102, mode: 'whole', pr, draw: 1, head: 'h', key: `102|whole|alpha|${pr}|1` }));
    const { items, key } = anonymize({ runs, read: () => ({ kept: [] }), shuffle: (list) => list });
    const grader = Object.fromEntries(items.map((item) => [item.id, { real: 1, false: 0, unfalsifiable: 0, published: 1 }]));
    const scores = { batches: { 102: applyKey(grader, key) }, judges: {} };
    const row = rowOf(summarize({ lines: runs, catalog, scores, cacheRuleApplies: false }), 'alpha');
    expect(row.corpus).toEqual({ real: 3, false: 0, unfalsifiable: 0, published: 3, prs: 3 });
  });
});

describe('summarize: batch 105 is the generic-prompts row', () => {
  const lines = [
    run({ label: 'base', batch: 2, draw: 1, key: '2|find|base|418|1' }),
    run({ label: 'base', batch: 105, mode: 'whole', draw: 1, key: '105|whole|base|418|1' }),
    run({ label: 'base', batch: 105, mode: 'whole', pr: '344', draw: 1, key: '105|whole|base|344|1' }),
    call({ key: '105|whole|base|418|1', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.75 } }),
  ];
  const corpus = { 344: { real: 2, false: 0, unfalsifiable: 0, published: 2 } };
  const scores = {
    batches: { 2: { base: { 1: score(['D1']) } }, 105: { base: { 1: score(['D1', 'D2', 'D3'], { corpus }) } } },
    judges: {},
  };
  const rows = summarize({ lines, catalog, scores, cacheRuleApplies: false });

  it('leaves the baseline row as it is without batch 105', () => {
    const row = rowOf(rows, 'base');
    expect([row.medianPublished, row.corpus.prs, row.paidUsd, row.generic]).toEqual([null, 0, 0, false]);
  });

  it('gives batch 105 its own row', () => {
    const row = rowOf(rows, 'base (generic prompts)');
    expect([row.medianPublished, row.corpus.prs, row.paidUsd, row.generic]).toEqual([3, 1, 0.75, true]);
  });
});

describe('summarize: broken calls', () => {
  it('skips the verify probe of batch 0 and every call of batch 104', () => {
    const lines = [
      call({ key: '0|verify|alpha|688|1|gpt-5.5', stage: 'verify', contentLength: 0 }),
      call({ key: '104|verify|alpha|418|1|judge-x', stage: 'verify', contentLength: 0 }),
      call({ key: '2|find|alpha|418|1', contentLength: 0 }),
      call({ key: '0|find|alpha|895|1', contentLength: 0 }),
    ];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').brokenCalls).toBe(2);
  });
});
