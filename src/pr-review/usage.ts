/**
 * What each API call actually cost us, in tokens and then in dollars.
 *
 * The whole point of this module is that the next time someone asks "what does
 * the reviewer cost", the answer is in the review body and the workflow log —
 * not in an hour of dashboard archaeology.
 */

export interface Usage {
  /** Number of completed API calls this usage covers. */
  calls: number;
  promptTokens: number;
  /** Subset of `promptTokens` served from OpenAI's prefix cache, billed cheaper. */
  cachedTokens: number;
  /** Subset of `promptTokens` written to that cache, billed dearer on models with a write tariff. */
  cacheWriteTokens: number;
  /** Includes `reasoningTokens` — the API counts hidden reasoning as completion. */
  completionTokens: number;
  reasoningTokens: number;
  /** The dollars the provider itself reported (`usage.cost`), or null when any call in this usage did not report them. */
  reportedUsd: number | null;
}

export const EMPTY_USAGE: Usage = {
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  reportedUsd: 0,
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * One call's usage, read defensively.
 *
 * `calls` is 1 even when the response carries no `usage` block: the call
 * happened and was billed, and reporting zero calls would understate the run in
 * exactly the direction that hides a cost regression.
 */
export function parseUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    promptTokens: num(u.prompt_tokens),
    cachedTokens: num(promptDetails.cached_tokens),
    cacheWriteTokens: num(promptDetails.cache_write_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
    reportedUsd: typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    reportedUsd: a.reportedUsd === null || b.reportedUsd === null ? null : a.reportedUsd + b.reportedUsd,
  };
}

export interface Price {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached input tokens. Without it a cached token is billed as input. */
  cachedInput?: number;
  /** USD per 1M tokens written to the cache. Without it a written token is billed as input. */
  cacheWrite?: number;
  /** USD per 1M output tokens (reasoning tokens included in that count). */
  output: number;
}

/**
 * Read off the vendor's own model page on the date below. Only models we have
 * actually checked are listed: an unknown model prints tokens and no dollars,
 * because a confidently wrong number is worse than an admitted gap.
 *
 * Not modelled: the >272k-input-token tier (2x input / 1.5x output) and Haiku's
 * tier over 100k tokens. Our CONTEXT_BUDGET is 240 000 *characters* (~60k tokens),
 * so a request cannot reach them; if that budget grows, this needs a tier.
 *
 * These numbers are derived, the token counts are ground truth. Validate the
 * first production run's footer against the billing dashboard delta — if they
 * disagree, this table is what is wrong.
 */
export const PRICES: Record<string, Price> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/**
 * `gpt-5.6-sol`'s $4/$20 is PROMOTIONAL, guaranteed only through **2026-11-21**,
 * after which the vendor page says it may revert to its launch price of $5/$30 —
 * exactly what `gpt-5.5` costs. Nothing here breaks when that happens: the
 * footer simply starts understating the bill, silently, which is the one failure
 * this table is supposed to make impossible. Re-check on or before that date.
 *
 * Verified independently 2026-09-22: a `gpt-5.5` call billed through a third
 * party came back at exactly this table's arithmetic, so the gpt-5.5 row is
 * ground truth and not a transcription of a web page.
 */
export const PRICES_CHECKED_ON = '2026-11-03';

/** Dollars for `u`: what the provider reported, else `model`'s rates, or null when we have neither. */
export function costUsd(model: string, u: Usage): number | null {
  // Free only when nothing happened at all: no call AND no billable token. That
  // is the skipped stage this exists for — an incremental run that never runs
  // find must not mark the whole run unpriced and drop the other stage's real
  // spend. Both halves are load-bearing: usage carrying tokens is priced even if
  // its call count is missing, and a call that came back without a usage block
  // stays unpriced on an unknown model, because its cost is unknown, not zero.
  const billableTokens = u.promptTokens + u.cachedTokens + u.completionTokens;
  if (u.calls === 0 && billableTokens === 0) return 0;

  // A call happened but reported no tokens: the API sent no usage block. Every
  // completion consumes tokens, so this is unknown cost, not zero — admitted the
  // same way an unpriced model is, rather than printed as a confident $0.00.
  if (billableTokens === 0) return null;

  // The route decides the price on OpenRouter, so its own figure beats any row here.
  if (u.calls > 0 && u.reportedUsd !== null) return u.reportedUsd;

  const price = PRICES[model];
  if (!price) return null;
  const plainInput = Math.max(0, u.promptTokens - u.cachedTokens - u.cacheWriteTokens);
  return (
    (plainInput * price.input +
      u.cachedTokens * (price.cachedInput ?? price.input) +
      u.cacheWriteTokens * (price.cacheWrite ?? price.input) +
      u.completionTokens * price.output) /
    1_000_000
  );
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function stagePart(name: string, u: Usage): string {
  if (u.calls === 0) return `${name} skipped`;
  const calls = `${u.calls} call${u.calls === 1 ? '' : 's'}`;
  const reasoning = u.reasoningTokens > 0 ? ` (${formatTokens(u.reasoningTokens)} reasoning)` : '';
  return `${name} ${calls} ${formatTokens(u.promptTokens)}→${formatTokens(u.completionTokens)}${reasoning}`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The one-line bill that goes in the review footer and the workflow log.
 *
 * `unpriced` counts runs on this PR whose model had no price entry, which is
 * why the total is printed with a trailing `+` — it is a lower bound, and
 * saying so is the difference between a number and a lie.
 */
export function formatCostLine(p: {
  find: Usage;
  verify: Usage;
  runUsd: number | null;
  totalUsd: number | null;
  unpriced: number;
}): string {
  const run = p.runUsd === null ? 'this run — (unpriced model)' : `this run ${usd(p.runUsd)}`;
  const total =
    p.totalUsd === null
      ? 'PR total — (unpriced model)'
      : `PR total ${usd(p.totalUsd)}${p.unpriced > 0 ? '+' : ''}`;
  return [stagePart('find', p.find), stagePart('verify', p.verify), run, total].join(' · ');
}
