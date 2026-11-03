import { describe, expect, it } from 'vitest';
import { admitted, pickProfiles, proposeFinalists } from './profiles.mjs';

const row = (over) => ({
  label: 'x',
  route: 'openai',
  tier: 'mid',
  judge: 'gpt-5.5',
  judgeUsd: 0.2,
  pair: 'x + gpt-5.5',
  findDefects: ['D1', 'D2', 'D3'],
  publishedDefects: ['D1', 'D2', 'D3'],
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
  corpusFrom: null,
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

describe('a row with no judge', () => {
  const none = row({ label: 'none', route: 'anthropic', judgeUsd: 0.5 });

  it('ranks with the baseline judge cost added', () => {
    const rows = [row({ label: 'alone', judge: null, judgeUsd: null, productionUsd: 0.1 }), row({ label: 'paired', productionUsd: 0.4 })];
    expect(pickProfiles(rows, none).value.openai.row.label).toBe('paired');
  });

  it('wins when it stays cheaper with that cost added, and says the cost is estimated', () => {
    const alone = row({ label: 'alone', judge: null, judgeUsd: null, productionUsd: 0.1 });
    const cell = pickProfiles([alone, row({ label: 'paired', productionUsd: 0.7 })], none).value.openai;
    expect([cell.row.label, cell.note]).toEqual(['alone', 'judge cost estimated at $0.50 from the baseline']);
  });

  it('ranks a judge with no verify on #418 the same way, so a #930-only pair does not look cheap', () => {
    const rows = [row({ label: 'on930', judge: 'j', judgeUsd: null, productionUsd: 0.1 }), row({ label: 'paired', productionUsd: 0.4 })];
    expect(pickProfiles(rows, none).value.openai.row.label).toBe('paired');
  });

  it('keeps its productionUsd', () => {
    const alone = row({ label: 'alone', judge: null, judgeUsd: null, productionUsd: 0.1 });
    expect(pickProfiles([alone], none).value.openai.row.productionUsd).toBe(0.1);
  });

  it('says so when the baseline has no measured judge cost yet', () => {
    const alone = row({ label: 'alone', judge: null, judgeUsd: null, productionUsd: 0.1 });
    const cell = pickProfiles([alone], row({ label: 'none', route: 'anthropic', judgeUsd: null })).value.openai;
    expect(cell.note).toBe('no judge cost in the price yet');
  });
});

describe('who leaves the pool', () => {
  const none = row({ label: 'none', route: 'anthropic' });

  it('keeps an expensive row out of balanced', () => {
    const rows = [row({ label: 'dear', tier: 'expensive', medianPublished: 5, productionUsd: 0.1 }), row({ label: 'mid', medianPublished: 4, productionUsd: 1 })];
    expect(pickProfiles(rows, none).balanced.openai.row.label).toBe('mid');
  });

  it('keeps an expensive row out of best value', () => {
    const rows = [row({ label: 'dear', tier: 'expensive', productionUsd: 0.1 }), row({ label: 'mid', productionUsd: 1 })];
    expect(pickProfiles(rows, none).value.openai.row.label).toBe('mid');
  });

  it('lets an expensive row lead best of the best', () => {
    const rows = [row({ label: 'dear', tier: 'expensive', medianPublished: 5 }), row({ label: 'mid', medianPublished: 4 })];
    expect(pickProfiles(rows, none).best.openai.row.label).toBe('dear');
  });

  it('leaves balanced empty when only the expensive tier is within one defect', () => {
    const rows = [row({ label: 'dear', tier: 'expensive', medianPublished: 5 }), row({ label: 'far', medianPublished: 3 })];
    expect(pickProfiles(rows, none).balanced.openai).toEqual({ row: null, preliminary: false, note: 'nobody outside the expensive tier is within one defect of the leader' });
  });

  it('takes out a row with two refuted per run from every profile', () => {
    const rows = [row({ label: 'noisy', medianPublished: 5, refutedMean: 2 }), row({ label: 'quiet', medianPublished: 4, refutedMean: 1.5 })];
    const picks = pickProfiles(rows, none);
    expect([picks.best.openai.row.label, picks.balanced.openai.row.label, picks.value.openai.row.label]).toEqual(['quiet', 'quiet', 'quiet']);
  });

  it('keeps a row with no verify', () => {
    const rows = [row({ label: 'unverified', medianPublished: 5, refutedMean: null })];
    expect(pickProfiles(rows, none).best.openai.row.label).toBe('unverified');
  });

  it('says so when refuted emptied the route', () => {
    expect(pickProfiles([row({ label: 'noisy', refutedMean: 3 })], none).best.openai).toEqual({ row: null, preliminary: false, note: 'every row on this route left the pool' });
  });

  it('never offers a dropped candidate', () => {
    expect(pickProfiles([row({ label: 'gone', dropped: true })], none).best.openai).toEqual({ row: null, preliminary: false, note: 'every row on this route left the pool' });
  });
});

describe('balanced names what it gives up', () => {
  const none = row({ label: 'none', route: 'anthropic' });

  it('names the defect lost against the leader and the saving per PR', () => {
    const rows = [
      row({ label: 'leader', medianPublished: 5, productionUsd: 0.5, publishedDefects: ['D1', 'D2', 'D3', 'D4', 'D5'] }),
      row({ label: 'close', medianPublished: 4, productionUsd: 0.2, publishedDefects: ['D1', 'D2', 'D3', 'D4'] }),
    ];
    expect(pickProfiles(rows, none).balanced.openai.note).toBe('loses D5 against leader; saves $0.30 per PR');
  });

  it('says nothing when the leader is the cheapest', () => {
    expect(pickProfiles([row({ label: 'leader' })], none).balanced.openai.note).toBe('');
  });

  it('says no defect is named when the unions match', () => {
    const rows = [row({ label: 'leader', medianPublished: 5, productionUsd: 0.5 }), row({ label: 'close', medianPublished: 4, productionUsd: 0.2 })];
    expect(pickProfiles(rows, none).balanced.openai.note).toBe('loses no named defect against leader; saves $0.30 per PR');
  });
});

describe('a pair with the corpus of its finder', () => {
  it('is admitted on those counts, and the cell says whose they are', () => {
    const inherited = row({ label: 'heir', route: 'anthropic', corpusFrom: 'other-judge' });
    const cell = pickProfiles([inherited], baseline).best.anthropic;
    expect([admitted(inherited).ok, cell.row.label, cell.preliminary, cell.note]).toEqual([true, 'heir', false, "corpus counts from the finder's run with other-judge"]);
  });
});

describe('the pairs of one finder', () => {
  it('compares a pair with the baseline pair, not the baseline label', () => {
    const other = row({ label: 'base', judge: 'cheap-judge', medianPublished: 5, medianRecall930: null });
    const cell = pickProfiles([baseline, other], baseline).best.openai;
    expect([cell.row.judge, cell.note]).toEqual(['gpt-5.5', 'the lead over the baseline is not confirmed on #930, so the baseline stays']);
  });
});

describe('proposeFinalists', () => {
  it('lists the labels leading any profile, without the baseline, once each', () => {
    const rows = [baseline, row({ label: 'a', medianPublished: 5, medianRecall930: 3 }), row({ label: 'b', route: 'anthropic', medianPublished: 4 })];
    expect(proposeFinalists(pickProfiles(rows, baseline), 'base')).toEqual(['a', 'b']);
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
