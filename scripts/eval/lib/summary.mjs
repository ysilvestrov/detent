// The summary of the big test: one row per label from the shared record and the grader's scores.
//
// The files of the grader, `docs/eval/2026-11/scores/`:
//
//   batch-<n>.json   {label: {draw: Score}}, as `applyKey` writes it. A Score is
//                      {defects: string[], findings: number, pr?: string, corpus?: {pr: Corpus}}
//                    `defects` are the ids D1-D5 the item found; `pr` defaults to "418" (set it to "930" for #930);
//                    `corpus` is given instead of `defects` for corpus PRs, {real, false, unfalsifiable, published},
//                    counts of the findings of one corpus PR, and sits on the label's draw 1 of batch 102, 103 or 105.
//                    In batch 1 and 104 a verify is scored under `<label>@<judge>`, a find under the plain label.
//   judges.json      {judgeModel: consensus}: how many of 15 the judge got right at `verify-corpus` by consensus.
//
// Which scores are which: find-stage D-scores are batches 1-6 under the plain label; published ones are batch 7 under
// the plain label, batch 1 under `<label>@<judge>` and the `whole` batches 101, 105, 106 under the plain label.
// A score counts only if a run of that batch, label, draw and PR closed clean (`isScorable`).
import { priceOf } from './catalog.mjs';
import { callUsd, isScorable } from './records.mjs';
import { isUnstable } from './selection.mjs';

const SEP = '|';
const FIND_BATCHES = [1, 2, 3, 4, 5, 6];
const PUBLISHED_BATCHES = [7, 101, 105, 106];
const CORPUS_BATCHES = [102, 103, 105];
/** Batches whose verify and whole runs do not belong to the label's own pair: the setup and the judges' comparison. */
const OTHER_JUDGES_BATCHES = [0, 104];
const DEFAULT_PR = '418';
const BROKEN_FINISH = ['length', 'content_filter', 'error'];

const keyParts = (line) => (typeof line.key === 'string' ? line.key.split(SEP) : []);
/** The label of a record line; a call line has none of its own, only the key of its run. */
const labelOf = (line) => keyParts(line)[2] ?? line.label;

export function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** What every `call` line cost, whether or not its run closed. */
export function paidUsd(lines, catalog) {
  return lines.filter((l) => l.type === 'call').reduce((sum, l) => sum + callUsd(l, catalog).usd, 0);
}

/** The recorded spend by route, for the check against the providers' own consoles; manual spend is apart. */
export function paidByRoute(lines, catalog) {
  const routeOfRun = new Map(lines.filter((l) => l.type === 'run').map((l) => [l.runId, l.provider]));
  const routeOfLabel = new Map([[catalog.baseline.label, catalog.baseline.route], ...catalog.candidates.map((c) => [c.label, c.route])]);
  const byRoute = {};
  let manualUsd = 0;
  for (const line of lines) {
    if (line.type === 'manual') manualUsd += line.usd;
    if (line.type !== 'call') continue;
    const route = routeOfRun.get(line.runId) ?? routeOfLabel.get(labelOf(line)) ?? 'unknown';
    byRoute[route] = (byRoute[route] ?? 0) + callUsd(line, catalog).usd;
  }
  return { byRoute, manualUsd };
}

/** Production price of one first run: its tokens at the route's table price, no reads, the write tariff unless the cache rule applies. */
export function productionUsd({ firstRunUsage, price, cacheRuleApplies }) {
  const input = price.cacheWrite !== undefined && !cacheRuleApplies ? price.cacheWrite : price.input;
  return (firstRunUsage.prompt_tokens * input + firstRunUsage.completion_tokens * price.output) / 1e6;
}

/** Thinking is on when most calls spent at least twice the visible tokens (`contentLength / 4`). */
export function anthropicThinking(calls) {
  const measured = calls.filter((c) => c.usage && typeof c.usage.completion_tokens === 'number' && typeof c.contentLength === 'number');
  const heavy = measured.filter((c) => c.usage.completion_tokens >= (2 * c.contentLength) / 4);
  return heavy.length * 2 > measured.length;
}

/** The names of the cache counters the providers reported in `prompt_tokens_details`, with their largest value. */
export function cacheFields(calls) {
  const fields = {};
  for (const call of calls) {
    for (const [name, value] of Object.entries(call.usage?.prompt_tokens_details ?? {})) {
      if (typeof value === 'number') fields[name] = Math.max(fields[name] ?? 0, value);
    }
  }
  return fields;
}

const closedKey = (batch, label, draw, pr) => [batch, label, draw, pr].join(SEP);

function closedRuns(lines) {
  return new Set(
    lines
      .filter((l) => l.type === 'run' && isScorable(l) && !l.expectFailure)
      .map((l) => closedKey(l.batch, l.label, l.draw, l.pr)),
  );
}

/** First-run price of one stage: calls of the earliest clean run of the label on #418, draw 1. */
function firstRunUsd({ lines, catalog, label, cacheRuleApplies }) {
  const firsts = lines.filter(
    (l) => l.type === 'run' && isScorable(l) && !l.expectFailure && l.label === label && l.pr === DEFAULT_PR && l.draw === 1 && !OTHER_JUDGES_BATCHES.includes(l.batch),
  );
  const source = (modes) => firsts.find((l) => modes.includes(l.mode));
  const find = source(['find', 'whole']);
  const verify = source(['verify', 'whole']);
  const picks = [
    [find, 'find'],
    [verify, 'verify'],
  ].filter(([run]) => run !== undefined);
  let total = 0;
  for (const [run, stage] of picks) {
    for (const call of lines.filter((l) => l.type === 'call' && l.key === run.key && l.attempt === run.attempt && l.stage === stage && l.usage)) {
      const price = priceOf(catalog, call.requestedModel ?? call.model);
      if (!price) return null;
      total += productionUsd({ firstRunUsage: call.usage, price, cacheRuleApplies });
    }
  }
  return picks.length === 0 ? null : total;
}

/** Scores of one batch under a score label whose run closed, as `{draw, pr, value}`. */
function scoredDraws({ scores, closed, batch, scoreLabel, label }) {
  return Object.entries(scores.batches[batch]?.[scoreLabel] ?? {})
    .map(([draw, value]) => ({ draw: Number(draw), pr: value.pr ?? DEFAULT_PR, value }))
    .filter((e) => closed.has(closedKey(batch, label, e.draw, e.pr)));
}

export function summarize({ lines, catalog, scores, cacheRuleApplies }) {
  const base = catalog.baseline;
  const entries = [
    { label: base.label, findModel: base.findModel, route: base.route },
    ...catalog.candidates.map((c) => ({ label: c.label, findModel: c.model, route: c.route })),
  ];
  const closed = closedRuns(lines);
  const rows = entries.map((entry) => {
    const { label } = entry;
    const calls = lines.filter((l) => l.type === 'call' && labelOf(l) === label);
    const runs = lines.filter((l) => l.type === 'run' && l.label === label);

    const findByDraw = new Map();
    for (const batch of FIND_BATCHES) {
      for (const e of scoredDraws({ scores, closed, batch, scoreLabel: label, label })) {
        if (e.pr === DEFAULT_PR) findByDraw.set(e.draw, e.value);
      }
    }
    const draws = [...findByDraw.keys()].sort((a, b) => a - b);
    const perDraw = draws.map((d) => findByDraw.get(d).defects.length);
    const union = new Set(draws.flatMap((d) => findByDraw.get(d).defects)).size;

    const atJudge = Object.keys(scores.batches[1] ?? {}).filter((k) => k.startsWith(`${label}@`));
    const published = [
      ...atJudge.flatMap((scoreLabel) => scoredDraws({ scores, closed, batch: 1, scoreLabel, label })),
      ...PUBLISHED_BATCHES.flatMap((batch) => scoredDraws({ scores, closed, batch, scoreLabel: label, label })),
    ];
    const publishedOn = (pr) => published.filter((e) => e.pr === pr).map((e) => e.value.defects.length);

    const corpus = { real: 0, false: 0, unfalsifiable: 0, published: 0, prs: 0 };
    const counted = new Set();
    for (const batch of CORPUS_BATCHES) {
      for (const [draw, value] of Object.entries(scores.batches[batch]?.[label] ?? {})) {
        for (const [pr, c] of Object.entries(value.corpus ?? {})) {
          if (counted.has(pr) || !closed.has(closedKey(batch, label, Number(draw), pr))) continue;
          counted.add(pr);
          corpus.real += c.real;
          corpus.false += c.false;
          corpus.unfalsifiable += c.unfalsifiable;
          corpus.published += c.published;
          corpus.prs += 1;
        }
      }
    }

    const verifies = runs.filter(
      (r) => ['verify', 'whole'].includes(r.mode) && Array.isArray(r.results) && !OTHER_JUDGES_BATCHES.includes(r.batch) && !catalog.corpus.includes(r.pr) && !r.expectFailure,
    );
    const verdicts = verifies.flatMap((r) => r.results.map((x) => x.verdict));
    const refutedPerRun = verifies.filter(isScorable).map((r) => r.results.filter((x) => x.verdict === 'refuted').length);
    const judge = verifies.find(isScorable)?.verifyModel ?? base.verifyModel;
    const hasVerify = lines.some((l) => l.type === 'run' && l.label === label && ['verify', 'whole'].includes(l.mode) && isScorable(l) && !l.expectFailure);

    const pair = `${entry.findModel} + ${judge}`;
    return {
      label,
      route: entry.route,
      pair,
      draws: draws.length,
      perDraw,
      medianKnown: median(perDraw),
      union,
      medianPublished: median(publishedOn(DEFAULT_PR)),
      refutedMean: mean(refutedPerRun),
      errorShare: verdicts.length === 0 ? null : verdicts.filter((v) => v === 'error').length / verdicts.length,
      paidUsd: paidUsd(calls, catalog),
      productionUsd: firstRunUsd({ lines, catalog, label, cacheRuleApplies }),
      composite: !hasVerify,
      unstable: draws.length >= 2 && isUnstable(Object.fromEntries(draws.map((d) => [d, findByDraw.get(d)]))),
      corpus,
      judgeConsensus: scores.judges?.[judge] ?? null,
      brokenCalls: calls.filter((c) => c.contentLength === 0 || BROKEN_FINISH.includes(c.finishReason)).length,
      medianRecall930: median(publishedOn('930')),
      seen: calls.length > 0 || runs.length > 0 || draws.length > 0 || published.length > 0,
    };
  });
  return rows.filter((r) => r.seen).map(({ seen, ...row }) => row);
}
