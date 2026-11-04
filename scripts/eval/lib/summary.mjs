// The summary of the big test: one row per pair, a find model and its judge, from the shared record and the grader's scores.
//
// The files of the grader, `docs/eval/2026-11/scores/` (`scripts/eval/grader-brief.md` says how the grader fills them):
//
//   batch-<n>.json   {label: {draw: Score}}, as `applyKey` writes it. A Score is
//                      {defects: string[], findings: number, pr: string, corpus?: {pr: Corpus}}
//                    `defects` are the ids the item found, D1-D5 on #418 and R1-R3 on #930, confirmed results only for a verify or whole run; `pr` is written by `applyKey` from the key, never taken from the grader (a score without one reads as "418");
//                    `corpus` is {pr: {real, false, unfalsifiable, published}}, counts of the confirmed findings of each corpus PR;
//                    `applyKey` writes it on the label's draw 1 of batch 102 or 105, and on `<label>@<judge>`'s draw 1 of batch 103, from the grader's per-item fields.
//                    Batch 105 (generic prompts) is its own row, `<baseline> (generic prompts)`, and is never a profile.
//                    In batches 1, 103, 104 and 106 a verify or whole run is scored under `<label>@<judge>`, a find under the plain label.
//   judges.json      {judge: consensus}: how many of 15 the judge got right at `verify-corpus` by consensus, under its id with no vendor prefix.
//
// Which scores are which: find-stage D-scores are batches 1-6 under the plain label; published ones are batches 7 and 101
// under the plain label, and batches 1, 104 and 106 under `<label>@<judge>`.
// A score counts only if a run of that batch, label, draw, PR and judge closed clean (`isScorable`).
//
// What belongs to whom: the find-stage fields belong to the finder and appear on each of its rows. Published scores,
// `refutedMean`, `errorShare`, the judge cost and the consensus belong to the pair. So does the corpus when the pair ran it;
// a pair with no corpus run takes the counts of its finder's pair that has one, and `corpusFrom` names that judge. A finder
// with no judge yet has one row with `judge: null`. `composite` is true only when the row's judge did not verify this finder.
// A row's judge is the id with no vendor prefix, so `gpt-5.5` and `openai/gpt-5.5` are one row; run lines keep what really ran.
// `runnable` says a clean run put that judge through the finder's own route: without one, nobody can configure the pair.
// `refutedMean` reads #418 only, the evidence batch 7 excludes on. `costUnknown` says a first run's call has no usable usage or price.
import { planBatch } from './batches.mjs';
import { priceOf } from './catalog.mjs';
import { callUsd, isScorable, judgeId } from './records.mjs';
import { isUnstable } from './selection.mjs';

const SEP = '|';
const KNOWN_DEFECTS = ['D1', 'D2', 'D3', 'D4', 'D5'];
const FIND_BATCHES = [1, 2, 3, 4, 5, 6];
const CORPUS_BATCHES = [102, 103];
/** The finalists' corpus: its scores name the judge, because each judge can confirm other findings. */
const JUDGED_CORPUS_BATCH = 103;
/** Batch 105 measures the baseline with generic prompts, so it is a row of its own and joins no other. */
const GENERIC_BATCH = 105;
/** The setup: its verify is a probe that is meant to fail, and belongs to no pair. */
const SETUP_BATCH = 0;
const DEFAULT_PR = '418';
const BROKEN_FINISH = ['length', 'content_filter', 'error'];
/** The judges of stage 2's item 4 (spec, "Етап 2"). */
const STAGE_2_JUDGES = [
  { model: 'claude-sonnet-5-5', route: 'anthropic' },
  { model: 'gpt-6.1-sol', route: 'openai' },
  { model: 'gpt-6.1-terra', route: 'openai' },
  { model: 'claude-haiku-5-5', route: 'anthropic' },
];
/** How a mixed pair reaches the baseline's judge through OpenRouter (spec line 40). */
const MIXED_JUDGE = 'openai/gpt-5.5';
const ESTIMATE_PIN = ['estimate'];

const keyParts = (line) => (typeof line.key === 'string' ? line.key.split(SEP) : []);
/** The label of a record line; a call line has none of its own, only the key of its run. */
const labelOf = (line) => keyParts(line)[2] ?? line.label;
const batchOf = (line) => line.batch ?? Number(keyParts(line)[0]);
/** The PR of a call line, from the key of its run. */
export const prOf = (line) => keyParts(line)[3];

const isVerifying = (run) => run.mode === 'verify' || run.mode === 'whole';
/** The judge of a run, from the key when a dead child left no `verifyModel` on its line; a find has none. */
const judgeOf = (run) => {
  const model = isVerifying(run) ? run.verifyModel ?? keyParts(run)[5] : undefined;
  return model === undefined ? null : judgeId(model);
};
/** A call of the setup's verify probe: not part of any pair's own runs. */
const isSetupVerify = (line) => batchOf(line) === SETUP_BATCH && (line.stage === 'verify' || line.mode === 'verify');

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
    if (line.type === 'manual' && Number.isFinite(line.usd)) manualUsd += line.usd;
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

/** The calls the thinking check may read: by the model asked for, since a Claude finder's judge may be anyone. */
export function anthropicCalls(calls, catalog) {
  const models = new Set(catalog.candidates.filter((c) => c.route === 'anthropic').map((c) => c.model));
  return calls.filter((c) => models.has(c.requestedModel));
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

/** Whether a response names who served it (spec line 362). */
export function executorVisibility(calls) {
  const named = calls.filter((c) => typeof c.provider === 'string' && c.provider !== '');
  return { calls: calls.length, visible: named.length, hosts: [...new Set(named.map((c) => c.provider))].sort() };
}

/** Tokens read per token written: below 0.28 the write surcharge does not pay for itself (spec line 66). */
export function readsPerWrite(calls) {
  let reads = 0;
  let writes = 0;
  for (const call of calls) {
    reads += call.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    writes += call.usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  }
  return { reads, writes, ratio: writes === 0 ? null : reads / writes };
}

/** The items of stage 2 in the spec's order, each with what the plan estimates for it. `corpus` is what the preflight kept. */
export function stage2Items({ catalog, corpus, finalists, pairs }) {
  // An estimate does not wait for `--endpoints`.
  const pinned = (row) => ({ ...row, only: ESTIMATE_PIN });
  const ready = { ...catalog, candidates: catalog.candidates.map(pinned), judges: catalog.judges.map(pinned) };
  const preflight = { corpus, recall930: true };
  const plan = (args) => planBatch({ catalog: ready, preflight, ...args });
  const usdOf = (runs) => runs.reduce((sum, run) => sum + run.estimateUsd, 0);
  const judgeArgs = (label) => {
    const entry = catalog.candidates.find((c) => c.label === label);
    const judges = { openai: catalog.baseline.verifyModel, openrouter: MIXED_JUDGE, anthropic: entry.model };
    return { labels: [label], verifyModel: judges[entry.route], verifyRoute: entry.route };
  };
  const covered = finalists.slice(0, 2);
  const named = ['the baseline', ...(covered.length === 0 ? [] : [covered.join(', ')])].join(' and ');
  const judgeNames = STAGE_2_JUDGES.map((j) => j.model).join(', ');
  return [
    {
      item: 1,
      what: `#930: ${named}, 3 draws each`,
      usd:
        usdOf(plan({ batch: 101, labels: [] })) +
        covered.reduce((sum, label) => sum + usdOf(plan({ batch: 101, ...judgeArgs(label) }).filter((run) => run.label === label)), 0),
    },
    { item: 2, what: 'corpus: the baseline', usd: usdOf(plan({ batch: 102 })) },
    ...finalists.map((label) => ({ item: 3, what: `corpus: ${label}`, usd: usdOf(plan({ batch: 103, ...judgeArgs(label) })) })),
    {
      item: 4,
      what: `judges on the same inputs: ${judgeNames}, on ${named}; verify-corpus comes on top`,
      usd: usdOf(plan({ batch: 104, labels: covered, judges: STAGE_2_JUDGES })),
    },
    { item: 5, what: 'generic prompts: the baseline on #418 and the corpus', usd: usdOf(plan({ batch: 105 })) },
    ...pairs.map((label) => ({ item: 6, what: `a pair inside one provider, #418 x 3: ${label}`, usd: usdOf(plan({ batch: 106, ...judgeArgs(label) })) })),
  ];
}

/** The baseline's own pair; before it has a judge, its one row. */
export function baselineRowOf(rows, catalog) {
  const own = rows.filter((r) => r.label === catalog.baseline.label && !r.generic);
  return own.find((r) => r.judge === catalog.baseline.verifyModel) ?? own[0];
}

const closedKey = (batch, label, draw, pr, judge) => [batch, label, draw, pr, judge].join(SEP);

function closedRuns(lines) {
  return new Set(
    lines
      .filter((l) => l.type === 'run' && isScorable(l) && !l.expectFailure)
      .map((l) => closedKey(l.batch, labelOf(l), l.draw, l.pr, judgeOf(l))),
  );
}

/** First-run price of a pair and its judge's part: calls of the earliest clean runs of the label on #418, draw 1. */
function firstRunUsd({ lines, catalog, label, judge, cacheRuleApplies }) {
  const firsts = lines.filter((l) => l.type === 'run' && isScorable(l) && !l.expectFailure && labelOf(l) === label && l.pr === DEFAULT_PR && l.draw === 1);
  const find = firsts.find((l) => l.mode === 'find' || l.mode === 'whole');
  const verify = firsts.find((l) => isVerifying(l) && judgeOf(l) === judge);
  if (find === undefined && verify === undefined) return { production: null, judgePart: null, unknown: false };
  const stageUsd = (run, stage) => {
    if (run === undefined) return 0;
    let total = 0;
    for (const call of lines.filter((l) => l.type === 'call' && l.key === run.key && l.attempt === run.attempt && l.stage === stage)) {
      if (!call.usage) return null;
      const price = priceOf(catalog, call.requestedModel ?? call.model);
      if (!price) return null;
      total += productionUsd({ firstRunUsage: call.usage, price, cacheRuleApplies });
    }
    return Number.isFinite(total) ? total : null;
  };
  const findPart = stageUsd(find, 'find');
  const judgePart = stageUsd(verify, 'verify');
  const unknown = findPart === null || judgePart === null;
  return {
    production: unknown ? null : findPart + judgePart,
    judgePart: verify === undefined ? null : judgePart,
    unknown,
  };
}

/** Scores of one batch under a score label whose run closed, as `{draw, pr, value}`. */
function scoredDraws({ scores, closed, batch, scoreLabel, label, judge }) {
  return Object.entries(scores.batches[batch]?.[scoreLabel] ?? {})
    .map(([draw, value]) => ({ draw: Number(draw), pr: value.pr ?? DEFAULT_PR, value }))
    .filter((e) => closed.has(closedKey(batch, label, e.draw, e.pr, judge)));
}

const sortedUnion = (lists) => [...new Set(lists.flat())].sort();
const missing = (found) => KNOWN_DEFECTS.filter((id) => !found.includes(id));

/** What the finder alone did: the same on each of its rows. */
function findStage({ entry, scores, closed }) {
  const findByDraw = new Map();
  for (const batch of entry.generic ? [] : FIND_BATCHES) {
    for (const e of scoredDraws({ scores, closed, batch, scoreLabel: entry.label, label: entry.label, judge: null })) {
      if (e.pr === DEFAULT_PR) findByDraw.set(e.draw, e.value);
    }
  }
  const draws = [...findByDraw.keys()].sort((a, b) => a - b);
  const perDraw = draws.map((d) => findByDraw.get(d).defects.length);
  const findDefects = sortedUnion(draws.map((d) => findByDraw.get(d).defects));
  return {
    draws: draws.length,
    perDraw,
    medianKnown: median(perDraw),
    union: findDefects.length,
    findDefects,
    missedFind: draws.length === 0 ? null : missing(findDefects),
    unstable: draws.length >= 2 && isUnstable(Object.fromEntries(draws.map((d) => [d, findByDraw.get(d)]))),
  };
}

/** Published scores of one pair, by the score label its batch uses. */
function publishedOf({ entry, judge, scores, closed }) {
  const { label, generic } = entry;
  const atJudge = `${label}@${judge}`;
  const sources = generic
    ? [[GENERIC_BATCH, label]]
    : [[1, atJudge], [7, label], [101, label], [104, atJudge], [106, atJudge]];
  return sources
    .flatMap(([batch, scoreLabel]) => scoredDraws({ scores, closed, batch, scoreLabel, label, judge }))
    .filter((e) => Array.isArray(e.value.defects));
}

function corpusOf({ entry, judge, scores, closed }) {
  const { label, generic } = entry;
  const corpus = { real: 0, false: 0, unfalsifiable: 0, published: 0, prs: 0 };
  const counted = new Set();
  for (const batch of generic ? [GENERIC_BATCH] : CORPUS_BATCHES) {
    const scoreLabel = batch === JUDGED_CORPUS_BATCH ? `${label}@${judge}` : label;
    for (const [draw, value] of Object.entries(scores.batches[batch]?.[scoreLabel] ?? {})) {
      for (const [pr, c] of Object.entries(value.corpus ?? {})) {
        if (counted.has(pr) || !closed.has(closedKey(batch, label, Number(draw), pr, judge))) continue;
        counted.add(pr);
        corpus.real += c.real;
        corpus.false += c.false;
        corpus.unfalsifiable += c.unfalsifiable;
        corpus.published += c.published;
        corpus.prs += 1;
      }
    }
  }
  return corpus;
}

/**
 * Empty or cut answers, plus failed runs that got an answer and left no such call: an unparseable one has content and
 * `stop`. A failed run with no call never got an answer, so a failed `git fetch` or a killed child is not the model's.
 */
function brokenCount({ calls, runs }) {
  const isBroken = (c) => c.contentLength === 0 || BROKEN_FINISH.includes(c.finishReason);
  const attemptOf = (line) => `${line.key}${SEP}${line.attempt}`;
  const broken = calls.filter(isBroken);
  const counted = new Set(broken.map(attemptOf));
  const answered = new Set(calls.map(attemptOf));
  return broken.length + runs.filter((r) => !isScorable(r) && !r.expectFailure && answered.has(attemptOf(r)) && !counted.has(attemptOf(r))).length;
}

export function summarize({ lines, catalog, scores, cacheRuleApplies }) {
  const base = catalog.baseline;
  const entries = [
    { label: base.label, findModel: base.findModel, route: base.route, tier: null, dropped: false, generic: false },
    ...catalog.candidates.map((c) => ({ label: c.label, findModel: c.model, route: c.route, tier: c.tier, dropped: c.dropped !== undefined, generic: false })),
    { label: base.label, findModel: base.findModel, route: base.route, tier: null, dropped: false, generic: true },
  ];
  const closed = closedRuns(lines);
  const rows = entries.flatMap((entry) => {
    const { label, generic } = entry;
    const own = lines.filter((l) => (batchOf(l) === GENERIC_BATCH) === generic);
    const calls = own.filter((l) => l.type === 'call' && labelOf(l) === label && !isSetupVerify(l));
    const runs = own.filter((l) => l.type === 'run' && labelOf(l) === label && !isSetupVerify(l));
    const judged = runs.filter((r) => isVerifying(r) && !r.expectFailure);
    const judges = [...new Set(judged.map(judgeOf).filter((judge) => judge !== null))];
    const finder = findStage({ entry, scores, closed });
    const corpusRun = judges.find((judge) => corpusOf({ entry, judge, scores, closed }).prs > 0) ?? null;

    return (judges.length === 0 ? [null] : judges).map((judge) => {
      const ownCorpus = corpusOf({ entry, judge, scores, closed });
      const inherited = ownCorpus.prs === 0 && corpusRun !== null;
      const mine = judged.filter((r) => judgeOf(r) === judge);
      const pairCalls = calls.filter((c) => c.stage !== 'verify' || (judge !== null && judgeId(c.requestedModel ?? c.model) === judge));
      const pairRuns = runs.filter((r) => !isVerifying(r) || judgeOf(r) === judge);

      const published = publishedOf({ entry, judge, scores, closed });
      const publishedOn = (pr) => published.filter((e) => e.pr === pr);
      const on418 = publishedOn(DEFAULT_PR);
      const publishedDefects = sortedUnion(on418.map((e) => e.value.defects));

      const verifies = mine.filter((r) => Array.isArray(r.results) && !catalog.corpus.includes(r.pr));
      const verdicts = verifies.flatMap((r) => r.results.map((x) => x.verdict));
      const refutedPerRun = verifies.filter((r) => isScorable(r) && r.pr === DEFAULT_PR).map((r) => r.results.filter((x) => x.verdict === 'refuted').length);
      const { production, judgePart, unknown } = firstRunUsd({ lines: own, catalog, label, judge, cacheRuleApplies });

      return {
        label: generic ? `${label} (generic prompts)` : label,
        generic,
        route: entry.route,
        tier: entry.tier,
        dropped: entry.dropped,
        judge,
        pair: judge === null ? `${entry.findModel} (no judge yet)` : `${entry.findModel} + ${judge}`,
        ...finder,
        medianPublished: median(on418.map((e) => e.value.defects.length)),
        publishedDefects,
        missedPublished: on418.length === 0 ? null : missing(publishedDefects),
        refutedMean: mean(refutedPerRun),
        errorShare: verdicts.length === 0 ? null : verdicts.filter((v) => v === 'error').length / verdicts.length,
        paidUsd: paidUsd(pairCalls, catalog),
        productionUsd: production,
        judgeUsd: judgePart,
        costUnknown: unknown,
        composite: !mine.some(isScorable),
        corpus: inherited ? corpusOf({ entry, judge: corpusRun, scores, closed }) : ownCorpus,
        corpusFrom: inherited ? corpusRun : null,
        runnable: mine.some((r) => isScorable(r) && r.provider === entry.route),
        judgeConsensus: judge === null ? null : scores.judges?.[judge] ?? null,
        brokenCalls: brokenCount({ calls: pairCalls, runs: pairRuns }),
        medianRecall930: median(publishedOn('930').map((e) => e.value.defects.length)),
        seen: calls.length > 0 || runs.length > 0 || finder.draws > 0 || published.length > 0,
      };
    });
  });
  return rows.filter((r) => r.seen).map(({ seen, ...row }) => row);
}
