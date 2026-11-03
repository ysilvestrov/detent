import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { admit, nextAction, planBatch, runKey, savedFindings } from './batches.mjs';
import { loadCatalog } from './catalog.mjs';

const text = readFileSync(new URL('../candidates.json', import.meta.url), 'utf8');
const real = loadCatalog(text);
// Every candidate pinned to a host, so the plan does not refuse the openrouter ones.
const catalog = { ...real, candidates: real.candidates.map((c) => ({ ...c, only: ['x'] })) };
const baseline = 'gpt-5.6-sol';
const preflight = { corpus: ['344', '352'], recall930: true };

const pairs = (runs) => runs.map((r) => [r.mode, r.draw]);

describe('planBatch batch 0', () => {
  const runs = planBatch({ batch: 0, catalog });

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
    const runs = planBatch({ batch: 1, catalog });
    expect(pairs(runs)).toEqual([['find', 1], ['verify', 1], ['find', 2], ['verify', 2], ['find', 3], ['verify', 3]]);
    expect(runs.map((r) => r.pr)).toEqual(Array(6).fill('418'));
    expect(runs[0].head).toBe('584aa661');
    expect(runs[1].from).toEqual({ label: baseline, pr: '418', draw: 1 });
    expect(runs[0].from).toBe(null);
  });

  it('batch 2 is the ten cheap candidates over three draws, round by round', () => {
    const runs = planBatch({ batch: 2, catalog });
    expect(runs.length).toBe(30);
    expect(runs.slice(0, 10).map((r) => r.draw)).toEqual(Array(10).fill(1));
    expect(runs.slice(10, 20).map((r) => r.draw)).toEqual(Array(10).fill(2));
    expect(runs[0].label).toBe('claude-haiku-5-5');
    expect(runs[10].label).toBe('claude-haiku-5-5');
  });

  it('batch 3 is the seven mid candidates, draw 1', () => {
    const runs = planBatch({ batch: 3, catalog });
    expect(runs.map((r) => r.draw)).toEqual(Array(7).fill(1));
  });

  it('batch 5 is the three expensive candidates, draws 1 and 2', () => {
    const runs = planBatch({ batch: 5, catalog });
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
    const runs = planBatch({ batch: 4, catalog, labels: ['gpt-6.1-sol', 'grok-4.7'] });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([['gpt-6.1-sol', 2], ['grok-4.7', 2], ['gpt-6.1-sol', 3], ['grok-4.7', 3]]);
  });

  it('batch 6 runs the given labels in draw 3', () => {
    const runs = planBatch({ batch: 6, catalog, labels: ['gpt-6-astra'] });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([['gpt-6-astra', 3]]);
  });

  it('batch 4 without labels throws', () => {
    expect(() => planBatch({ batch: 4, catalog })).toThrow('labels');
  });

  it('batch 7 verifies every draw of each label through openai with the baseline judge', () => {
    const runs = planBatch({ batch: 7, catalog, labels: ['grok-4.7'] });
    expect(runs.map((r) => [r.label, r.mode, r.draw, r.route, r.verifyModel, r.from])).toEqual([
      ['grok-4.7', 'verify', 1, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 1 }],
      ['grok-4.7', 'verify', 2, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 2 }],
      ['grok-4.7', 'verify', 3, 'openai', 'gpt-5.5', { label: 'grok-4.7', pr: '418', draw: 3 }],
    ]);
    expect(runs[0].only).toEqual({ find: null, verify: null });
  });

  it('refuses an openrouter candidate with no pinned host', () => {
    expect(() => planBatch({ batch: 2, catalog: real })).toThrow('--endpoints');
  });

  it('carries the pin on a find run and null on the verify side', () => {
    const [run] = planBatch({ batch: 2, catalog });
    expect(run.only).toEqual({ find: ['x'], verify: null });
    expect(run.verifyModel).toBe(null);
  });

  it('batch 102 takes only the corpus PRs the preflight let through', () => {
    const runs = planBatch({ batch: 102, catalog, preflight });
    expect(runs.map((r) => [r.label, r.mode, r.pr, r.draw])).toEqual([
      [baseline, 'whole', '344', 1],
      [baseline, 'whole', '352', 1],
    ]);
  });

  it('batch 102 without a preflight throws', () => {
    expect(() => planBatch({ batch: 102, catalog })).toThrow('preflight');
  });

  it('batch 101 runs the baseline and the labels on #930, three draws each', () => {
    const runs = planBatch({ batch: 101, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai', preflight });
    expect(runs.map((r) => [r.label, r.draw])).toEqual([
      [baseline, 1], ['gpt-6.1-sol', 1], [baseline, 2], ['gpt-6.1-sol', 2], [baseline, 3], ['gpt-6.1-sol', 3],
    ]);
    expect(runs.map((r) => r.pr)).toEqual(Array(6).fill('930'));
    expect(runs[0].head).toBe('a5926a74');
  });

  it('batch 101 throws when the preflight dropped #930', () => {
    expect(() =>
      planBatch({ batch: 101, catalog, labels: [], preflight: { corpus: [], recall930: false } }),
    ).toThrow('930');
  });

  it('batch 103 runs the labels on the corpus', () => {
    const runs = planBatch({ batch: 103, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai', preflight });
    expect(runs.map((r) => [r.label, r.mode, r.pr])).toEqual([
      ['gpt-6.1-sol', 'whole', '344'],
      ['gpt-6.1-sol', 'whole', '352'],
    ]);
  });

  it('batch 105 runs the baseline on #418 three times and then on the corpus', () => {
    const runs = planBatch({ batch: 105, catalog, preflight });
    expect(runs.map((r) => [r.pr, r.draw])).toEqual([['418', 1], ['418', 2], ['418', 3], ['344', 1], ['352', 1]]);
  });

  it('batch 106 runs the labels on #418, three draws', () => {
    const runs = planBatch({ batch: 106, catalog, labels: ['gpt-6.1-sol'], verifyModel: 'gpt-5.5', verifyRoute: 'openai' });
    expect(runs.map((r) => [r.label, r.pr, r.draw])).toEqual([
      ['gpt-6.1-sol', '418', 1], ['gpt-6.1-sol', '418', 2], ['gpt-6.1-sol', '418', 3],
    ]);
  });

  it('batch 104 verifies draw 1 of the baseline and the labels with every judge', () => {
    const judges = [{ model: 'claude-sonnet-5-5', route: 'anthropic' }, { model: 'gpt-6.1-sol', route: 'openai' }];
    const runs = planBatch({ batch: 104, catalog, labels: ['grok-4.7'], judges });
    expect(runs.map((r) => [r.label, r.verifyModel, r.route, r.from])).toEqual([
      [baseline, 'claude-sonnet-5-5', 'anthropic', { label: baseline, pr: '418', draw: 1 }],
      ['grok-4.7', 'claude-sonnet-5-5', 'anthropic', { label: 'grok-4.7', pr: '418', draw: 1 }],
      [baseline, 'gpt-6.1-sol', 'openai', { label: baseline, pr: '418', draw: 1 }],
      ['grok-4.7', 'gpt-6.1-sol', 'openai', { label: 'grok-4.7', pr: '418', draw: 1 }],
    ]);
  });

  it('batch 104 gives every judge its own key on the same find', () => {
    const judges = [{ model: 'claude-sonnet-5-5', route: 'anthropic' }, { model: 'gpt-6.1-sol', route: 'openai' }];
    const keys = planBatch({ batch: 104, catalog, judges }).map(runKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('pins an openrouter judge to the host of its candidate', () => {
    const judges = [{ model: 'x-ai/grok-4.7', route: 'openrouter' }];
    const [run] = planBatch({ batch: 104, catalog, judges });
    expect(run.only).toEqual({ find: null, verify: ['x'] });
  });

  it('a whole run of a candidate needs a verify model', () => {
    expect(() => planBatch({ batch: 106, catalog, labels: ['grok-4.7'], verifyRoute: 'openai' })).toThrow('verifyModel');
  });

  it('a whole run of a candidate needs the verify route of its own route', () => {
    expect(() =>
      planBatch({ batch: 106, catalog, labels: ['grok-4.7'], verifyModel: 'gpt-5.5', verifyRoute: 'openai' }),
    ).toThrow('verifyRoute');
  });

  it('a whole run carries the pin on both stages when the route is openrouter', () => {
    const [run] = planBatch({ batch: 106, catalog, labels: ['grok-4.7'], verifyModel: 'x-ai/grok-4.7', verifyRoute: 'openrouter' });
    expect(run.only).toEqual({ find: ['x'], verify: ['x'] });
  });

  it('throws for an unknown label', () => {
    expect(() => planBatch({ batch: 4, catalog, labels: ['nobody'] })).toThrow('nobody');
  });

  it('throws for an unknown batch', () => {
    expect(() => planBatch({ batch: 9, catalog })).toThrow('batch 9');
  });
});

describe('estimates', () => {
  it('prices the baseline find on #418', () => {
    expect(planBatch({ batch: 1, catalog })[0].estimateUsd).toBe(0.2576);
  });

  it('prices a verify by the judge', () => {
    expect(planBatch({ batch: 1, catalog })[1].estimateUsd).toBe(0.19);
  });

  it('prices a verify by the output price of the judge against gpt-5.5', () => {
    const judges = [{ model: 'gpt-6.1-sol', route: 'openai' }];
    expect(planBatch({ batch: 104, catalog, judges })[0].estimateUsd).toBe(0.06333333333333332);
  });

  it('prices a whole run as find plus verify', () => {
    const [run] = planBatch({ batch: 105, catalog, preflight });
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
  const [find, verify] = planBatch({ batch: 1, catalog });
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
    const expected = planBatch({ batch: 0, catalog }).at(-1);
    expect(nextAction(expected, [{ type: 'run', key: runKey(expected), attempt: 1, exit: 5, error: 'HTTP 400' }])).toEqual({
      action: 'skip',
    });
  });
});

describe('savedFindings', () => {
  const [find] = planBatch({ batch: 1, catalog });
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
    const [, verify] = planBatch({ batch: 1, catalog });
    const lines = [{ type: 'run', key: runKey(verify), attempt: 1, exit: 0, error: null, findingsFile: 'v.json' }];
    expect(savedFindings(lines)).toEqual(new Map());
  });
});
