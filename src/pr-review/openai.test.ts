import { describe, it, expect } from 'vitest';
import { callStructured, NonRetryableError, type CallInfo } from './openai.js';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  fetchFn,
  sleep: async () => {},
});

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

describe('callStructured', () => {
  it('sends max_completion_tokens and never max_tokens or temperature', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });

    expect(body.max_completion_tokens).toBe(8000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'review', strict: true, schema: SCHEMA },
    });
  });

  it('returns the completion content on success', async () => {
    const fetchFn = (async () => ok('{"a":1}')) as unknown as typeof fetch;
    const out = await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(out.content).toBe('{"a":1}');
  });

  it('retries a 500 then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(calls).toBe(2);
  });

  it('does not retry a 400 and surfaces the API message', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        text: async () => "Unsupported parameter: 'max_tokens'",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toThrow(/Unsupported parameter/);
    expect(calls).toBe(1);
  });

  it('treats an empty completion as non-retryable', async () => {
    const fetchFn = (async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  // warsaw-beer-bot#691: a reasoning model can burn the whole completion budget and return no
  // content. That call is billed, so the tokens must survive the failure — a
  // caller that swallows the error to keep going has no other source for them.
  it('carries the billed usage on an empty completion', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: {} }],
          usage: {
            prompt_tokens: 7100,
            completion_tokens: 2400,
            completion_tokens_details: { reasoning_tokens: 2400 },
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const err = await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as NonRetryableError).usage).toEqual({
      calls: 1,
      promptTokens: 7100,
      cachedTokens: 0,
      completionTokens: 2400,
      reasoningTokens: 2400,
    });
  });

  // The other non-retryable paths report no token count at all, so they must not
  // invent one: an HTTP failure priced as zero tokens is the same silent
  // under-report, arriving from the other direction.
  it('leaves usage undefined when the call never reported tokens', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'bad request' }) as unknown as Response) as unknown as typeof fetch;

    const err = await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as NonRetryableError).usage).toBeUndefined();
  });
});

describe('callStructured — 429 handling', () => {
  const SCHEMA429 = { type: 'object', properties: {}, additionalProperties: false };

  it('does not retry an exhausted quota and names it plainly', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () =>
          '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA429,
      }),
    ).rejects.toThrow(/quota exhausted/);
    expect(calls).toBe(1);
  });

  it('still retries a genuine rate limit and surfaces the body', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () => '{"error":{"code":"rate_limit_exceeded"}}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA429,
      }),
    ).rejects.toThrow(/rate_limit_exceeded/);
    expect(calls).toBe(3);
  });
});

import { callStructured as callWithUsage } from './openai.js';

describe('callStructured usage', () => {
  const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };

  it('returns the usage block alongside the content', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 128 },
            completion_tokens_details: { reasoning_tokens: 32 },
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.content).toBe('{}');
    expect(out.usage).toEqual({
      calls: 1,
      promptTokens: 900,
      cachedTokens: 128,
      completionTokens: 40,
      reasoningTokens: 32,
    });
  });

  it('still returns a counted call when the response omits usage', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.usage.calls).toBe(1);
    expect(out.usage.promptTokens).toBe(0);
  });
});

describe('callStructured: onResponse', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const fmt = { name: 'review', schema: SCHEMA };
  const respond = (body: unknown) =>
    (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

  it('reports every response to onResponse, raw usage included', async () => {
    const seen: CallInfo[] = [];
    const fetchFn = respond({
      id: 'gen-1',
      model: 'm',
      provider: 'Moonshot AI',
      choices: [{ finish_reason: 'stop', message: { content: 'abc' } }],
      usage: { prompt_tokens: 5, prompt_tokens_details: { cache_write_tokens: 3 } },
    });
    await callStructured({ ...deps(fetchFn), onResponse: (info) => seen.push(info) }, msgs, fmt);
    expect(seen).toEqual([
      {
        id: 'gen-1',
        model: 'm',
        provider: 'Moonshot AI',
        finishReason: 'stop',
        contentLength: 3,
        usage: { prompt_tokens: 5, prompt_tokens_details: { cache_write_tokens: 3 } },
      },
    ]);
  });

  it('reports an empty completion before throwing, because it was billed', async () => {
    const seen: CallInfo[] = [];
    const fetchFn = respond({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 7 } });
    const err = await callStructured({ ...deps(fetchFn), onResponse: (info) => seen.push(info) }, msgs, fmt).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(seen[0]!.contentLength).toBe(0);
  });

  it('gives null for the fields a response leaves out', async () => {
    const seen: CallInfo[] = [];
    const fetchFn = respond({ choices: [{ message: { content: 'a' } }] });
    await callStructured({ ...deps(fetchFn), onResponse: (info) => seen.push(info) }, msgs, fmt);
    expect(seen).toEqual([
      { id: null, model: null, provider: null, finishReason: null, contentLength: 1, usage: null },
    ]);
  });
});

describe('callStructured: provider name, extraBody, key scrubbing', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const fmt = { name: 'review', schema: SCHEMA };

  it('uses a custom providerName in error messages instead of OpenAI', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'bad' }) as unknown as Response) as unknown as typeof fetch;
    const err = (await callStructured({ ...deps(fetchFn), providerName: 'Anthropic' }, msgs, fmt).catch((e) => e)) as Error;
    expect(err.message).toContain('Anthropic HTTP 400');
    expect(err.message).not.toContain('OpenAI');
  });

  it('serializes a request without extraBody byte for byte as before', async () => {
    let raw = '';
    const fetchFn = (async (_u: string, init: RequestInit) => {
      raw = String(init.body);
      return ok('{}');
    }) as unknown as typeof fetch;
    await callStructured(deps(fetchFn), msgs, fmt);
    expect(raw).toBe(
      '{"model":"gpt-5.4-mini","max_completion_tokens":8000,"response_format":{"type":"json_schema","json_schema":{"name":"review","strict":true,"schema":{"type":"object","properties":{},"additionalProperties":false}}},"messages":[{"role":"user","content":"hi"}]}',
    );
  });

  it('replaces every occurrence of the API key with *** in a thrown error', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 401, text: async () => 'bad key sk-test, again sk-test' }) as unknown as Response) as unknown as typeof fetch;
    const err = (await callStructured(deps(fetchFn), msgs, fmt).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).not.toContain('sk-test');
    expect(err.message).toContain('bad key ***, again ***');
  });

  it('scrubs the key from a retried transport failure too', async () => {
    const fetchFn = (async () => {
      throw new Error('connect failed for Bearer sk-test');
    }) as unknown as typeof fetch;
    const err = (await callStructured(deps(fetchFn), msgs, fmt).catch((e) => e)) as Error;
    expect(err.message).toContain('after 3 attempts');
    expect(err.message).not.toContain('sk-test');
  });

  it('keeps the usage of a billed empty completion when scrubbing', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      }) as unknown as Response) as unknown as typeof fetch;
    const err = (await callStructured(deps(fetchFn), msgs, fmt).catch((e) => e)) as NonRetryableError;
    expect(err.usage?.promptTokens).toBe(7);
  });

  it('sends only the standard fields when there is no extraBody', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return ok('{}');
    }) as unknown as typeof fetch;
    await callStructured(deps(fetchFn), msgs, fmt);
    expect(Object.keys(sentBody)).toEqual(['model', 'max_completion_tokens', 'response_format', 'messages']);
  });

  it('an empty key replaces nothing', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'abc' }) as unknown as Response) as unknown as typeof fetch;
    const err = (await callStructured({ ...deps(fetchFn), apiKey: '' }, msgs, fmt).catch((e) => e)) as Error;
    expect(err.message).toBe('OpenAI HTTP 400: abc');
  });
});
