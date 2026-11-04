import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { admit, nextAction, planBatch, runKey, savedFindings, startedFinds } from './batches.mjs';
import { loadCatalog, priceOf } from './catalog.mjs';

const text = readFileSync(new URL('../candidates.json', import.meta.url), 'utf8');
const real = loadCatalog(text);
/** The real file with what `--endpoints` and the owner write there taken away: every row pinned, none dropped. */
const liveRow = ({ dropped, ...row }) => ({ ...row, only: ['x'] });
const catalog = {
  ...real,
  candidates: real.candidates.map(liveRow),
  judges: [{ model: 'openai/gpt-5.5', only: ['judge-host'], price: { input: 5, output: 30 } }],
};
const baseline = 'gpt-5.6-sol';
const preflight = { corpus: ['344', '352'], recall930: true };
const plan = (args) => planBatch({ preflight, ...args });

const pairs = (runs) => runs.map((r) => [r.mode, r.draw]);

describe('planBatch batch 0', () => {
  const runs = plan({ batch: 0, catalog });

  it('runs every candidate and the baseline on #895 first, then four runs on #688', () => {
    expect(runs.length).toBe(21 + 4);
    expect(runs.slice(0, 21).map((r) => [r.pr, r.draw, r.mode])).toEqual(Array(21).fill(['895', 1, 'find']));
  });

  it('ends with three baseline finds on #688 and a verify that must fail', () => {
    expect(runs.slice(-4).map((r) => [r.label, r.mode, r.pr, r.draw, r.cacheOffModels, r.expectFailure])).toEqual([
      [baseline, 'find', '688', 1, null, false],
      [baseline, 'find', '688', 2, null, false],
      [baseline, 'find', '688', 3, ['gpt-5.6-sol'], false],
      [baseline, 'verify', '688', 1, ['gpt-5.5'], true],
    ]);
  });

  it('points the verify at the find of draw 1', () => {
    expect(runs[24].from).toEqual({ label: baseline, pr: '688', draw: 1 });
    expect(runs[24].route).toBe('openai');
    expect(runs[24].verifyModel).toBe('gpt-5.5');
  });
});

describe('planBatch', () => {
  it('batch 1 alternates find and verify over three draws on #418', () => {
    const runs = plan({ batch: 1, catalog });
    expect(pairs(runs)).toEqual([['find', 1], ['verify', 1], ['find', 2], ['verify', 2], ['find', 3], ['verify', 3]]);
    expect(runs.map((r) => r.pr)).toEqual(Array(6).fill('418'));
    expect(runs[0].head).toBe('584aa661');
    expect(runs[1].from).toEqual({ label: baseline, pr: '418', draw: 1 });
    expect(runs[0].from).toBe(null);
  });

  it('batch 2 is the ten cheap candidates over three draws, round by round', () => {
    const runs = plan({ batch: 2, catalog });
    expect(runs.length).toBe(30);
    expect(runs.slice(0, 10).map((r) => r.draw)).toEqual(Array(10).fill(1));
    expect(runs.slice(10, 20).map((r) => r.draw)).toEqual(Array(10).fill(2));
    expect(runs[0].label).toBe('claude-haiku-5-5');
    expect(runs[10].label).toBe('claude-haiku-5-5');
  });

  it('batch 3 is the seven mid candidates, draw 1', () => {
    const runs = plan({ batch: 3, catalog });
    expect(runs.map((r) => r.draw)).toEqual(Array(7).fill(1));
  });

  it('batch 5 is the three expensive candidates, draws 1 and 2', () => {
    const runs = plan({ batch: 5, catalog });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([
      ['claude-opus-5-5', 1],
      ['gpt-6-astra', 1],
      ['claude-fable-5-1', 1],
      ['claude-opus-5-5', 2],
      ['gpt-6-astra', 2],
      ['claude-fable-5-1', 2],
    ]);
  });

  it('batch 4 runs the given labels in draws 2 and 3', () => {
    const runs = plan({ batch: 4, catalog, labels: ['gpt-6.1-sol', 'grok-4.7'] });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([['gpt-6.1-sol', 2], ['grok-4.7', 2], ['gpt-6.1-sol', 3], ['grok-4.7', 3]]);
  });

  it('batch 6 runs the given labels in draw 3', () => {
    const runs = plan({ batch: 6, catalog, labels: ['gpt-6-astra'] });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([['gpt-6-astra', 3]]);
  });

  it('batch 4 without labels throws', () => {
    expect(() => plan({ batch: 4, catalog })).toThrow('labels');
  });

  it('batch 7 verifies round by round through openai with the baseline judge', () => {
    const runs = plan({ batch: 7, catalog, labels: ['grok-4.7', 'kimi-k3.1-pro'] });
    expect(runs.map((r) => [r.label, r.mode, r.draw, r.route, r.verifyModel, r.from])).toEqual([
      ['grok-4.7', 'verify', 1, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 1 }],
      ['kimi-k3.1-pro', 'verify', 1, 'openai', 'gpt-5.5', { label: 'kimi-k3.1-pro', pr: '418', draw: 1 }],
      ['grok-4.7', 'verify', 2, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 2 }],
      ['kimi-k3.1-pro', 'verify', 2, 'openai', 'gpt-5.5', { label: 'kimi-k3.1-pro', pr: '418', draw: 2 }],
      ['grok-4.7', 'verify', 3, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 3 }],
      ['kimi-k3.1-pro', 'verify', 3, 'openai', 'gpt-5.5', { label: 'kimi-k3.1-pro', pr: '418', draw: 3 }],
    ]);
    expect(runs[0].only).toEqual({ find: null, verify: null });
  });

  it('refuses an openrouter candidate with no pinned host', () => {
    const unpinned = { ...catalog, candidates: catalog.candidates.map((c) => ({ ...c, only: null })) };
    expect(() => plan({ batch: 2, catalog: unpinned })).toThrow('--endpoints');
  });

  it('carries the pin on a find run and null on the verify side', () => {
    const [run] = plan({ batch: 2, catalog });
    expect(run.only).toEqual({ find: ['x'], verify: null });
    expect(run.verifyModel).toBe(null);
  });

  it('batch 102 takes only the corpus PRs the preflight let through', () => {
    const runs = plan({ batch: 102, catalog, preflight });
    expect(runs.map((r) => [r.label, r.mode, r.pr, r.draw])).toEqual([
      [baseline, 'whole', '344', 1],
      [baseline, 'whole', '352', 1],
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 101, 102, 103, 104, 105, 106])('batch %i without a preflight throws', (batch) => {
    expect(() => planBatch({ batch, catalog, labels: ['grok-4.7'] })).toThrow(`plan: batch ${batch} needs the preflight`);
  });

  it('batch 0 runs without a preflight', () => {
    expect(planBatch({ batch: 0, catalog }).length).toBe(25);
  });

  it('batch 101 runs the baseline and the labels on #930, three draws each', () => {
    const runs = plan({ batch: 101, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai', preflight });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([
      [baseline, 1], ['gpt-6.1-sol', 1], [baseline, 2], ['gpt-6.1-sol', 2], [baseline, 3], ['gpt-6.1-sol', 3],
    ]);
    expect(runs.map((r) => r.pr)).toEqual(Array(6).fill('930'));
    expect(runs[0].head).toBe('a5926a74');
  });

  it('batch 101 throws when the preflight dropped #930', () => {
    expect(() =>
      plan({ batch: 101, catalog, labels: [], preflight: { corpus: [], recall930: false } }),
    ).toThrow('930');
  });

  it('batch 103 runs the labels on the corpus', () => {
    const runs = plan({ batch: 103, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai', preflight });
    expect(runs.map((r) => [r.label, r.mode, r.pr])).toEqual([
      ['gpt-6.1-sol', 'whole', '344'],
      ['gpt-6.1-sol', 'whole', '352'],
    ]);
  });

  it('batch 105 runs the baseline on #418 three times and then on the corpus', () => {
    const runs = plan({ batch: 105, catalog, preflight });
    expect(runs.map((r) => [r.pr, r.draw])).toEqual([['418', 1], ['418', 2], ['418', 3], ['344', 1], ['352', 1]]);
  });

  it('batch 106 runs the labels on #418, three draws', () => {
    const runs = plan({ batch: 106, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai' });
    expect(runs.map((r) => [r.label, r.pr, r.draw])).toEqual([
      ['gpt-6.1-sol', '418', 1], ['gpt-6.1-sol', '418', 2], ['gpt-6.1-sol', '418', 3],
    ]);
  });

  it('batch 104 verifies draw 1 of the baseline and the labels with every judge', () => {
    const judges = [{ model: 'claude-sonnet-5-5', route: 'anthropic' }, { model: 'gpt-6.1-sol', route: 'openai' }];
    const runs = plan({ batch: 104, catalog, labels: ['grok-4.7'], judges });
    expect(runs.map((r) => [r.label, r.verifyModel, r.route, r.from])).toEqual([
      [baseline, 'claude-sonnet-5-5', 'anthropic', { label: baseline, pr: '418', draw: 1 }],
      ['grok-4.7', 'claude-sonnet-5-5', 'anthropic', { label: 'grok-4.7', pr: '418', draw: 1 }],
      [baseline, 'gpt-6.1-sol', 'openai', { label: baseline, pr: '418', draw: 1 }],
      ['grok-4.7', 'gpt-6.1-sol', 'openai', { label: 'grok-4.7', pr: '418', draw: 1 }],
    ]);
  });

  it('batch 104 gives every judge its own key on the same find', () => {
    const judges = [{ model: 'claude-sonnet-5-5', route: 'anthropic' }, { model: 'gpt-6.1-sol', route: 'openai' }];
    const keys = plan({ batch: 104, catalog, judges }).map(runKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('pins an openrouter judge to the host of its candidate', () => {
    const judges = [{ model: 'x-ai/grok-4.7', route: 'openrouter' }];
    const [run] = plan({ batch: 104, catalog, judges });
    expect(run.only).toEqual({ find: null, verify: ['x'] });
  });

  it('a whole run of a candidate needs a verify model', () => {
    expect(() => plan({ batch: 106, catalog, labels: ['grok-4.7'], verifyRoute: 'openai' })).toThrow('verifyModel');
  });

  it('a whole run of a candidate needs the verify route of its own route', () => {
    expect(() =>
      plan({ batch: 106, catalog, labels: ['grok-4.7'], verifyModel: 'gpt-5.5', verifyRoute: 'openai' }),
    ).toThrow('verifyRoute');
  });

  it('a whole run carries the pin on both stages when the route is openrouter', () => {
    const [run] = plan({ batch: 106, catalog, labels: ['grok-4.7'], verifyModel: 'x-ai/grok-4.7', verifyRoute: 'openrouter' });
    expect(run.only).toEqual({ find: ['x'], verify: ['x'] });
  });

  it('throws for an unknown label', () => {
    expect(() => plan({ batch: 4, catalog, labels: ['nobody'] })).toThrow('nobody');
  });

  it('throws for an unknown batch', () => {
    expect(() => plan({ batch: 9, catalog })).toThrow('unknown batch 9');
  });
});

describe('runKey', () => {
  const whole = (verifyModel) => plan({ batch: 106, catalog, labels: ['gpt-6.1-sol'], verifyModel, verifyRoute: 'openai' })[0];

  it('names the judge of a whole run', () => {
    expect(runKey(whole('gpt-5.5'))).toBe('106|whole|gpt-6.1-sol|418|1|gpt-5.5');
  });

  it('names no judge for a find', () => {
    expect(runKey(plan({ batch: 1, catalog })[0])).toBe('1|find|gpt-5.6-sol|418|1');
  });

  it('lets a second pair of one finder run in batch 106', () => {
    const closed = { type: 'run', key: runKey(whole('gpt-5.5')), attempt: 1, exit: 0, error: null };
    expect(nextAction(whole('gpt-6.1-terra'), [closed])).toEqual({ action: 'run', attempt: 1 });
  });
});

describe('planBatch: a judge other than the finder', () => {
  const judgeRun = plan({ batch: 101, catalog, labels: ['qwen3.8-flash'], verifyModel: 'openai/gpt-5.5', verifyRoute: 'openrouter' })[1];

  it('takes the pin of its judges row on the verify side of a whole run', () => {
    expect([judgeRun.label, judgeRun.route, judgeRun.only]).toEqual(['qwen3.8-flash', 'openrouter', { find: ['x'], verify: ['judge-host'] }]);
  });

  it('prices the judge from its judges row', () => {
    const fixed = { ...catalog, candidates: catalog.candidates.map((c) => ({ ...c, price: { input: 1, output: 2 } })) };
    const [run] = plan({ batch: 106, catalog: fixed, labels: ['qwen3.8-flash'], verifyModel: 'openai/gpt-5.5', verifyRoute: 'openrouter' });
    expect(run.estimateUsd).toBe((41400 * 1 + 4600 * 2) / 1e6 + 0.19);
  });

  it('refuses an unpinned judges row, pointing at --endpoints', () => {
    const unpinned = { ...catalog, judges: [{ model: 'openai/gpt-5.5', only: null, price: { input: 5, output: 30 } }] };
    expect(() => plan({ batch: 106, catalog: unpinned, labels: ['qwen3.8-flash'], verifyModel: 'openai/gpt-5.5', verifyRoute: 'openrouter' })).toThrow('--endpoints');
  });

  it('takes the pin of a candidate with the same model when there is no judges row', () => {
    const pins = { ...catalog, candidates: catalog.candidates.map((c) => ({ ...c, only: [c.label] })) };
    const [run] = plan({ batch: 106, catalog: pins, labels: ['qwen3.8-flash'], verifyModel: 'x-ai/grok-4.7', verifyRoute: 'openrouter' });
    expect(run.only).toEqual({ find: ['qwen3.8-flash'], verify: ['grok-4.7'] });
  });

  it('refuses a judge nobody pins', () => {
    expect(() => plan({ batch: 106, catalog, labels: ['qwen3.8-flash'], verifyModel: 'nobody/judge', verifyRoute: 'openrouter' })).toThrow('judge nobody/judge is on openrouter');
  });

  it('pins a batch 104 judge from its judges row', () => {
    const [run] = plan({ batch: 104, catalog, judges: [{ model: 'openai/gpt-5.5', route: 'openrouter' }] });
    expect(run.only).toEqual({ find: null, verify: ['judge-host'] });
  });
});

describe('planBatch: a dropped candidate', () => {
  const withDropped = { ...catalog, candidates: catalog.candidates.map((c) => ({ ...c, ...(c.label === 'grok-build-0.1' ? { dropped: 'empty answer twice' } : {}) })) };

  it('is out of batch 0', () => {
    expect(plan({ batch: 0, catalog: withDropped }).map((r) => r.label)).not.toContain('grok-build-0.1');
    expect(plan({ batch: 0, catalog: withDropped }).length).toBe(24);
  });

  it('is out of its tier', () => {
    expect(plan({ batch: 2, catalog: withDropped }).length).toBe(27);
    expect(plan({ batch: 2, catalog: withDropped }).map((r) => r.label)).not.toContain('grok-build-0.1');
  });

  it('is refused by name when chosen, with the reason', () => {
    expect(() => plan({ batch: 4, catalog: withDropped, labels: ['grok-build-0.1'] })).toThrow('grok-build-0.1 is dropped: empty answer twice');
  });

  it('still has its price, so its earlier calls stay priced', () => {
    expect(priceOf(withDropped, 'x-ai/grok-build-0.1')).toEqual(priceOf(catalog, 'x-ai/grok-build-0.1'));
  });
});

describe('estimates', () => {
  it('prices the baseline find on #418', () => {
    expect(plan({ batch: 1, catalog })[0].estimateUsd).toBe(0.2576);
  });

  it('prices a verify by the judge', () => {
    expect(plan({ batch: 1, catalog })[1].estimateUsd).toBe(0.19);
  });

  it('prices a verify by the output price of the judge against gpt-5.5', () => {
    const judges = [{ model: 'gpt-6.1-sol', route: 'openai' }];
    expect(plan({ batch: 104, catalog, judges })[0].estimateUsd).toBe(0.06333333333333332);
  });

  it('prices a whole run as find plus verify', () => {
    const [run] = plan({ batch: 105, catalog, preflight });
    expect(run.estimateUsd).toBe(0.4476);
  });
});

describe('admit', () => {
  it('lets a run in that fits twice under the ceiling', () => {
    expect(admit({ spentUsd: 10, estimateUsd: 0.5, ceilingUsd: 11 })).toBe(true);
  });

  it('keeps out a run that does not', () => {
    expect(admit({ spentUsd: 10, estimateUsd: 0.51, ceilingUsd: 11 })).toBe(false);
  });
});

describe('nextAction', () => {
  const [find, verify] = plan({ batch: 1, catalog });
  const key = runKey(find);

  it('runs first when there are no lines', () => {
    expect(nextAction(find, [])).toEqual({ action: 'run', attempt: 1 });
  });

  it('skips a run that closed clean', () => {
    expect(nextAction(find, [{ type: 'run', key, attempt: 1, exit: 0, error: null }])).toEqual({ action: 'skip' });
  });

  it('runs again after a failed run, as attempt 2', () => {
    expect(nextAction(find, [{ type: 'run', key, attempt: 1, exit: 5, error: 'boom' }])).toEqual({ action: 'run', attempt: 2 });
  });

  it('runs again when only call lines are left', () => {
    expect(nextAction(find, [{ type: 'call', key, attempt: 1 }])).toEqual({ action: 'run', attempt: 2 });
  });

  it('numbers the attempt after the highest one seen', () => {
    const lines = [
      { type: 'run', key, attempt: 1, exit: 5, error: 'boom' },
      { type: 'run', key, attempt: 2, exit: 5, error: 'boom' },
    ];
    expect(nextAction(find, lines)).toEqual({ action: 'run', attempt: 3 });
  });

  it('ignores lines of other runs', () => {
    expect(nextAction(find, [{ type: 'run', key: runKey(verify), attempt: 1, exit: 0, error: null }])).toEqual({
      action: 'run',
      attempt: 1,
    });
  });

  it('reruns a verify that closed with exit 0 and an error', () => {
    expect(nextAction(verify, [{ type: 'run', key: runKey(verify), attempt: 1, exit: 0, error: 'partly' }])).toEqual({
      action: 'run',
      attempt: 2,
    });
  });

  it('skips an expected failure after any run line', () => {
    const expected = plan({ batch: 0, catalog }).at(-1);
    expect(nextAction(expected, [{ type: 'run', key: runKey(expected), attempt: 1, exit: 5, error: 'HTTP 400' }])).toEqual({
      action: 'skip',
    });
  });
});

describe('savedFindings', () => {
  const [find] = plan({ batch: 1, catalog });
  const key = runKey(find);

  it('maps label/pr/draw to the file of the last clean find', () => {
    const lines = [
      { type: 'run', key, attempt: 1, exit: 0, error: null, findingsFile: 'one.json' },
      { type: 'run', key, attempt: 2, exit: 0, error: null, findingsFile: 'two.json' },
    ];
    expect(savedFindings(lines)).toEqual(new Map([['gpt-5.6-sol/418/1', 'two.json']]));
  });

  it('skips a failed find and a find with no file', () => {
    const lines = [
      { type: 'run', key, attempt: 1, exit: 5, error: 'boom', findingsFile: 'one.json' },
      { type: 'run', key, attempt: 2, exit: 0, error: null, findingsFile: null },
    ];
    expect(savedFindings(lines)).toEqual(new Map());
  });

  it('ignores verify runs', () => {
    const [, verify] = plan({ batch: 1, catalog });
    const lines = [{ type: 'run', key: runKey(verify), attempt: 1, exit: 0, error: null, findingsFile: 'v.json' }];
    expect(savedFindings(lines)).toEqual(new Map());
  });
});

describe('startedFinds', () => {
  const [find] = plan({ batch: 1, catalog });
  const key = runKey(find);

  it('lists the finds that have any line, a call of a killed one too', () => {
    const lines = [{ type: 'call', key, attempt: 1 }, { type: 'run', key: '7|verify|x|418|2|gpt-5.5', attempt: 1 }, { type: 'call' }];
    expect(startedFinds(lines)).toEqual(new Set(['gpt-5.6-sol/418/1']));
  });
});

describe('planBatch: the second try', () => {
  const dropped = { ...catalog, candidates: catalog.candidates.map((c) => (c.label === 'kimi-k3.1-pro' ? { ...c, dropped: 'empty' } : c)) };
  const labels = ['kimi-k3.1-pro'];

  it('takes a dropped model, which every other batch refuses', () => {
    expect(() => plan({ batch: 4, catalog: dropped, labels })).toThrow('kimi-k3.1-pro is dropped: empty');
    expect(plan({ batch: 107, catalog: dropped, labels }).map((r) => r.label)).toEqual(['kimi-k3.1-pro']);
  });

  it.each([
    [107, [1], 32000, null],
    [108, [1], null, 'low'],
    [109, [2, 3], 32000, null],
    [110, [2, 3], null, 'low'],
  ])('batch %i runs a find on #418 with its draws and settings', (batch, draws, findMaxTokens, findReasoning) => {
    const runs = plan({ batch, catalog: dropped, labels });
    expect(runs.map((r) => [r.draw, r.pr, r.mode, r.findMaxTokens, r.findReasoning])).toEqual(draws.map((draw) => [draw, '418', 'find', findMaxTokens, findReasoning]));
  });

  it('estimates the whole limit: $0.40 under 32 000 tokens, $0.10 under 8000', () => {
    const cheap = { ...dropped, candidates: dropped.candidates.map((c) => (c.label === 'kimi-k3.1-pro' ? { ...c, price: { input: 0, output: 12.5 } } : c)) };
    expect(plan({ batch: 107, catalog: cheap, labels })[0].estimateUsd).toBe(0.4);
    expect(plan({ batch: 108, catalog: cheap, labels })[0].estimateUsd).toBe(0.1);
  });

  it('never hands its findings to a batch of the 8000 limit', () => {
    const line = (batch) => ({ type: 'run', key: `${batch}|find|a|418|1`, findingsFile: `findings/${batch}.json`, exit: 0, error: null, results: [], attempt: 1 });
    expect([...savedFindings([line(3), line(107)]).entries()]).toEqual([['a/418/1', 'findings/3.json']]);
    expect(savedFindings([line(107)]).size).toBe(0);
    expect(startedFinds([line(108)]).size).toBe(0);
  });

  it('keeps two settings of one draw apart in the record', () => {
    const [limit] = plan({ batch: 107, catalog: dropped, labels });
    const [effort] = plan({ batch: 108, catalog: dropped, labels });
    expect([runKey(limit), runKey(effort)]).toEqual(['107|find|kimi-k3.1-pro|418|1', '108|find|kimi-k3.1-pro|418|1']);
  });
});
