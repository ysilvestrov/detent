// Reading the record files of the big test: parse them, keep keys out of them, count what they cost.
import { priceOf } from './catalog.mjs';

const PREFIX = 16;

/** Who a judge is, by any route: `openai/gpt-5.5` and `gpt-5.5` are one judge. A run line keeps what really ran. */
export const judgeId = (model) => model.slice(model.lastIndexOf('/') + 1);

/** Reads KEY=value lines of a keys file; `export`, quotes, comments and blank lines are tolerated. */
export function parseKeys(text) {
  const keys = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    keys[m[1]] = value;
  }
  return keys;
}

/** One object per line. Only a torn last line is dropped; a broken line before it throws with its number. */
export function parseRecords(text) {
  const rows = text.split('\n').map((raw, i) => ({ raw: raw.replace(/\r$/, ''), n: i + 1 })).filter((r) => r.raw.trim() !== '');
  const lines = [];
  rows.forEach((row, i) => {
    try {
      lines.push(JSON.parse(row.raw));
    } catch (error) {
      if (i === rows.length - 1) return;
      throw new Error(`records: line ${row.n} is not JSON (${error.message})`);
    }
  });
  return lines;
}

/** Replaces each key value, and its first 16 characters (a line cut at 200 characters keeps only a start), with `***`. */
export function scrubKeys(text, keys) {
  let out = text;
  let leaked = false;
  const needles = Object.values(keys)
    .filter((v) => v !== '')
    .flatMap((v) => [v, v.slice(0, PREFIX)])
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    if (!out.includes(needle)) continue;
    leaked = true;
    out = out.split(needle).join('***');
  }
  return { text: out, leaked };
}

/** What a `call` line cost: the provider's own figure, else tokens times the table, else nothing. */
export function callUsd(line, catalog) {
  const usage = line.usage;
  if (usage && typeof usage.cost === 'number') return { usd: usage.cost, source: 'cost' };
  const price = usage ? priceOf(catalog, line.requestedModel ?? line.model) : null;
  if (!price) return { usd: 0, source: 'unpriced' };
  const details = usage.prompt_tokens_details ?? {};
  const cached = details.cached_tokens ?? 0;
  const written = details.cache_write_tokens ?? 0;
  const plain = usage.prompt_tokens - cached - written;
  const perMillion =
    plain * price.input +
    cached * (price.cachedInput ?? price.input) +
    written * (price.cacheWrite ?? price.input) +
    usage.completion_tokens * price.output;
  // A usage object without its token fields gives NaN, which would stop every later admit for good.
  if (!Number.isFinite(perMillion)) return { usd: 0, source: 'unpriced' };
  return { usd: perMillion / 1e6, source: 'table' };
}

/** Every `call` line counts, whether or not its run closed, plus the manual lines. */
export function totalSpend(lines, catalog) {
  let usd = 0;
  let unpriced = 0;
  for (const line of lines) {
    if (line.type === 'manual' && Number.isFinite(line.usd)) usd += line.usd;
    if (line.type === 'manual' && !Number.isFinite(line.usd)) unpriced += 1;
    if (line.type !== 'call') continue;
    const cost = callUsd(line, catalog);
    usd += cost.usd;
    if (cost.source === 'unpriced') unpriced += 1;
  }
  return { usd, unpriced };
}

/** A run is scored only when it closed clean; an error with exit 0 is a verify that partly failed. */
export function isScorable(runLine) {
  return runLine.exit === 0 && runLine.error === null;
}
