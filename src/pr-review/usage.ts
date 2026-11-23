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
  /** The largest `promptTokens` of any single call in this usage; 0 when unknown. A price tier is decided per call. */
  maxPromptTokens: number;
}

export const EMPTY_USAGE: Usage = {
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  reportedUsd: 0,
  maxPromptTokens: 0,
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
    maxPromptTokens: num(u.prompt_tokens),
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
    maxPromptTokens: Math.max(a.maxPromptTokens, b.maxPromptTokens),
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
  /**
   * The most input tokens one call may carry at these rates. Above it the vendor bills the whole
   * request at a higher tier, which no row models, so such usage is left unpriced. Absent: not checked.
   */
  flatUpTo?: number;
}

/**
 * Read off the vendor's own model page on the date below. Only models we have
 * actually checked are listed: an unknown model prints tokens and no dollars,
 * because a confidently wrong number is worse than an admitted gap.
 *
 * Not modelled: the >272k-input-token tier (2x input and cache / 1.5x output, for
 * the whole request). Find cannot reach it: CONTEXT_BUDGET is 240 000 *characters*
 * (~60k tokens). Verify can: it sends a whole file with no budget. A row whose tier
 * was read carries `flatUpTo`, and usage with a call above it stays unpriced.
 *
 * `claude-haiku-5-5` is left out on purpose: its price rises five times over 100k
 * input tokens, and a verify call sends a whole file with no budget, so a flat row
 * could understate it.
 *
 * These numbers are derived, the token counts are ground truth. Validate the
 * first production run's footer against the billing dashboard delta — if they
 * disagree, this table is what is wrong.
 */
export const PRICES: Record<string, Price> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30, flatUpTo: 272_000 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20, flatUpTo: 272_000 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5, flatUpTo: 272_000 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, flatUpTo: 272_000 },
  'gpt-6.2-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, flatUpTo: 272_000 },
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/**
 * Prices that change on a known date, per model, in ascending order of `from`. The
 * last change whose `from` has passed replaces the `PRICES` row, so a release does
 * not have to land on the day a price moves.
 *
 * `gpt-5.6-sol`: the vendor page says "GPT-5.6 Sol's promotional pricing is
 * available until November 30, 2026" and names no time zone; the owner's notice of
 * 2026-11-23 gives $5 / $0.50 / $30 from December 1. The change is dated at the
 * earliest midnight of December 1 anywhere (UTC+14), so whatever zone the vendor
 * means, the footer never understates; it overstates by at most 26 hours. The
 * write tariff is the page's "1.25x the uncached input token rate".
 */
export const PRICE_CHANGES: Record<string, readonly { from: string; price: Price }[]> = {
  'gpt-5.6-sol': [
    { from: '2026-11-30T10:00:00Z', price: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30, flatUpTo: 272_000 } },
  ],
};

/**
 * Verified independently 2026-09-22: a `gpt-5.5` call billed through a third
 * party came back at exactly this table's arithmetic, so the gpt-5.5 row is
 * ground truth and not a transcription of a web page.
 */
export const PRICES_CHECKED_ON = '2026-11-23';

/** The price of `model` at `now`: its last dated change that has begun, else its `PRICES` row. */
export function priceAt(model: string, now: Date): Price | undefined {
  const begun = (PRICE_CHANGES[model] ?? []).filter((c) => Date.parse(c.from) <= now.getTime());
  return begun.length > 0 ? begun[begun.length - 1]!.price : PRICES[model];
}

/**
 * Dollars for `u`: what the provider reported, else `model`'s rates at `now`, or
 * null when we have neither. A run is priced once, when it finishes, and kept as
 * dollars, so `now` is that moment.
 */
export function costUsd(model: string, u: Usage, now: Date = new Date()): number | null {
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

  const price = priceAt(model, now);
  if (!price) return null;
  // A call over the row's tier was billed at rates no row holds: unknown, not this row's figure.
  if (price.flatUpTo !== undefined && u.maxPromptTokens > price.flatUpTo) return null;
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
