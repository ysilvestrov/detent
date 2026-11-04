import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, priceOf } from './catalog.mjs';
import { callUsd } from './records.mjs';

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'candidates.json'), 'utf8');
const catalog = loadCatalog(text);
const byLabel = (label) => catalog.candidates.find((c) => c.label === label);
const countTier = (tier) => catalog.candidates.filter((c) => c.tier === tier).length;

describe('candidates.json', () => {
  it('has the baseline and twenty candidates', () => {
    expect(catalog.baseline).toEqual({ label: 'gpt-5.6-sol', findModel: 'gpt-5.6-sol', verifyModel: 'gpt-5.5', route: 'openai' });
    expect(catalog.candidates).toHaveLength(20);
  });

  it('prices claude-haiku-5-5 as a cheap anthropic model', () => {
    expect(byLabel('claude-haiku-5-5')).toMatchObject({ route: 'anthropic', tier: 'cheap', price: { input: 0.1, output: 0.5 } });
  });

  it('prefixes an openrouter model with its vendor', () => {
    expect(byLabel('kimi-k3.1-pro')).toMatchObject({ model: 'moonshotai/kimi-k3.1-pro', route: 'openrouter' });
  });

  it('splits the candidates into 10 cheap, 7 mid and 3 expensive', () => {
    expect([countTier('cheap'), countTier('mid'), countTier('expensive')]).toEqual([10, 7, 3]);
  });

  it('names the recall and corpus pull requests', () => {
    expect([catalog.recallPrs, catalog.corpus]).toEqual([['418', '930'], ['344', '348', '352', '356', '358']]);
  });
});

describe('priceOf', () => {
  it('finds a dated model by the longest id it starts with', () => {
    expect(priceOf(catalog, 'gpt-5.5-2026-01-01')).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
  });

  it('prefers the exact id to a shorter prefix', () => {
    expect(priceOf(catalog, 'gpt-5.6-sol')).toEqual({ input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 });
  });

  it('finds a candidate by its provider id', () => {
    const small = { prices: {}, candidates: [{ model: 'vendor/m', price: { input: 2, output: 10 } }], judges: [] };
    expect(priceOf(small, 'vendor/m')).toEqual({ input: 2, output: 10 });
  });

  it('finds a judge by its model', () => {
    const small = { prices: {}, candidates: [], judges: [{ model: 'openai/j', only: null, price: { input: 5, output: 30 } }] };
    expect(priceOf(small, 'openai/j')).toEqual({ input: 5, output: 30 });
  });

  it('gives null for an unknown model', () => {
    expect(priceOf(catalog, 'невідома')).toBeNull();
  });
});

describe('the OpenAI pricing page, 2026-11-04', () => {
  it.each([
    ['gpt-6.1-terra', { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 }],
    ['gpt-6.1-sol', { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }],
    ['gpt-6-astra', { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
  ])('prices %s with its cache read and its 30-minute write', (label, price) => {
    expect(byLabel(label).price).toEqual(price);
  });
});

describe('the cached prices of the direct OpenAI models', () => {
  const cachedFind = { type: 'call', model: 'gpt-5.6-sol', usage: { prompt_tokens: 41400, completion_tokens: 4600, prompt_tokens_details: { cached_tokens: 40000 } } };

  it('prices a repeat find with 40k of 41.4k cached at what it cost', () => {
    expect(callUsd(cachedFind, catalog).usd).toBe(0.1136);
  });

  it('holds the rates of src/pr-review/usage.ts', () => {
    expect([catalog.prices['gpt-5.5'].cachedInput, catalog.prices['gpt-5.6-sol'].cachedInput]).toEqual([0.5, 0.4]);
  });
});

describe('the judges of candidates.json', () => {
  it('lists openai/gpt-5.5', () => {
    expect(catalog.judges.map((j) => j.model)).toEqual(['openai/gpt-5.5']);
  });
});

describe('loadCatalog', () => {
  it('names the missing baseline', () => {
    expect(() => loadCatalog('{}')).toThrow('baseline');
  });

  it('names the route a candidate lacks', () => {
    const broken = JSON.parse(text);
    delete broken.candidates[0].route;
    expect(() => loadCatalog(JSON.stringify(broken))).toThrow('route');
  });

  it('accepts a dropped row with its reason', () => {
    const edited = JSON.parse(text);
    edited.candidates[0].dropped = 'empty answer twice';
    expect(loadCatalog(JSON.stringify(edited)).candidates[0].dropped).toBe('empty answer twice');
  });

  it('refuses a dropped row with no reason', () => {
    const broken = JSON.parse(text);
    broken.candidates[0].dropped = '';
    expect(() => loadCatalog(JSON.stringify(broken))).toThrow('candidates[0].dropped');
  });

  it.each([
    ['no judges', (c) => delete c.judges, 'invalid or missing judges'],
    ['a judge with no model', (c) => delete c.judges[0].model, 'judges[0].model'],
    ['a judge with a bad pin', (c) => (c.judges[0].only = 'host'), 'judges[0].only'],
    ['a judge with no price', (c) => delete c.judges[0].price, 'judges[0].price'],
  ])('refuses %s', (_name, spoil, message) => {
    const broken = JSON.parse(text);
    spoil(broken);
    expect(() => loadCatalog(JSON.stringify(broken))).toThrow(message);
  });
});
