import { describe, test, expect } from 'vitest';
import { parseConfig, DEFAULT_CONFIG, type Config } from './config.js';

const DEFAULTS = {
  language: 'uk',
  specFile: 'spec.md',
  specsDir: 'docs/specs',
  plansDir: 'docs/plans',
  gate: 'npm test && npm run typecheck',
  baseBranch: 'origin/main',
  tmpDir: 'tmp',
  reviewers: ['codex', 'claude', 'agy'],
  models: { codex: 'gpt-6.1-sol', agy: 'gemini-4-argon' },
};

describe('DEFAULT_CONFIG', () => {
  test('is the config from the spec, with no reviewContext', () => {
    expect(DEFAULT_CONFIG).toEqual(DEFAULTS);
  });
});

describe('parseConfig — no file or an empty object', () => {
  test('no file gives the defaults', () => {
    expect(parseConfig(null)).toEqual({ ok: true, config: DEFAULTS });
  });
  test('an empty object gives the defaults', () => {
    expect(parseConfig('{}')).toEqual({ ok: true, config: DEFAULTS });
  });
  test('a caller changing the returned config does not change the next defaults', () => {
    const first = parseConfig(null) as { ok: true; config: Config };
    first.config.reviewers.push('claude');
    first.config.models.claude = 'x';
    expect(parseConfig(null)).toEqual({ ok: true, config: DEFAULTS });
  });
  test('a leading BOM is not content', () => {
    expect(parseConfig('﻿{"tmpDir":"build/tmp"}')).toEqual({ ok: true, config: { ...DEFAULTS, tmpDir: 'build/tmp' } });
  });
});

describe('parseConfig — shallow merge', () => {
  test('a string key from the file replaces its default, the rest stay', () => {
    expect(parseConfig('{"baseBranch":"origin/dev","language":"en"}')).toEqual({
      ok: true, config: { ...DEFAULTS, baseBranch: 'origin/dev', language: 'en' },
    });
  });
  test('every string key is read from the file', () => {
    expect(parseConfig(JSON.stringify({
      language: 'en', specFile: 'S.md', specsDir: 'specs', plansDir: 'plans', gate: 'make', baseBranch: 'main', tmpDir: '.t',
    }))).toEqual({
      ok: true,
      config: {
        language: 'en', specFile: 'S.md', specsDir: 'specs', plansDir: 'plans', gate: 'make', baseBranch: 'main', tmpDir: '.t',
        reviewers: ['codex', 'claude', 'agy'], models: { codex: 'gpt-6.1-sol', agy: 'gemini-4-argon' },
      },
    });
  });
  test('models in the file replace the default models whole', () => {
    expect(parseConfig('{"models":{"claude":"claude-opus-5-5"}}')).toEqual({
      ok: true, config: { ...DEFAULTS, models: { claude: 'claude-opus-5-5' } },
    });
  });
  test('an empty models object drops every pin', () => {
    expect(parseConfig('{"models":{}}')).toEqual({ ok: true, config: { ...DEFAULTS, models: {} } });
  });
  test('reviewers in the file replace the default order', () => {
    expect(parseConfig('{"reviewers":["agy","codex"]}')).toEqual({ ok: true, config: { ...DEFAULTS, reviewers: ['agy', 'codex'] } });
  });
  test('an empty reviewers list is a valid config (selection reports it)', () => {
    expect(parseConfig('{"reviewers":[]}')).toEqual({ ok: true, config: { ...DEFAULTS, reviewers: [] } });
  });
  test('duplicate reviewers are kept as written (selection takes the first)', () => {
    expect(parseConfig('{"reviewers":["codex","agy","codex"]}')).toEqual({
      ok: true, config: { ...DEFAULTS, reviewers: ['codex', 'agy', 'codex'] },
    });
  });
  test('reviewContext is read as is', () => {
    expect(parseConfig('{"reviewContext":"one host, SQLite"}')).toEqual({
      ok: true, config: { ...DEFAULTS, reviewContext: 'one host, SQLite' },
    });
  });
  test('unknown top-level keys are ignored: the harness reads them', () => {
    expect(parseConfig('{"someFutureKey":[1,2],"tmpDir":"t"}')).toEqual({ ok: true, config: { ...DEFAULTS, tmpDir: 't' } });
  });
  test('a __proto__ key at the top level is ignored like any unknown key', () => {
    expect(parseConfig('{"__proto__":{"tmpDir":"evil"}}')).toEqual({ ok: true, config: DEFAULTS });
  });
});

describe('parseConfig — errors', () => {
  test('an empty file is not valid JSON', () => {
    expect(parseConfig('')).toEqual({ ok: false, error: 'detent.json is not valid JSON: Unexpected end of JSON input' });
  });
  test('truncated JSON is not valid JSON', () => {
    expect(parseConfig('{"tmpDir":')).toEqual({ ok: false, error: 'detent.json is not valid JSON: Unexpected end of JSON input' });
  });
  test('a JSON array is not a config', () => {
    expect(parseConfig('["codex"]')).toEqual({ ok: false, error: 'detent.json must be a JSON object' });
  });
  test('JSON null is not a config', () => {
    expect(parseConfig('null')).toEqual({ ok: false, error: 'detent.json must be a JSON object' });
  });
  test('a JSON string is not a config', () => {
    expect(parseConfig('"x"')).toEqual({ ok: false, error: 'detent.json must be a JSON object' });
  });
  test('a string key with a number is a type error', () => {
    expect(parseConfig('{"baseBranch":1}')).toEqual({ ok: false, error: 'detent.json: "baseBranch" must be a string' });
  });
  test('a string key with null is a type error', () => {
    expect(parseConfig('{"tmpDir":null}')).toEqual({ ok: false, error: 'detent.json: "tmpDir" must be a string' });
  });
  test('reviewers as a string is a type error', () => {
    expect(parseConfig('{"reviewers":"codex"}')).toEqual({ ok: false, error: 'detent.json: "reviewers" must be an array of reviewer ids' });
  });
  test('a non-string reviewer id is a type error', () => {
    expect(parseConfig('{"reviewers":["codex",3]}')).toEqual({ ok: false, error: 'detent.json: "reviewers" must be an array of reviewer ids' });
  });
  test('an unknown reviewer id is named', () => {
    expect(parseConfig('{"reviewers":["codex","gemini"]}')).toEqual({
      ok: false, error: 'detent.json: unknown reviewer "gemini" in "reviewers" (expected claude|codex|agy)',
    });
  });
  test('an empty reviewer id is an unknown id', () => {
    expect(parseConfig('{"reviewers":[""]}')).toEqual({
      ok: false, error: 'detent.json: unknown reviewer "" in "reviewers" (expected claude|codex|agy)',
    });
  });
  test('models as an array is a type error', () => {
    expect(parseConfig('{"models":["gpt-6.1-sol"]}')).toEqual({ ok: false, error: 'detent.json: "models" must be an object' });
  });
  test('models as null is a type error', () => {
    expect(parseConfig('{"models":null}')).toEqual({ ok: false, error: 'detent.json: "models" must be an object' });
  });
  test('an empty model string is an error: it must never silently drop a pin', () => {
    expect(parseConfig('{"models":{"claude":""}}')).toEqual({ ok: false, error: 'detent.json: "models.claude" must be a non-empty string' });
  });
  test('a non-string model is an error', () => {
    expect(parseConfig('{"models":{"codex":5}}')).toEqual({ ok: false, error: 'detent.json: "models.codex" must be a non-empty string' });
  });
  test('a model for an unknown reviewer is named', () => {
    expect(parseConfig('{"models":{"gemini":"gemini-4-argon"}}')).toEqual({
      ok: false, error: 'detent.json: unknown reviewer "gemini" in "models" (expected claude|codex|agy)',
    });
  });
  test('a foreign model for agy is accepted here: selection rejects it with its reason', () => {
    expect(parseConfig('{"models":{"agy":"claude-opus-5-5"}}')).toEqual({
      ok: true, config: { ...DEFAULTS, models: { agy: 'claude-opus-5-5' } },
    });
  });
  test('reviewContext with a non-string is a type error', () => {
    expect(parseConfig('{"reviewContext":["a"]}')).toEqual({ ok: false, error: 'detent.json: "reviewContext" must be a string' });
  });
});

describe('prReview', () => {
  const pr = (v: unknown) => parseConfig(JSON.stringify({ prReview: v }));
  test('a valid prReview is kept', () => {
    const prReview = { provider: 'openrouter', include: ['src/**'], ignore: ['a'], bodyExclude: ['b'], bodyInclude: ['c'], findModel: 'f', verifyModel: 'v' };
    expect(pr(prReview)).toEqual({ ok: true, config: { ...DEFAULTS, prReview } });
  });
  test('a valid openrouterOnly is kept', () => {
    const prReview = { openrouterOnly: { find: ['moonshotai'], verify: ['openai', 'azure'] } };
    expect(pr(prReview)).toEqual({ ok: true, config: { ...DEFAULTS, prReview } });
  });
  test('openrouterOnly may name one stage', () => {
    const prReview = { openrouterOnly: { verify: ['openai'] } };
    expect(pr(prReview)).toEqual({ ok: true, config: { ...DEFAULTS, prReview } });
  });
  test('an unknown key in openrouterOnly is named', () => {
    expect(pr({ openrouterOnly: { judge: ['a'] } })).toEqual({ ok: false, error: 'detent.json: unknown key "judge" in "prReview.openrouterOnly"' });
  });
  test('openrouterOnly must be an object', () => {
    expect(pr({ openrouterOnly: ['a'] })).toEqual({ ok: false, error: 'detent.json: "prReview.openrouterOnly" must be an object' });
  });
  test.each([
    ['an empty list', []],
    ['a blank name', ['']],
    ['a string', 'openai'],
    ['a number in the list', [1]],
  ])('openrouterOnly.find refuses %s', (_name, find) => {
    expect(pr({ openrouterOnly: { find } })).toEqual({ ok: false, error: 'detent.json: "prReview.openrouterOnly.find" must be a non-empty array of non-empty strings' });
  });
  test('an absent prReview leaves no field', () => {
    const r = parseConfig('{}');
    expect(r.ok && 'prReview' in r.config).toBe(false);
  });
  test('an unknown key is named', () => {
    expect(pr({ endpoint: 'x' })).toEqual({ ok: false, error: 'detent.json: unknown key "endpoint" in "prReview"' });
  });
  test.each([
    ['unknown provider', { provider: 'x' }],
    ['include string', { include: 'a' }],
    ['include non-string item', { include: [1] }],
    ['empty findModel', { findModel: '' }],
    ['non-object', 'x'],
  ])('%s is an error', (_n, v) => {
    expect(pr(v).ok).toBe(false);
  });
});
