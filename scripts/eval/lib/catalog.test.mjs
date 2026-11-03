import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, priceOf } from './catalog.mjs';

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
    expect(priceOf(catalog, 'gpt-5.5-2026-01-01')).toEqual({ input: 5, output: 30 });
  });

  it('prefers the exact id to a shorter prefix', () => {
    expect(priceOf(catalog, 'gpt-5.6-sol')).toEqual({ input: 4, cacheWrite: 5, output: 20 });
  });

  it('finds a candidate by its provider id', () => {
    expect(priceOf(catalog, 'moonshotai/kimi-k3.1-pro')).toEqual({ input: 2, output: 10 });
  });

  it('gives null for an unknown model', () => {
    expect(priceOf(catalog, 'невідома')).toBeNull();
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
});
