// The OpenAI-compatible providers the PR review can talk to, and how one is chosen.
type Env = Readonly<Record<string, string | undefined>>;

export const PROVIDER_IDS = ['openai', 'anthropic', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export interface Provider {
  id: ProviderId;
  name: string;
  endpoint: string;
  keyEnv: string;
  /** Absent when no model is safe to assume: the project must name one in detent.json. */
  defaultModels?: { find: string; verify: string };
  /** Top-level request fields this provider needs, appended after the standard ones. */
  extraBody?: Record<string, unknown>;
  /** The models whose paid cache writes a request turns off. Only named ones: an older model answers the switch with a 400. */
  cacheOffModels?: readonly string[];
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    /*
     * Chosen by replay measurement, never by preference. The protocol and every number behind
     * these two strings are in warsaw-beer-bot docs/ai-review-model-evaluation.md.
     *
     * `find` -> gpt-5.6-sol (2026-09-22): a strict improvement on the gpt-5.5 it replaces, which
     * is why it carried no quality bet - cheaper on both input ($4 vs $5 per 1M) and output ($20
     * vs $30), while publishing 5 of the recall probe's 5 known defects plus several more, at 8
     * and 6 verified per run against gpt-5.5's 5/5/3. Cheaper tiers were measured and declined:
     * terra reaches 3-4 of the 5, luna only 2 and never raises the new-issue scope guard at all.
     *
     * `verify` stays gpt-5.5: it is the adversarial adjudicator and agreed 15 of 15 on the verify
     * corpus. The big test of 2026-11 kept this pair as the default; its profiles and numbers are in
     * README.md and docs/eval/2026-11/report.md.
     */
    defaultModels: { find: 'gpt-5.6-sol', verify: 'gpt-5.5' },
    /*
     * A write costs 25% over input and only an identical repeat reads it back: on warsaw-beer-bot#688
     * the next head read 0 of 23 585 written tokens, and no verify call of the big test read any.
     */
    cacheOffModels: ['gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-6.1-sol'],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    extraBody: { provider: { require_parameters: true } },
  },
};

/**
 * What one stage's request adds to the standard fields: the provider's own, the OpenRouter executor pin, and the
 * switch that turns cache writes off. `cacheOff` is whether that switch goes in.
 */
export function stageBody(provider: Provider, p: { only?: readonly string[] | null | undefined; cacheOff: boolean }): Record<string, unknown> | undefined {
  if ((p.only === undefined || p.only === null) && !p.cacheOff) return provider.extraBody;
  const body: Record<string, unknown> = { ...provider.extraBody };
  if (p.only !== undefined && p.only !== null) {
    body.provider = { ...(provider.extraBody?.provider as object | undefined), only: p.only, allow_fallbacks: false };
  }
  if (p.cacheOff) body.prompt_cache_options = { mode: 'explicit' };
  return body;
}

/** Whether a request to `model` turns cache writes off by default. */
export function cacheOffByDefault(provider: Provider, model: string): boolean {
  return provider.cacheOffModels?.includes(model) ?? false;
}

function keyOf(p: Provider, env: Env): string | undefined {
  const v = env[p.keyEnv]?.trim();
  return v !== undefined && v !== '' ? v : undefined;
}

export type Selection =
  | { kind: 'ok'; provider: Provider; apiKey: string }
  | { kind: 'no-key'; wanted: string }
  | { kind: 'ambiguous'; keys: string[] };

export function selectProvider(configured: ProviderId | undefined, env: Env): Selection {
  if (configured !== undefined) {
    const provider = PROVIDERS[configured];
    const apiKey = keyOf(provider, env);
    return apiKey === undefined ? { kind: 'no-key', wanted: provider.keyEnv } : { kind: 'ok', provider, apiKey };
  }
  const found = PROVIDER_IDS.map((id) => PROVIDERS[id]).flatMap((provider) => {
    const apiKey = keyOf(provider, env);
    return apiKey === undefined ? [] : [{ provider, apiKey }];
  });
  if (found.length === 0) return { kind: 'no-key', wanted: PROVIDER_IDS.map((id) => PROVIDERS[id].keyEnv).join(' or ') };
  if (found.length > 1) return { kind: 'ambiguous', keys: found.map((f) => f.provider.keyEnv) };
  return { kind: 'ok', ...found[0]! };
}

export function resolveModels(
  provider: Provider,
  configured: { findModel?: string; verifyModel?: string },
): { ok: true; find: string; verify: string } | { ok: false; error: string } {
  const find = configured.findModel ?? provider.defaultModels?.find;
  if (find === undefined) {
    return { ok: false, error: `${provider.name} has no default model: set "prReview.findModel" in detent.json` };
  }
  const verify = configured.verifyModel ?? provider.defaultModels?.verify;
  if (verify === undefined) {
    return { ok: false, error: `${provider.name} has no default model: set "prReview.verifyModel" in detent.json` };
  }
  return { ok: true, find, verify };
}
