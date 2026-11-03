import { describe, expect, it } from 'vitest';
import { anonymize, applyKey } from './anon.mjs';
import {
  anthropicCalls,
  anthropicThinking,
  baselineRowOf,
  cacheFields,
  executorVisibility,
  median,
  paidByRoute,
  paidUsd,
  productionUsd,
  readsPerWrite,
  stage2Items,
  summarize,
} from './summary.mjs';

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
  it('skips the verify probe of batch 0, and a batch 104 call with no judge row to go on', () => {
    const lines = [
      call({ key: '0|verify|alpha|688|1|gpt-5.5', stage: 'verify', contentLength: 0 }),
      call({ key: '104|verify|alpha|418|1|judge-x', stage: 'verify', contentLength: 0 }),
      call({ key: '2|find|alpha|418|1', contentLength: 0 }),
      call({ key: '0|find|alpha|895|1', contentLength: 0 }),
    ];
    expect(rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').brokenCalls).toBe(2);
  });
});

describe('summarize: one row is one pair', () => {
  const pairRun = (batch, judge, draw, over = {}) =>
    run({ batch, mode: batch === 106 ? 'whole' : 'verify', verifyModel: judge, draw, key: `${batch}|${batch === 106 ? 'whole' : 'verify'}|alpha|418|${draw}|${judge}`, ...over });
  const draws = (defects) => ({ 1: score(defects), 2: score(defects), 3: score(defects) });
  const lines = [
    ...[1, 2, 3].map((draw) => run({ draw, key: `2|find|alpha|418|${draw}` })),
    ...[1, 2, 3].map((draw) => pairRun(7, 'gpt-5.5', draw)),
    ...[1, 2, 3].map((draw) => pairRun(106, 'judge-x', draw)),
  ];
  const scores = {
    batches: { 2: { alpha: draws(['D1', 'D2', 'D3']) }, 7: { alpha: draws(['D1', 'D2']) }, 106: { 'alpha@judge-x': draws(['D1', 'D2', 'D3', 'D4', 'D5']) } },
    judges: { 'gpt-5.5': 15, 'judge-x': 12 },
  };
  const rows = summarize({ lines, catalog, scores, cacheRuleApplies: false });

  it('gives each judge of a finder its own row, with its own published median and consensus', () => {
    expect(rows.map((r) => [r.label, r.judge, r.pair, r.medianPublished, r.judgeConsensus, r.composite])).toEqual([
      ['alpha', 'gpt-5.5', 'vendor/alpha + gpt-5.5', 2, 15, false],
      ['alpha', 'judge-x', 'vendor/alpha + judge-x', 5, 12, false],
    ]);
  });

  it('repeats the find-stage fields of the finder on each of its rows', () => {
    expect(rows.map((r) => [r.draws, r.perDraw, r.medianKnown, r.union, r.findDefects])).toEqual([
      [3, [3, 3, 3], 3, 3, ['D1', 'D2', 'D3']],
      [3, [3, 3, 3], 3, 3, ['D1', 'D2', 'D3']],
    ]);
  });

  it('gives a finder with no judge yet one row with a null judge', () => {
    const [row] = summarize({ lines: [run({})], catalog, scores: { batches: {}, judges: { 'gpt-5.5': 15 } }, cacheRuleApplies: false });
    expect([row.judge, row.pair, row.composite, row.judgeConsensus]).toEqual([null, 'vendor/alpha (no judge yet)', true, null]);
  });

  it('carries the tier of the candidate, and none for the baseline', () => {
    const both = [run({}), run({ label: 'base', key: '1|find|base|418|1', batch: 1 })];
    expect(summarize({ lines: both, catalog, scores: noScores, cacheRuleApplies: false }).map((r) => [r.label, r.tier])).toEqual([['base', null], ['alpha', 'cheap']]);
  });

  it('marks a dropped candidate', () => {
    const edited = { ...catalog, candidates: [{ ...catalog.candidates[0], dropped: 'empty twice' }] };
    expect(summarize({ lines: [run({})], catalog: edited, scores: noScores, cacheRuleApplies: false })[0].dropped).toBe(true);
  });

  describe('batch 104', () => {
    const verdict = (name) => ({ verdict: name });
    const judged = (judge, results) => run({ batch: 104, mode: 'verify', verifyModel: judge, key: `104|verify|alpha|418|1|${judge}`, results });
    const lines104 = [run({}), judged('judge-x', [verdict('refuted'), verdict('confirmed')]), judged('judge-y', [verdict('confirmed')])];
    const scores104 = {
      batches: { 104: { 'alpha@judge-x': { 1: score(['D1']) }, 'alpha@judge-y': { 1: score(['D1', 'D2']) } } },
      judges: { 'judge-x': 14 },
    };
    const rows104 = summarize({ lines: lines104, catalog, scores: scores104, cacheRuleApplies: false });

    it('gives a row per judge on draw 1, not composite, with its consensus', () => {
      expect(rows104.map((r) => [r.judge, r.medianPublished, r.composite, r.judgeConsensus])).toEqual([
        ['judge-x', 1, false, 14],
        ['judge-y', 2, false, null],
      ]);
    });

    it('keeps refuted per pair', () => {
      expect(rows104.map((r) => r.refutedMean)).toEqual([1, 0]);
    });
  });

  it('is composite while that judge did not verify this finder cleanly', () => {
    const failed = run({ batch: 7, mode: 'verify', verifyModel: 'gpt-5.5', key: '7|verify|alpha|418|1|gpt-5.5', exit: 5, error: 'boom' });
    const [row] = summarize({ lines: [run({}), failed], catalog, scores: noScores, cacheRuleApplies: false });
    expect([row.judge, row.composite]).toEqual(['gpt-5.5', true]);
  });

  it('keeps the error share of a judge on its own row', () => {
    const judged = (judge, verdict) => run({ batch: 7, mode: 'verify', verifyModel: judge, key: `7|verify|alpha|418|1|${judge}`, results: [{ verdict }] });
    const both = summarize({ lines: [judged('j1', 'error'), judged('j2', 'confirmed')], catalog, scores: noScores, cacheRuleApplies: false });
    expect(both.map((r) => r.errorShare)).toEqual([1, 0]);
  });

  it('pays each row for the find and its own judge only', () => {
    const paid = [
      run({}),
      pairRun(7, 'j1', 1),
      pairRun(7, 'j2', 1),
      call({ usage: { cost: 0.5 } }),
      call({ stage: 'verify', key: '7|verify|alpha|418|1|j1', requestedModel: 'j1', usage: { cost: 0.25 } }),
      call({ stage: 'verify', key: '7|verify|alpha|418|1|j2', requestedModel: 'j2', usage: { cost: 0.125 } }),
    ];
    const both = summarize({ lines: paid, catalog, scores: noScores, cacheRuleApplies: false });
    expect(both.map((r) => r.paidUsd)).toEqual([0.75, 0.625]);
  });

  it('prices each row with the verify of its own judge, and gives the judge part apart', () => {
    const edited = { ...catalog, prices: { ...catalog.prices, j1: { input: 1, output: 1 }, j2: { input: 2, output: 2 } } };
    const priced = [
      run({}),
      pairRun(7, 'j1', 1),
      pairRun(104, 'j2', 1),
      call({}),
      call({ stage: 'verify', key: '7|verify|alpha|418|1|j1', requestedModel: 'j1', usage: { prompt_tokens: 1000, completion_tokens: 0 } }),
      call({ stage: 'verify', key: '104|verify|alpha|418|1|j2', requestedModel: 'j2', usage: { prompt_tokens: 1000, completion_tokens: 0 } }),
    ];
    const both = summarize({ lines: priced, catalog: edited, scores: noScores, cacheRuleApplies: false });
    expect(both.map((r) => [r.productionUsd, r.judgeUsd])).toEqual([
      [(1000 * 1 + 100 * 2) / 1e6 + 1000 / 1e6, 1000 / 1e6],
      [(1000 * 1 + 100 * 2) / 1e6 + 2000 / 1e6, 2000 / 1e6],
    ]);
  });

  it('has no production price for a usage with no tokens', () => {
    const [row] = summarize({ lines: [run({}), call({ usage: {} })], catalog, scores: noScores, cacheRuleApplies: false });
    expect(row.productionUsd).toBe(null);
  });

  it('makes no row of the expected failure of batch 0', () => {
    const probe = run({ label: 'base', batch: 0, mode: 'verify', verifyModel: 'gpt-5.5', key: '0|verify|base|688|1|gpt-5.5', pr: '688', exit: 5, error: 'HTTP 400', expectFailure: true });
    const find = run({ label: 'base', batch: 0, key: '0|find|base|895|1', pr: '895' });
    const [row] = summarize({ lines: [find, probe], catalog, scores: noScores, cacheRuleApplies: false });
    expect([row.judge, row.brokenCalls]).toEqual([null, 0]);
  });
});

describe('summarize: a pair with no corpus run of its own', () => {
  const judged = (batch, judge, pr = '418') => run({ batch, mode: batch === 104 ? 'verify' : 'whole', verifyModel: judge, pr, key: `${batch}|whole|alpha|${pr}|1|${judge}` });
  const counts = { real: 2, false: 0, unfalsifiable: 0, published: 2 };
  const ownCorpus = { real: 4, false: 0, unfalsifiable: 0, published: 4, prs: 2 };
  const lines = [judged(104, 'j2'), judged(103, 'j1', '344'), judged(103, 'j1', '348'), judged(104, 'j3')];
  const scores = { batches: { 103: { alpha: { 1: { corpus: { 344: counts, 348: counts } } } } }, judges: { j1: 15, j2: 14 } };
  const rows = summarize({ lines, catalog, scores, cacheRuleApplies: false });

  it('keeps the own counts of the pair that ran the corpus', () => {
    const row = rows.find((r) => r.judge === 'j1');
    expect([row.corpus, row.corpusFrom]).toEqual([ownCorpus, null]);
  });

  it('takes the finder counts on a pair with none, and says from which judge', () => {
    const row = rows.find((r) => r.judge === 'j2');
    expect([row.corpus, row.corpusFrom]).toEqual([ownCorpus, 'j1']);
  });

  it('keeps the consensus of its own judge', () => {
    expect(rows.map((r) => [r.judge, r.judgeConsensus])).toEqual([['j2', 14], ['j1', 15], ['j3', null]]);
  });

  it('keeps composite true where the judge did not verify this finder', () => {
    const failed = run({ batch: 7, mode: 'verify', verifyModel: 'j4', key: '7|verify|alpha|418|1|j4', exit: 5, error: 'boom' });
    const row = summarize({ lines: [...lines, failed], catalog, scores, cacheRuleApplies: false }).find((r) => r.judge === 'j4');
    expect([row.composite, row.corpusFrom, row.corpus]).toEqual([true, 'j1', ownCorpus]);
  });

  it('inherits nothing when no pair of the finder ran the corpus', () => {
    const [row] = summarize({ lines: [judged(104, 'j2')], catalog, scores: noScores, cacheRuleApplies: false });
    expect([row.corpus.prs, row.corpusFrom]).toEqual([0, null]);
  });

  it('keeps the generic-prompts row apart from the corpus of the baseline', () => {
    const baseRun = (batch, judge, pr) => run({ label: 'base', batch, mode: 'whole', verifyModel: judge, pr, key: `${batch}|whole|base|${pr}|1|${judge}` });
    const both = [baseRun(102, 'gpt-5.5', '344'), baseRun(105, 'gpt-5.5', '418')];
    const baseScores = { batches: { 102: { base: { 1: { corpus: { 344: counts } } } } }, judges: {} };
    const generic = rowOf(summarize({ lines: both, catalog, scores: baseScores, cacheRuleApplies: false }), 'base (generic prompts)');
    expect([generic.corpus.prs, generic.corpusFrom]).toEqual([0, null]);
  });
});

describe('summarize: what breaks a pair', () => {
  const brokenOf = (lines) => rowOf(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }), 'alpha').brokenCalls;

  it('counts a run that failed with content and stop', () => {
    expect(brokenOf([call({}), run({ exit: 5, error: 'the answer did not parse' })])).toBe(1);
  });

  it('counts a broken call and its failed run once', () => {
    expect(brokenOf([call({ contentLength: 0 }), run({ exit: 5, error: 'empty' })])).toBe(1);
  });

  it('counts each failed attempt', () => {
    const attempt2 = { attempt: 2 };
    expect(brokenOf([call({ contentLength: 0 }), run({ exit: 5, error: 'empty' }), call({ ...attempt2 }), run({ ...attempt2, exit: 5, error: 'no parse' })])).toBe(2);
  });

  it('leaves out a failed run marked as expected', () => {
    expect(brokenOf([run({ exit: 5, error: 'HTTP 400', expectFailure: true })])).toBe(0);
  });

  it('counts a batch 104 call on the row of its judge only', () => {
    const judged = (judge) => run({ batch: 104, mode: 'verify', verifyModel: judge, key: `104|verify|alpha|418|1|${judge}` });
    const lines = [judged('j1'), judged('j2'), call({ stage: 'verify', key: '104|verify|alpha|418|1|j1', requestedModel: 'j1', contentLength: 0 })];
    expect(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }).map((r) => r.brokenCalls)).toEqual([1, 0]);
  });

  it('counts a failed run of the judge on its own row only', () => {
    const judged = (judge, over) => run({ batch: 7, mode: 'verify', verifyModel: judge, key: `7|verify|alpha|418|1|${judge}`, ...over });
    const lines = [judged('j1', { exit: 5, error: 'boom' }), judged('j2', {})];
    expect(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }).map((r) => r.brokenCalls)).toEqual([1, 0]);
  });

  it('counts a failed find on every row of the finder', () => {
    const judged = (judge) => run({ batch: 7, mode: 'verify', verifyModel: judge, key: `7|verify|alpha|418|1|${judge}` });
    const lines = [run({ exit: 5, error: 'no parse' }), judged('j1'), judged('j2')];
    expect(summarize({ lines, catalog, scores: noScores, cacheRuleApplies: false }).map((r) => r.brokenCalls)).toEqual([1, 1]);
  });
});

describe('summarize: the concrete misses', () => {
  const lines = [run({ draw: 1 }), run({ draw: 2 }), run({ batch: 7, mode: 'verify', verifyModel: 'j', key: '7|verify|alpha|418|1|j' })];
  const scores = { batches: { 2: { alpha: { 1: score(['D2']), 2: score(['D1']) } }, 7: { alpha: { 1: score(['D2']) } } }, judges: {} };
  const row = rowOf(summarize({ lines, catalog, scores, cacheRuleApplies: false }), 'alpha');

  it('names the defects of the find stage and those it missed', () => {
    expect([row.findDefects, row.missedFind]).toEqual([['D1', 'D2'], ['D3', 'D4', 'D5']]);
  });

  it('names the published union and what it missed', () => {
    expect([row.publishedDefects, row.missedPublished]).toEqual([['D2'], ['D1', 'D3', 'D4', 'D5']]);
  });

  it('has no misses to name before anything is scored', () => {
    const [bare] = summarize({ lines: [run({})], catalog, scores: noScores, cacheRuleApplies: false });
    expect([bare.findDefects, bare.missedFind, bare.publishedDefects, bare.missedPublished]).toEqual([[], null, [], null]);
  });
});

describe('anthropicCalls', () => {
  it('takes the calls of the Anthropic models, not the gpt-5.5 verify of a Claude finder', () => {
    const find = call({ key: '2|find|beta|418|1', requestedModel: 'beta-1' });
    const judge = call({ stage: 'verify', key: '7|verify|beta|418|1|gpt-5.5', requestedModel: 'gpt-5.5' });
    const other = call({});
    expect(anthropicCalls([find, judge, other], catalog)).toEqual([find]);
  });
});

describe('executorVisibility', () => {
  it('counts the calls that name their host, and the hosts', () => {
    const calls = [call({ provider: 'Alibaba' }), call({ provider: null }), call({ provider: 'Alibaba' }), call({ provider: 'Azure' })];
    expect(executorVisibility(calls)).toEqual({ calls: 4, visible: 3, hosts: ['Alibaba', 'Azure'] });
  });
});

describe('readsPerWrite', () => {
  const details = (cached, written) => call({ usage: { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written } } });

  it('divides the tokens read by the tokens written', () => {
    expect(readsPerWrite([details(0, 1000), details(250, 0), details(250, 1000)])).toEqual({ reads: 500, writes: 2000, ratio: 0.25 });
  });

  it('has no ratio with nothing written', () => {
    expect(readsPerWrite([details(10, 0), call({ usage: null })])).toEqual({ reads: 10, writes: 0, ratio: null });
  });
});

describe('baselineRowOf', () => {
  const judged = (judge) => run({ label: 'base', batch: 104, mode: 'verify', verifyModel: judge, key: `104|verify|base|418|1|${judge}` });

  it('takes the baseline pair among the rows of the baseline label', () => {
    const rows = summarize({ lines: [judged('other'), judged('gpt-5.5')], catalog, scores: noScores, cacheRuleApplies: false });
    expect(baselineRowOf(rows, catalog).judge).toBe('gpt-5.5');
  });

  it('takes the row with no judge before the baseline has one', () => {
    const rows = summarize({ lines: [run({ label: 'base', key: '1|find|base|418|1' })], catalog, scores: noScores, cacheRuleApplies: false });
    expect(baselineRowOf(rows, catalog).judge).toBe(null);
  });

  it('is undefined with no baseline row', () => {
    expect(baselineRowOf([], catalog)).toBe(undefined);
  });
});

describe('paidByRoute with a bad manual line', () => {
  it('stays a number', () => {
    expect(paidByRoute([{ type: 'manual', reason: 'no sum' }, { type: 'manual', usd: 1 }], catalog)).toEqual({ byRoute: {}, manualUsd: 1 });
  });
});

describe('stage2Items', () => {
  const priced = {
    baseline: { label: 'base', findModel: 'base-find', verifyModel: 'base-judge', route: 'openai' },
    candidates: [
      { label: 'router', model: 'v/router', route: 'openrouter', only: null, tier: 'cheap', price: { input: 1, output: 0 } },
      { label: 'claude', model: 'claude-1', route: 'anthropic', only: null, tier: 'mid', price: { input: 2, output: 30 } },
      { label: 'sonnet', model: 'claude-sonnet-5-5', route: 'anthropic', only: null, tier: 'mid', price: { input: 2, output: 30 } },
      { label: 'sol', model: 'gpt-6.1-sol', route: 'openai', only: null, tier: 'mid', price: { input: 1, output: 30 } },
      { label: 'terra', model: 'gpt-6.1-terra', route: 'openai', only: null, tier: 'mid', price: { input: 1, output: 30 } },
      { label: 'haiku', model: 'claude-haiku-5-5', route: 'anthropic', only: null, tier: 'cheap', price: { input: 1, output: 30 } },
    ],
    judges: [{ model: 'openai/gpt-5.5', only: null, price: { input: 5, output: 30 } }],
    prices: { 'base-find': { input: 1, output: 0 }, 'base-judge': { input: 1, output: 30 }, 'gpt-5.5': { input: 5, output: 30 } },
    prs: { 344: { head: null, input: 1000000, output: 0 }, 418: { head: 'h', input: 1000000, output: 0 }, 930: { head: 'h', input: 1000000, output: 0 } },
    corpus: ['344'],
    recallPrs: ['418', '930'],
  };
  // With these sizes a find costs its model's input price, and every judge at output 30 costs 0.19.
  it('lists the items of the spec in order, priced from the plan', () => {
    const items = stage2Items({ catalog: priced, corpus: ['344'], finalists: ['router', 'claude'], pairs: ['claude', 'sol'] });
    expect(items.map((i) => [i.item, i.what, Number(i.usd.toFixed(4))])).toEqual([
      [1, '#930: the baseline and router, claude, 3 draws each', 3 * 1.19 + 3 * 1.19 + 3 * 2.19],
      [2, 'corpus: the baseline', 1.19],
      [3, 'corpus: router', 1.19],
      [3, 'corpus: claude', 2.19],
      [4, 'judges on the same inputs: claude-sonnet-5-5, gpt-6.1-sol, gpt-6.1-terra, claude-haiku-5-5, on the baseline and router, claude; verify-corpus comes on top', 12 * 0.19],
      [5, 'generic prompts: the baseline on #418 and the corpus', 4 * 1.19],
      [6, 'a pair inside one provider, #418 x 3: claude', 3 * 2.19],
      [6, 'a pair inside one provider, #418 x 3: sol', 3 * 1.19],
    ].map(([item, what, usd]) => [item, what, Number(usd.toFixed(4))]));
  });

  it('prices the items with no finalist yet', () => {
    const bare = stage2Items({ catalog: priced, corpus: ['344'], finalists: [], pairs: [] });
    expect(bare.map((i) => i.item)).toEqual([1, 2, 4, 5]);
  });
});

describe('summarize: the PR comes from the key', () => {
  it('reads a batch 101 #930 score as #930 even when the grader wrote another PR', () => {
    const runs = [run({ batch: 101, mode: 'whole', pr: '930', draw: 1, head: 'h', key: '101|whole|alpha|930|1' })];
    const { items, key } = anonymize({ runs, read: () => ({ kept: [] }), shuffle: (list) => list });
    const grader = { [items[0].id]: { defects: ['D1', 'D2'], findings: 3, pr: '418' } };
    const row = rowOf(summarize({ lines: runs, catalog, scores: { batches: { 101: applyKey(grader, key) }, judges: {} }, cacheRuleApplies: false }), 'alpha');
    expect([row.medianRecall930, row.medianPublished]).toEqual([2, null]);
  });
});
