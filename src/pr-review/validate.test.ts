import { describe, it, expect } from 'vitest';
import { isFindings, isReviewState, isVerdicts } from './validate.js';

const finding = {
  file: 'a.ts',
  start_line: 3,
  end_line: 4,
  quote: 'x',
  claim: 'c',
  why_it_breaks: 'w',
  severity: 'P1',
  confidence: 'high',
};

const stored = {
  file: 'a.ts',
  quote: 'x',
  matchedLine: 3,
  matchedEndLine: 4,
  claim: 'c',
  why_it_breaks: 'w',
  severity: 'P2',
  evidence: 'e',
};

const state = { v: 1, head: 'abc', findings: [stored], spend: { usd: 0.1, runs: 2, unpriced: 0 } };

const verdict = { index: 1, verdict: 'confirmed', evidence: 'e' };

describe('isFindings', () => {
  it('accepts a well-formed payload', () => {
    expect(isFindings({ findings: [finding] })).toBe(true);
    expect(isFindings({ findings: [] })).toBe(true);
  });
  it('rejects a non-integer start_line', () => {
    expect(isFindings({ findings: [{ ...finding, start_line: 1.5 }] })).toBe(false);
  });
  it('rejects severity P3', () => {
    expect(isFindings({ findings: [{ ...finding, severity: 'P3' }] })).toBe(false);
  });
  it('rejects an array and null', () => {
    expect(isFindings([finding])).toBe(false);
    expect(isFindings(null)).toBe(false);
  });
});

describe('isVerdicts', () => {
  it('accepts a well-formed payload', () => {
    expect(isVerdicts({ verdicts: [verdict] })).toBe(true);
  });
  it('rejects verdict "error"', () => {
    expect(isVerdicts({ verdicts: [{ ...verdict, verdict: 'error' }] })).toBe(false);
  });
  it('rejects a non-integer index', () => {
    expect(isVerdicts({ verdicts: [{ ...verdict, index: 0.5 }] })).toBe(false);
  });
  it('rejects an array and null', () => {
    expect(isVerdicts([verdict])).toBe(false);
    expect(isVerdicts(null)).toBe(false);
  });
});

describe('isReviewState', () => {
  it('accepts a well-formed state', () => {
    expect(isReviewState(state)).toBe(true);
  });
  it('rejects a non-integer spend.runs', () => {
    expect(isReviewState({ ...state, spend: { ...state.spend, runs: 1.5 } })).toBe(false);
  });
  it('rejects v: 2', () => {
    expect(isReviewState({ ...state, v: 2 })).toBe(false);
  });
  it('rejects a non-integer matchedLine', () => {
    expect(isReviewState({ ...state, findings: [{ ...stored, matchedLine: 1.5 }] })).toBe(false);
  });
  it('accepts a state with a string scope and one without, and rejects a non-string scope', () => {
    expect(isReviewState({ ...state, scope: 'abc' })).toBe(true);
    expect(isReviewState({ ...state, scope: 1 })).toBe(false);
  });
  it('rejects an array and null', () => {
    expect(isReviewState([state])).toBe(false);
    expect(isReviewState(null)).toBe(false);
  });
});

describe('isFindings: required fields', () => {
  it('rejects a payload without a findings key', () => {
    expect(isFindings({})).toBe(false);
  });
  it('rejects a non-string quote', () => {
    expect(isFindings({ findings: [{ ...finding, quote: 5 }] })).toBe(false);
  });
});
