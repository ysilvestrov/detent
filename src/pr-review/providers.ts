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
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    defaultModels: { find: 'gpt-5.6-sol', verify: 'gpt-5.5' },
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

function keyOf(p: Provider, env: Env): string | undefined {
  const v = env[p.keyEnv];
  return v !== undefined && v.trim() !== '' ? v : undefined;
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
