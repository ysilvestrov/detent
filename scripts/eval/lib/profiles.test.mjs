import { describe, expect, it } from 'vitest';
import { admitted, pickProfiles } from './profiles.mjs';

const row = (over) => ({
  label: 'x',
  route: 'openai',
  pair: 'x + gpt-5.5',
  draws: 3,
  perDraw: [3, 3, 3],
  medianKnown: 3,
  union: 3,
  medianPublished: 3,
  refutedMean: 0,
  errorShare: 0,
  paidUsd: 1,
  productionUsd: 0.5,
  composite: false,
  unstable: false,
  corpus: { real: 4, false: 0, unfalsifiable: 0, published: 4, prs: 5 },
  judgeConsensus: 15,
  brokenCalls: 0,
  medianRecall930: 2,
  ...over,
});

const baseline = row({ label: 'base', medianPublished: 4, medianRecall930: 2, productionUsd: 0.6 });

describe('admitted', () => {
  it('lets a clean row in', () => {
    expect(admitted(row({}))).toEqual({ ok: true, reasons: [] });
  });

  it('refuses a false finding on the corpus', () => {
    expect(admitted(row({ corpus: { real: 4, false: 1, unfalsifiable: 0, published: 4, prs: 5 } }))).toEqual({
      ok: false,
      reasons: ['1 false findings on the corpus'],
    });
  });

  it('refuses two published findings on the corpus', () => {
    expect(admitted(row({ corpus: { real: 2, false: 0, unfalsifiable: 0, published: 2, prs: 5 } })).reasons).toEqual([
      '2 published findings on the corpus, needs 3',
    ]);
  });

  it('refuses fewer than three corpus PRs', () => {
    expect(admitted(row({ corpus: { real: 4, false: 0, unfalsifiable: 0, published: 4, prs: 2 } })).reasons).toEqual(['corpus has 2 PRs, needs 3']);
  });

  it('refuses a judge consensus of 13', () => {
    expect(admitted(row({ judgeConsensus: 13 })).reasons).toEqual(['judge consensus 13 of 15, needs 14']);
  });

  it('refuses two broken calls', () => {
    expect(admitted(row({ brokenCalls: 2 })).reasons).toEqual(['2 empty or broken calls, at most 1']);
  });
});

describe('best of the best', () => {
  it('takes the larger median', () => {
    const rows = [baseline, row({ label: 'a', medianPublished: 5, medianRecall930: 3 }), row({ label: 'b', medianPublished: 4, medianRecall930: 3 })];
    expect(pickProfiles(rows, baseline).best.openai.row.label).toBe('a');
  });

  it('keeps the baseline when the lead is not confirmed on #930', () => {
    const rows = [baseline, row({ label: 'a', medianPublished: 5, medianRecall930: null })];
    const cell = pickProfiles(rows, baseline).best.openai;
    expect([cell.row.label, cell.note]).toEqual(['base', 'the lead over the baseline is not confirmed on #930, so the baseline stays']);
  });

  it('breaks a tie by #930 and then by price', () => {
    const rows = [
      row({ label: 'dear', medianPublished: 5, medianRecall930: 3, productionUsd: 2 }),
      row({ label: 'cheap', medianPublished: 5, medianRecall930: 3, productionUsd: 1 }),
      row({ label: 'weak930', medianPublished: 5, medianRecall930: 1, productionUsd: 0.1 }),
    ];
    expect(pickProfiles(rows, row({ label: 'none', route: 'anthropic' })).best.openai.row.label).toBe('cheap');
  });
});

describe('balanced', () => {
  it('takes the cheapest within one defect of the leader on #418 and #930', () => {
    const rows = [
      row({ label: 'leader', medianPublished: 5, medianRecall930: 3, productionUsd: 3 }),
      row({ label: 'close', medianPublished: 4, medianRecall930: 2, productionUsd: 1 }),
      row({ label: 'far418', medianPublished: 3, medianRecall930: 3, productionUsd: 0.1 }),
      row({ label: 'far930', medianPublished: 5, medianRecall930: 1, productionUsd: 0.2 }),
    ];
    expect(pickProfiles(rows, row({ label: 'none', route: 'anthropic' })).balanced.openai.row.label).toBe('close');
  });
});

describe('best value', () => {
  it('takes the cheapest with 3 on #418 and 1 on #930', () => {
    const rows = [
      row({ label: 'dear', medianPublished: 5, medianRecall930: 3, productionUsd: 3 }),
      row({ label: 'fit', medianPublished: 3, medianRecall930: 1, productionUsd: 1 }),
      row({ label: 'low418', medianPublished: 2, medianRecall930: 3, productionUsd: 0.1 }),
      row({ label: 'zero930', medianPublished: 4, medianRecall930: 0, productionUsd: 0.2 }),
    ];
    expect(pickProfiles(rows, row({ label: 'none', route: 'anthropic' })).value.openai.row.label).toBe('fit');
  });

  it('breaks a tie by fewer refuted', () => {
    const rows = [row({ label: 'refutes', productionUsd: 1, refutedMean: 2 }), row({ label: 'quiet', productionUsd: 1, refutedMean: 0 })];
    expect(pickProfiles(rows, row({ label: 'none', route: 'anthropic' })).value.openai.row.label).toBe('quiet');
  });
});

describe('preliminary cells and empty routes', () => {
  it('marks a row without the admission preliminary instead of leaving the cell empty', () => {
    const weak = row({ label: 'weak', route: 'anthropic', judgeConsensus: 12 });
    const cell = pickProfiles([weak], baseline).best.anthropic;
    expect([cell.row.label, cell.preliminary, cell.note]).toEqual(['weak', true, 'not admitted: judge consensus 12 of 15, needs 14; nobody on the route passed the admission']);
  });

  it('marks an admitted row without #930 preliminary', () => {
    const cell = pickProfiles([row({ label: 'a', route: 'anthropic', medianRecall930: null })], baseline).best.anthropic;
    expect([cell.row.label, cell.preliminary]).toEqual(['a', true]);
  });

  it('leaves a route nobody is on with no row', () => {
    expect(pickProfiles([baseline], baseline).value.openrouter).toEqual({ row: null, preliminary: false, note: 'no row on this route' });
  });

  it('says so when nobody on the route reaches best value', () => {
    const low = row({ label: 'low', route: 'openrouter', medianPublished: 2 });
    expect(pickProfiles([low], baseline).value.openrouter).toEqual({ row: null, preliminary: false, note: 'nobody reaches 3 on #418 and 1 on #930' });
  });
});

describe('rows ranked on find-stage scores', () => {
  it('marks a leader without a published median preliminary and says why', () => {
    const rows = [row({ label: 'found', route: 'openrouter', medianPublished: null, medianKnown: 4 })];
    const cell = pickProfiles(rows, baseline).best.openrouter;
    expect([cell.row.label, cell.preliminary, cell.note]).toEqual(['found', true, 'ranked on find-stage scores, no published median']);
  });

  it('never offers the generic-prompts row', () => {
    const rows = [row({ label: 'base (generic prompts)', generic: true, medianPublished: 9 }), baseline];
    expect(pickProfiles(rows, baseline).best.openai.row.label).toBe('base');
  });
});
