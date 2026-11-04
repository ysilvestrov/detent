// The batches of the big test as lists of runs, the ceiling check, and what the record already says about a run.
import { priceOf } from './catalog.mjs';
import { isScorable } from './records.mjs';

const VERIFY_BASE_USD = 0.19; // one verify of a #418 find by the baseline judge
const REFERENCE_JUDGE = 'gpt-5.5';
const DRAWS = [1, 2, 3];
const SEP = '|';
const DEFAULT_FIND_LIMIT = 8000;
/** The second try at the models cut by the limit (spec, stage 2, item 7): first one draw each way, then two more for those that earned them. */
export const SECOND_TRY = {
  107: { draws: [1], findMaxTokens: 32000, findReasoning: null },
  108: { draws: [1], findMaxTokens: null, findReasoning: 'low' },
  109: { draws: [2, 3], findMaxTokens: 32000, findReasoning: null },
  110: { draws: [2, 3], findMaxTokens: null, findReasoning: 'low' },
};

const fail = (message) => {
  throw new Error(`plan: ${message}`);
};

/** Identifies a run in the shared record. A verify or whole run names its judge, since one finder can have several. */
export function runKey(run) {
  const parts = [run.batch, run.mode, run.label, run.pr, run.draw];
  if (run.mode === 'verify' || run.mode === 'whole') parts.push(run.verifyModel);
  return parts.join(SEP);
}

/** `label/pr/draw` to the findings file of the last clean find. */
export function savedFindings(lines) {
  const saved = new Map();
  for (const line of lines) {
    if (line.type !== 'run' || typeof line.key !== 'string' || !isScorable(line) || !line.findingsFile) continue;
    const [, mode, label, pr, draw] = line.key.split(SEP);
    if (mode === 'find') saved.set(`${label}/${pr}/${draw}`, line.findingsFile);
  }
  return saved;
}

/** `label/pr/draw` of every find that left any line, a call of a killed one included. */
export function startedFinds(lines) {
  const started = new Set();
  for (const line of lines) {
    if (typeof line.key !== 'string') continue;
    const [, mode, label, pr, draw] = line.key.split(SEP);
    if (mode === 'find') started.add(`${label}/${pr}/${draw}`);
  }
  return started;
}

/** Skip a run that closed clean (an expected failure: any `run` line); otherwise run, numbering the attempt. */
export function nextAction(run, lines) {
  const key = runKey(run);
  const mine = lines.filter((line) => line.key === key);
  const closed = mine.filter((line) => line.type === 'run');
  if (closed.some((line) => run.expectFailure || isScorable(line))) return { action: 'skip' };
  const seen = mine.map((line) => line.attempt ?? 1);
  return { action: 'run', attempt: Math.max(0, ...seen) + 1 };
}

/** A run starts only if it and one more like it fit under the ceiling. */
export function admit({ spentUsd, estimateUsd, ceilingUsd }) {
  return spentUsd + 2 * estimateUsd <= ceilingUsd;
}

function findUsd(catalog, model, pr) {
  const price = priceOf(catalog, model);
  const size = catalog.prs[pr];
  if (!price) fail(`no price for ${model}`);
  if (!size) fail(`no size for PR ${pr}`);
  return (size.input * price.input + size.output * price.output) / 1e6;
}

/** The worst case of a find that may spend its whole limit, since these models are here for spending it. */
function secondTryUsd(catalog, model, pr, limit) {
  const price = priceOf(catalog, model);
  if (!price) fail(`no price for ${model}`);
  return (catalog.prs[pr].input * price.input + limit * price.output) / 1e6;
}

function verifyUsd(catalog, model) {
  const price = priceOf(catalog, model);
  const reference = priceOf(catalog, REFERENCE_JUDGE);
  if (!price) fail(`no price for ${model}`);
  if (!reference) fail(`no price for ${REFERENCE_JUDGE}`);
  return VERIFY_BASE_USD * (price.output / reference.output);
}

/** The host pin of a candidate; an openrouter candidate without one makes the runs incomparable. */
function pinOf(entry) {
  if (entry.route === 'openrouter' && entry.only === null) {
    fail(`${entry.label} is on openrouter with no pinned host; run --endpoints and set "only" first`);
  }
  return entry.only;
}

/** A judge's own host pin: its `judges` row, else a candidate with the same model. */
function judgePin(catalog, judge) {
  if (judge.route !== 'openrouter') return null;
  const row = (catalog.judges ?? []).find((j) => j.model === judge.model);
  if (row) {
    if (row.only === null) fail(`judge ${judge.model} is on openrouter with no pinned host; run --endpoints and set "only" first`);
    return row.only;
  }
  const entry = catalog.candidates.find((c) => c.model === judge.model && c.route === 'openrouter');
  if (!entry) fail(`judge ${judge.model} is on openrouter with no judges row or candidate to take the host pin from; add one and run --endpoints`);
  return pinOf(entry);
}

export function planBatch({ batch, catalog, labels, verifyModel, verifyRoute, judges, preflight }) {
  const base = catalog.baseline;
  const baseEntry = { label: base.label, model: base.findModel, route: base.route, only: null };
  const live = catalog.candidates.filter((c) => c.dropped === undefined);
  const tier = (name) => live.filter((c) => c.tier === name);
  const defaultJudge = { model: base.verifyModel, route: 'openai' };

  // Only batch 0 runs before the preflight; a preflight that refused left no file, so #418 stays stopped too.
  if (batch !== 0 && !preflight) fail(`batch ${batch} needs the preflight`);

  const chosen = ({ dropped = false } = {}) => {
    if (!Array.isArray(labels)) fail(`batch ${batch} needs labels`);
    return labels.map((label) => {
      const entry = catalog.candidates.find((c) => c.label === label) ?? fail(`unknown label ${label}`);
      if (!dropped && entry.dropped !== undefined) fail(`${label} is dropped: ${entry.dropped}`);
      return entry;
    });
  };
  const need = (value, name, entry) => value ?? fail(`a whole run of ${entry.label} needs ${name}`);
  const corpus = () => catalog.corpus.filter((pr) => preflight.corpus.includes(pr));
  const recall930 = () => {
    if (!preflight.recall930) fail('the preflight dropped #930');
    return '930';
  };

  const make = ({ entry, pr, draw, mode, judge, cacheOffModels = null, from = null, expectFailure = false }) => {
    const size = catalog.prs[pr] ?? fail(`unknown PR ${pr}`);
    const common = { batch, label: entry.label, draw, pr, head: size.head, mode, findModel: entry.model, cacheOffModels, from, expectFailure };
    if (mode === 'find') {
      const pin = pinOf(entry);
      return { ...common, route: entry.route, verifyModel: null, only: { find: pin, verify: null }, estimateUsd: findUsd(catalog, entry.model, pr) };
    }
    if (mode === 'verify') {
      return {
        ...common,
        route: judge.route,
        verifyModel: judge.model,
        only: { find: null, verify: judgePin(catalog, judge) },
        estimateUsd: verifyUsd(catalog, judge.model),
      };
    }
    const baseline = entry === baseEntry;
    const model = baseline ? base.verifyModel : need(verifyModel, 'verifyModel', entry);
    const route = baseline ? base.route : need(verifyRoute, 'verifyRoute', entry);
    if (route !== entry.route) fail(`verifyRoute ${route} must match the route ${entry.route} of ${entry.label}`);
    const pin = pinOf(entry);
    return {
      ...common,
      route: entry.route,
      verifyModel: model,
      only: { find: pin, verify: judgePin(catalog, { model, route }) },
      estimateUsd: findUsd(catalog, entry.model, pr) + verifyUsd(catalog, model),
    };
  };

  /** Round by round: all first draws, then all second ones, so the ceiling cuts evenly. */
  const rounds = (entries, draws, spec) => draws.flatMap((draw) => entries.map((entry) => make({ ...spec, entry, draw })));
  const verifyOf = (entry, pr, draw, judge, extra = {}) =>
    make({ entry, pr, draw, mode: 'verify', judge, from: { label: entry.label, pr, draw }, ...extra });

  const secondTry = SECOND_TRY[batch];
  if (secondTry !== undefined) {
    const { draws, findMaxTokens, findReasoning } = secondTry;
    return rounds(chosen({ dropped: true }), draws, { pr: '418', mode: 'find' }).map((run) => ({
      ...run,
      findMaxTokens,
      findReasoning,
      estimateUsd: secondTryUsd(catalog, run.findModel, run.pr, findMaxTokens ?? DEFAULT_FIND_LIMIT),
    }));
  }

  switch (batch) {
    case 0: {
      const all = [baseEntry, ...live];
      return [
        ...rounds(all, [1], { pr: '895', mode: 'find' }),
        make({ entry: baseEntry, pr: '688', draw: 1, mode: 'find' }),
        make({ entry: baseEntry, pr: '688', draw: 2, mode: 'find' }),
        make({ entry: baseEntry, pr: '688', draw: 3, mode: 'find', cacheOffModels: [base.findModel] }),
        verifyOf(baseEntry, '688', 1, defaultJudge, { cacheOffModels: [base.verifyModel], expectFailure: true }),
      ];
    }
    case 1:
      return DRAWS.flatMap((draw) => [
        make({ entry: baseEntry, pr: '418', draw, mode: 'find' }),
        verifyOf(baseEntry, '418', draw, defaultJudge),
      ]);
    case 2:
      return rounds(tier('cheap'), DRAWS, { pr: '418', mode: 'find' });
    case 3:
      return rounds(tier('mid'), [1], { pr: '418', mode: 'find' });
    case 4:
      return rounds(chosen(), [2, 3], { pr: '418', mode: 'find' });
    case 5:
      return rounds(tier('expensive'), [1, 2], { pr: '418', mode: 'find' });
    case 6:
      return rounds(chosen(), [3], { pr: '418', mode: 'find' });
    case 7: {
      const entries = chosen();
      return DRAWS.flatMap((draw) => entries.map((entry) => verifyOf(entry, '418', draw, defaultJudge)));
    }
    case 101:
      return rounds([baseEntry, ...chosen()], DRAWS, { pr: recall930(), mode: 'whole' });
    case 102:
      return corpus().map((pr) => make({ entry: baseEntry, pr, draw: 1, mode: 'whole' }));
    case 103: {
      const entries = chosen();
      return entries.flatMap((entry) => corpus().map((pr) => make({ entry, pr, draw: 1, mode: 'whole' })));
    }
    case 104: {
      if (!Array.isArray(judges) || judges.length === 0) fail('batch 104 needs judges');
      const entries = [baseEntry, ...(labels === undefined ? [] : chosen())];
      return judges.flatMap((judge) => entries.map((entry) => verifyOf(entry, '418', 1, judge)));
    }
    case 105:
      return [
        ...DRAWS.map((draw) => make({ entry: baseEntry, pr: '418', draw, mode: 'whole' })),
        ...corpus().map((pr) => make({ entry: baseEntry, pr, draw: 1, mode: 'whole' })),
      ];
    case 106:
      return rounds(chosen(), DRAWS, { pr: '418', mode: 'whole' });
    default:
      return fail(`unknown batch ${batch}`);
  }
}
