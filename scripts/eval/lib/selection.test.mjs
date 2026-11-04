import { describe, expect, it } from 'vitest';
import { checkLabels, isUnstable, survivors } from './selection.mjs';

const score = (defects, findings = 4) => ({ defects, findings });

describe('isUnstable', () => {
  it('flags a difference of two defects', () => {
    expect(isUnstable({ 1: score(['D1', 'D2', 'D3']), 2: score(['D1']) })).toBe(true);
  });

  it('keeps a difference of one defect stable', () => {
    expect(isUnstable({ 1: score(['D1', 'D2']), 2: score(['D1']) })).toBe(false);
  });

  it('flags findings that differ twofold', () => {
    expect(isUnstable({ 1: score(['D1'], 3), 2: score(['D1'], 6) })).toBe(true);
  });

  it('keeps findings of 3 and 5 stable', () => {
    expect(isUnstable({ 1: score(['D1'], 3), 2: score(['D1'], 5) })).toBe(false);
  });

  it('treats two empty draws as stable', () => {
    expect(isUnstable({ 1: score([], 0), 2: score([], 0) })).toBe(false);
  });
});

describe('survivors', () => {
  it('keeps the labels with two defects in batch 3 for batch 4', () => {
    const scores = { 3: { a: { 1: score(['D1', 'D2']) }, b: { 1: score(['D1']) }, c: { 1: score(['D1', 'D2', 'D3']) } } };
    expect(survivors(4, scores)).toEqual(['a', 'c']);
  });

  it('keeps the stable labels with two defects in draw 1 of batch 5 for batch 6', () => {
    const scores = {
      5: {
        steady: { 1: score(['D1', 'D2']), 2: score(['D1', 'D2']) },
        shaky: { 1: score(['D1', 'D2', 'D3']), 2: score(['D1']) },
        weak: { 1: score(['D1']), 2: score(['D1']) },
      },
    };
    expect(survivors(6, scores)).toEqual(['steady']);
  });

  it('throws for a batch without a rule', () => {
    expect(() => survivors(2, {})).toThrow('batch 2 has no selection rule');
  });
});

describe('checkLabels', () => {
  const scoresByBatch = { 3: { a: { 1: score(['D1', 'D2']) }, b: { 1: score(['D1']) } } };

  it('refuses batch 4 without the scores of batch 3', () => {
    expect(checkLabels({ batch: 4, labels: ['a'], scoresByBatch: {} })).toBe('batch 4 needs the scores of batch 3');
  });

  it('names a label that did not survive', () => {
    expect(checkLabels({ batch: 4, labels: ['a', 'b'], scoresByBatch })).toBe('batch 4: b did not survive batch 3');
  });

  it('accepts the survivors', () => {
    expect(checkLabels({ batch: 4, labels: ['a'], scoresByBatch })).toBe(null);
  });

  it('refuses six labels in batch 7', () => {
    expect(checkLabels({ batch: 7, labels: ['a', 'b', 'c', 'd', 'e', 'f'], scoresByBatch: {} })).toBe(
      'batch 7 takes at most 5 labels, got 6',
    );
  });

  it('refuses three labels in batch 101', () => {
    expect(checkLabels({ batch: 101, labels: ['a', 'b', 'c'], scoresByBatch: {} })).toBe('batch 101 takes at most 2 labels, got 3');
  });

  it('has no objection to batch 2', () => {
    expect(checkLabels({ batch: 2, labels: [], scoresByBatch: {} })).toBe(null);
  });
});

describe('checkLabels: the second try', () => {
  const scoresByBatch = { 107: { a: { 1: score(['D1', 'D2']) }, b: { 1: score(['D1']) } }, 108: { c: { 1: score([]) } } };

  it('refuses the later draws before the first one is scored', () => {
    expect(checkLabels({ batch: 109, labels: ['a'], scoresByBatch: {} })).toBe('batch 109 needs the scores of batch 107');
  });

  it('ends the try at one known defect, and for a model that never ran', () => {
    expect(checkLabels({ batch: 109, labels: ['a', 'b', 'z'], scoresByBatch })).toBe('batch 109: b, z found under 2 known defects in batch 107');
  });

  it('reads the first draw of its own setting', () => {
    expect(checkLabels({ batch: 110, labels: ['c'], scoresByBatch })).toBe('batch 110: c found under 2 known defects in batch 108');
    expect(checkLabels({ batch: 110, labels: ['a'], scoresByBatch })).toBe('batch 110: a found under 2 known defects in batch 108');
  });

  it('lets two known defects through', () => {
    expect(checkLabels({ batch: 109, labels: ['a'], scoresByBatch })).toBe(null);
  });

  it('asks nothing of the first draws', () => {
    expect(checkLabels({ batch: 107, labels: ['z'], scoresByBatch: {} })).toBe(null);
  });
});

describe('checkLabels batch 7', () => {
  const scoresByBatch = { 2: { a: { 1: score(['D1']) } }, 5: { b: { 1: score(['D1']) } } };

  it('accepts labels scored in any of batches 2-6', () => {
    expect(checkLabels({ batch: 7, labels: ['a', 'b'], scoresByBatch })).toBe(null);
  });

  it('names a label with no score in any of them', () => {
    expect(checkLabels({ batch: 7, labels: ['a', 'c'], scoresByBatch })).toBe('batch 7: c has no score in batches 2-6');
  });

  it('ignores the scores of other batches', () => {
    expect(checkLabels({ batch: 7, labels: ['a'], scoresByBatch: { 1: { a: { 1: score(['D1']) } } } })).toBe('batch 7: a has no score in batches 2-6');
  });

  it('leaves the scores of batches 101-106 out of the rule', () => {
    expect(checkLabels({ batch: 101, labels: ['z'], scoresByBatch: {} })).toBe(null);
  });
});
