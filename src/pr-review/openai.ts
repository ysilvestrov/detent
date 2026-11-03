import { parseUsage, type Usage } from './usage.js';

/**
 * A failure that must not be retried.
 *
 * `usage` is set when the call **completed and was billed** but its content was
 * unusable — the empty-completion case below. Carrying it is not tidiness: the
 * spec's rule for the cost footer is that the reviewer prints its own bill and
 * that an admitted gap beats an invented number, and a billed call that vanishes
 * from the footer understates the bill *silently*, which is the one direction
 * that rule exists to forbid. Callers that swallow this error to keep going
 * (`verifyAll`) must add `usage` to their running total. It stays undefined for
 * transport and HTTP failures, where no token count was ever reported.
 */
export class NonRetryableError extends Error {
  readonly usage?: Usage;

  constructor(message: string, usage?: Usage) {
    super(message);
    this.usage = usage;
  }
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

/** What one model response carried, as the provider sent it. A field it left out is null. */
export interface CallInfo {
  id: string | null;
  model: string | null;
  provider: string | null;
  finishReason: string | null;
  contentLength: number;
  /** The raw `usage` object, not parsed: provider-specific fields survive. */
  usage: unknown;
}

export interface OpenAiDeps {
  endpoint: string;
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  /** Name used in error messages. Defaults to 'OpenAI'. */
  providerName?: string;
  /** Extra top-level request fields, appended after the standard ones. */
  extraBody?: Record<string, unknown>;
  /** Called with every HTTP 200 response, including an empty completion that is about to throw and a body that could not be read (all-null info). */
  onResponse?: (info: CallInfo) => void;
}

export const DEFAULT_MAX_COMPLETION_TOKENS = 8000;

/**
 * One structured chat completion, with the tokens it cost.
 *
 * Deliberately sends neither `temperature` nor `max_tokens`: the 2026-07-28 API
 * probe showed `max_tokens` is rejected with HTTP 400 on every gpt-5.x model,
 * and `temperature: 0` is rejected on gpt-5.5. Determinism comes from the
 * schema and the verification pass, not from sampling parameters.
 */
export async function callStructured(
  deps: OpenAiDeps,
  messages: ChatMessage[],
  format: JsonSchemaFormat,
  maxCompletionTokens: number = DEFAULT_MAX_COMPLETION_TOKENS,
): Promise<{ content: string; usage: Usage }> {
  try {
    return await request(deps, messages, format, maxCompletionTokens);
  } catch (err) {
    throw scrubKey(err, deps.apiKey);
  }
}

/**
 * The error with every occurrence of the API key replaced by `***`. A provider may echo
 * the key back in an error body, and the message ends up in a public PR comment and a CI
 * log. An empty key replaces nothing: `replaceAll('', ...)` would put the mask between
 * every character.
 */
function scrubKey(err: unknown, key: string): unknown {
  if (key === '' || !(err instanceof Error) || !err.message.includes(key)) return err;
  const message = err.message.replaceAll(key, '***');
  return err instanceof NonRetryableError ? new NonRetryableError(message, err.usage) : new Error(message);
}

async function request(
  deps: OpenAiDeps,
  messages: ChatMessage[],
  format: JsonSchemaFormat,
  maxCompletionTokens: number,
): Promise<{ content: string; usage: Usage }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 3;
  const name = deps.providerName ?? 'OpenAI';
  const url = `${deps.endpoint.replace(/\/$/, '')}/chat/completions`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model,
          max_completion_tokens: maxCompletionTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: format.name, strict: true, schema: format.schema },
          },
          messages,
          ...deps.extraBody,
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        // Carry the body into the error. OpenAI returns an exhausted balance as
        // 429 `insufficient_quota`, which is NOT a throttle — retrying it three
        // times and reporting "failed after 3 attempts" hides the real cause
        // from whoever debugs the red check.
        const text = await res.text().catch(() => '');
        if (text.includes('insufficient_quota')) {
          throw new NonRetryableError(
            `${name} HTTP ${res.status}: quota exhausted for this API key — ${text.slice(0, 200)}`,
          );
        }
        throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new NonRetryableError(`${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      type Body = {
        id?: string;
        model?: string;
        provider?: string;
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
        usage?: unknown;
      };
      // A throw from the hook is not swallowed — a failed write must be seen — but it is not retried
      // either: the call is already paid for, and a retry would pay again and call the hook twice.
      const report = (info: CallInfo, usage: unknown): void => {
        try {
          deps.onResponse?.(info);
        } catch (hookErr) {
          throw new NonRetryableError(`${name} response hook failed: ${String(hookErr)}`, parseUsage(usage));
        }
      };

      let data: Body | null;
      try {
        data = (await res.json()) as Body | null;
      } catch (readErr) {
        if (!deps.onResponse) throw readErr;
        data = null;
      }
      // With a hook (the replay) a 200 is a billed generation, so a body that cannot be read is
      // recorded as an empty response and not retried. Without one (CI) it keeps retrying as before.
      if (deps.onResponse && (typeof data !== 'object' || data === null)) {
        report({ id: null, model: null, provider: null, finishReason: null, contentLength: 0, usage: null }, null);
        throw new NonRetryableError(`${name} returned a response body that could not be read`);
      }
      const body = data!;
      const content = body.choices?.[0]?.message?.content;
      // Before the empty-content check: that call was billed too.
      report(
        {
          id: body.id ?? null,
          model: body.model ?? null,
          provider: body.provider ?? null,
          finishReason: body.choices?.[0]?.finish_reason ?? null,
          contentLength: content?.length ?? 0,
          usage: body.usage ?? null,
        },
        body.usage,
      );
      if (!content) {
        // Measured in production 2026-09-23 (warsaw-beer-bot#691): a reasoning model can spend the
        // whole `max_completion_tokens` budget thinking and emit no content. The call
        // is billed for every one of those tokens, so the usage travels with the
        // failure.
        throw new NonRetryableError(`${name} returned an empty completion`, parseUsage(body.usage));
      }
      // Usage is read from the same response as the content, so a call can never
      // be published without being billed for in the footer.
      return { content, usage: parseUsage(body.usage) };
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(2 ** attempt * 100);
    }
  }
  throw new Error(`${name} request failed after ${attempts} attempts: ${String(lastErr)}`);
}
