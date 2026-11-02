import { describe, it, expect } from 'vitest';
import { PROVIDERS, PROVIDER_IDS, isProviderId, resolveModels, selectProvider } from './providers.js';
import { callStructured } from './openai.js';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
const msgs = [{ role: 'user' as const, content: 'hi' }];
const fmt = { name: 'review', schema: SCHEMA };

describe('providers table', () => {
  it('table', () => {
    expect(PROVIDERS.openai).toMatchObject({ endpoint: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', defaultModels: { find: 'gpt-5.6-sol', verify: 'gpt-5.5' } });
    expect(PROVIDERS.anthropic).toMatchObject({ endpoint: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' });
    expect(PROVIDERS.openrouter).toMatchObject({ endpoint: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', extraBody: { provider: { require_parameters: true } } });
  });
  it('ids', () => {
    expect([...PROVIDER_IDS]).toEqual(['openai', 'anthropic', 'openrouter']);
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('x')).toBe(false);
  });
});

describe('selectProvider', () => {
  it('one key picks its provider', () => {
    const r = selectProvider(undefined, { ANTHROPIC_API_KEY: 'k' });
    expect(r).toMatchObject({ kind: 'ok', apiKey: 'k', provider: { id: 'anthropic' } });
  });
  it('configured with its own key is ok even when others are set', () => {
    const r = selectProvider('openai', { OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' });
    expect(r).toMatchObject({ kind: 'ok', apiKey: 'a', provider: { id: 'openai' } });
  });
  it('configured without its key is no-key naming the variable', () => {
    expect(selectProvider('anthropic', { OPENAI_API_KEY: 'a' })).toEqual({ kind: 'no-key', wanted: 'ANTHROPIC_API_KEY' });
  });
  it('two keys without configured is ambiguous with both names', () => {
    expect(selectProvider(undefined, { OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' })).toEqual({
      kind: 'ambiguous',
      keys: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
    });
  });
  it('no keys is no-key', () => {
    expect(selectProvider(undefined, {}).kind).toBe('no-key');
  });
  it('empty or whitespace is not a key', () => {
    expect(selectProvider(undefined, { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '  ' }).kind).toBe('no-key');
    expect(selectProvider('openai', { OPENAI_API_KEY: ' ' })).toEqual({ kind: 'no-key', wanted: 'OPENAI_API_KEY' });
    expect(selectProvider(undefined, { OPENAI_API_KEY: ' ', ANTHROPIC_API_KEY: 'b' })).toMatchObject({ kind: 'ok', provider: { id: 'anthropic' } });
  });
});

describe('resolveModels', () => {
  it('openai defaults', () => {
    expect(resolveModels(PROVIDERS.openai, {})).toEqual({ ok: true, find: 'gpt-5.6-sol', verify: 'gpt-5.5' });
  });
  it('configured models override', () => {
    expect(resolveModels(PROVIDERS.openai, { findModel: 'a', verifyModel: 'b' })).toEqual({ ok: true, find: 'a', verify: 'b' });
  });
  it('anthropic without findModel fails naming the key', () => {
    const r = resolveModels(PROVIDERS.anthropic, { verifyModel: 'v' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('prReview.findModel');
  });
  it('anthropic without verifyModel fails naming the key', () => {
    const r = resolveModels(PROVIDERS.anthropic, { findModel: 'f' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('prReview.verifyModel');
  });
});

describe('callStructured with a provider', () => {
  const okRes = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }) as unknown as Response;

  it('openrouter sends provider.require_parameters, to <endpoint>/chat/completions', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fetchFn = (async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body));
      return okRes();
    }) as unknown as typeof fetch;
    const p = PROVIDERS.openrouter;
    await callStructured({ endpoint: p.endpoint, apiKey: 'k', model: 'm', fetchFn, extraBody: p.extraBody }, msgs, fmt);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it('openai has no provider field and the body is the pinned string', async () => {
    let raw = '';
    const fetchFn = (async (_u: string, init: RequestInit) => {
      raw = String(init.body);
      return okRes();
    }) as unknown as typeof fetch;
    const p = PROVIDERS.openai;
    await callStructured({ endpoint: p.endpoint, apiKey: 'k', model: 'm', fetchFn, extraBody: p.extraBody }, msgs, fmt);
    expect(JSON.parse(raw)).not.toHaveProperty('provider');
    expect(raw).toBe(
      '{"model":"m","max_completion_tokens":8000,"response_format":{"type":"json_schema","json_schema":{"name":"review","strict":true,"schema":{"type":"object","properties":{},"additionalProperties":false}}},"messages":[{"role":"user","content":"hi"}]}',
    );
  });

  it('a 401 whose body echoes the key does not leak it', async () => {
    const key = 'sk-secret-123';
    const fetchFn = (async () =>
      ({ ok: false, status: 401, text: async () => `Incorrect API key provided: ${key}` }) as unknown as Response) as unknown as typeof fetch;
    const p = PROVIDERS.openai;
    const err = (await callStructured({ endpoint: p.endpoint, apiKey: key, model: 'm', fetchFn, providerName: p.name }, msgs, fmt).catch((e) => e)) as Error;
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(key);
    expect(err.message).toContain('***');
  });
});
