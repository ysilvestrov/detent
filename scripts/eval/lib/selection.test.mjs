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
