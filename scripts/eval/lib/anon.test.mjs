import { describe, expect, it } from 'vitest';
import { anonymize, applyKey } from './anon.mjs';

const kept = (claim) => ({
  file: 'src/a.ts',
  start_line: 3,
  end_line: 4,
  matchedLine: 3,
  matchedEndLine: 4,
  quote: 'q',
  claim,
  why_it_breaks: 'because',
  severity: 'P1',
  confidence: 'high',
});

const run = (over) => ({
  type: 'run',
  runId: 'run-secret-1',
  batch: 3,
  label: 'model-alpha',
  provider: 'vendor-one',
  findModel: 'vendor-one/model-alpha-large',
  verifyModel: null,
  pr: '895',
  head: 'abc123',
  draw: 1,
  attempt: 1,
  mode: 'find',
  findingsFile: 'findings/alpha.json',
  results: [],
  exit: 0,
  error: null,
  ...over,
});

const files = {
  'findings/alpha.json': { findModel: 'vendor-one/model-alpha-large', kept: [kept('claim A')] },
  'findings/beta.json': { findModel: 'vendor-two/model-beta', kept: [kept('claim B')] },
};
const read = (name) => files[name];

const runs = [
  run({}),
  run({ runId: 'run-secret-2', label: 'model-beta', provider: 'vendor-two', findModel: 'vendor-two/model-beta', findingsFile: 'findings/beta.json', pr: '930', head: 'def456', draw: 2, attempt: 2 }),
  run({ runId: 'run-secret-3', label: 'model-gamma', provider: 'vendor-three', findModel: 'vendor-three/gamma', exit: 5, error: 'failed', findingsFile: null }),
  run({
    runId: 'run-secret-4',
    label: 'model-delta',
    provider: 'vendor-four',
    findModel: 'vendor-four/delta',
    mode: 'whole',
    findingsFile: null,
    results: [{ file: 'b.ts', line: 7, severity: 'P2', confidence: 'low', quote: 'z', claim: 'claim D', whyItBreaks: 'why', verdict: 'confirmed', evidence: 'seen', extra: 'x' }],
  }),
];

describe('anonymize', () => {
  it('leaks no label, model, provider, run id or find model', () => {
    const text = JSON.stringify(anonymize({ runs, read }).items);
    for (const secret of ['model-alpha', 'model-beta', 'model-delta', 'vendor-one', 'vendor-two', 'vendor-four', 'run-secret-1', 'run-secret-4', 'large']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps only the graded fields of a kept finding', () => {
    const { items } = anonymize({ runs: [runs[0]], read });
    expect(items).toEqual([
      {
        id: items[0].id,
        pr: '895',
        head: 'abc123',
        stage: 'find',
        findings: [{ file: 'src/a.ts', line: 3, severity: 'P1', confidence: 'high', quote: 'q', claim: 'claim A', whyItBreaks: 'because' }],
      },
    ]);
  });

  it('takes the results of a whole run with verdict and evidence, and nothing else', () => {
    const { items } = anonymize({ runs: [runs[3]], read });
    expect(items[0].findings).toEqual([
      { file: 'b.ts', line: 7, severity: 'P2', confidence: 'low', quote: 'z', claim: 'claim D', whyItBreaks: 'why', verdict: 'confirmed', evidence: 'seen' },
    ]);
  });

  it('skips a run that did not close clean', () => {
    const { items, key } = anonymize({ runs, read });
    expect(items.length).toBe(3);
    expect(Object.values(key).map((k) => k.label)).toEqual(['model-alpha', 'model-beta', 'model-delta']);
  });

  it('skips a run marked as an expected failure even if it closed clean', () => {
    const { items } = anonymize({ runs: [run({ expectFailure: true })], read });
    expect(items).toEqual([]);
  });

  it('gives each item a distinct id and writes the key by that id', () => {
    const { items, key } = anonymize({ runs, read, shuffle: (list) => list });
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(key[items[1].id]).toEqual({ label: 'model-beta', draw: 2, pr: '930', batch: 3, attempt: 2 });
  });

  it('lets shuffle set the order while the key stays right', () => {
    const { items, key } = anonymize({ runs, read, shuffle: (list) => [...list].reverse() });
    expect(items.map((i) => key[i.id].label)).toEqual(['model-delta', 'model-beta', 'model-alpha']);
  });
});

describe('suspects', () => {
  const leaky = { findModel: 'vendor-one/model-alpha-large', kept: [{ ...kept('this was found by vendor-one/model-alpha-large'), start_line: 1 }] };

  it('names the item whose text holds the run own model id', () => {
    const { items, suspects } = anonymize({ runs: [runs[0]], read: () => leaky });
    expect(suspects).toEqual([items[0].id]);
  });

  it('names the item whose text holds the run own label', () => {
    const { items, suspects } = anonymize({ runs: [runs[0]], read: () => ({ kept: [kept('model-alpha says so')] }) });
    expect(suspects).toEqual([items[0].id]);
  });

  it('is empty for clean runs', () => {
    expect(anonymize({ runs, read }).suspects).toEqual([]);
  });
});

describe('judges', () => {
  const verifyRun = (judge, runId) =>
    run({ runId, mode: 'verify', findingsFile: null, verifyModel: judge, results: [{ file: 'b.ts', line: 7, severity: 'P2', confidence: 'low', quote: 'z', claim: 'c', whyItBreaks: 'w', verdict: 'confirmed', evidence: 'e' }] });

  it('keys each judge of one find apart', () => {
    const { key } = anonymize({ runs: [verifyRun('judge-x', 'r1'), verifyRun('judge-y', 'r2')], read });
    expect(Object.values(key).map((k) => k.label)).toEqual(['model-alpha@judge-x', 'model-alpha@judge-y']);
  });

  it('keeps the plain label for a find', () => {
    expect(Object.values(anonymize({ runs: [runs[0]], read }).key).map((k) => k.label)).toEqual(['model-alpha']);
  });
});

describe('applyKey', () => {
  it('throws naming both ids when two ids land on one label and draw', () => {
    const twin = { label: 'model-alpha', draw: 1, pr: '895', batch: 3, attempt: 1 };
    expect(() => applyKey({ u1: { findings: 1 }, u2: { findings: 2 } }, { u1: twin, u2: twin })).toThrow('u1 and u2');
  });
});

describe('applyKey', () => {
  const key = { u1: { label: 'model-alpha', draw: 1, pr: '895', batch: 3, attempt: 1 } };

  it('maps the scores to label and draw', () => {
    expect(applyKey({ u1: { defects: ['D1'], findings: 3 } }, key)).toEqual({ 'model-alpha': { 1: { defects: ['D1'], findings: 3 } } });
  });

  it('carries every field the grader gave', () => {
    expect(applyKey({ u1: { defects: [], findings: 1, corpus: { real: 1 } } }, key)).toEqual({
      'model-alpha': { 1: { defects: [], findings: 1, corpus: { real: 1 } } },
    });
  });

  it('throws naming an id that is not in the key', () => {
    expect(() => applyKey({ nope: { defects: [], findings: 0 } }, key)).toThrow('nope');
  });
});
