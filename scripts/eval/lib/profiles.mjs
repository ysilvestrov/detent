// The profile rules of the spec ("Правила профілів"), applied to the rows of summary.mjs, one cell per route.
const ROUTES = ['openai', 'anthropic', 'openrouter'];
const MIN_CORPUS_PRS = 3;
const MIN_PUBLISHED_ON_CORPUS = 3;
const MIN_CONSENSUS = 14;
const MAX_BROKEN_CALLS = 1;
const VALUE_MIN_418 = 3;
const VALUE_MIN_930 = 1;
/** At this many `refuted` per run a row is out of the funnel (spec, batch 7). */
const MAX_REFUTED_MEAN = 2;
/** Best of the best only (spec, the table of candidates). */
const EXPENSIVE = 'expensive';

/** The admission to any profile; `reasons` name every rule the row fails. */
export function admitted(row) {
  const reasons = [];
  if (row.corpus.prs < MIN_CORPUS_PRS) reasons.push(`corpus has ${row.corpus.prs} PRs, needs ${MIN_CORPUS_PRS}`);
  if (row.corpus.false > 0) reasons.push(`${row.corpus.false} false findings on the corpus`);
  if (row.corpus.published < MIN_PUBLISHED_ON_CORPUS) reasons.push(`${row.corpus.published} published findings on the corpus, needs ${MIN_PUBLISHED_ON_CORPUS}`);
  if (row.judgeConsensus === null || row.judgeConsensus < MIN_CONSENSUS) reasons.push(`judge consensus ${row.judgeConsensus ?? 'unknown'} of 15, needs ${MIN_CONSENSUS}`);
  if (row.brokenCalls > MAX_BROKEN_CALLS) reasons.push(`${row.brokenCalls} empty or broken calls, at most ${MAX_BROKEN_CALLS}`);
  return { ok: reasons.length === 0, reasons };
}

/** The median a profile ranks by: published when the row has it, the find stage's otherwise. */
const merit = (row) => row.medianPublished ?? row.medianKnown ?? -Infinity;
const on930 = (row) => row.medianRecall930 ?? -Infinity;
/** The defects behind `merit`, by the same choice. */
const defectsOf = (row) => (row.medianPublished === null ? row.findDefects : row.publishedDefects);

function cellOf(row, pool, extra = '') {
  const verdict = admitted(row);
  const notes = [];
  if (!verdict.ok) notes.push(`not admitted: ${verdict.reasons.join('; ')}`);
  if (row.medianPublished === null) notes.push('ranked on find-stage scores, no published median');
  if (row.medianRecall930 === null) notes.push('no #930 yet');
  if (row.unstable) notes.push('unstable: the owner decides');
  if (row.composite) notes.push('composite pair');
  if (pool === 'unadmitted') notes.push('nobody on the route passed the admission');
  if (extra !== '') notes.push(extra);
  return { row, preliminary: !verdict.ok || row.medianRecall930 === null || row.medianPublished === null, note: notes.join('; ') };
}

const empty = { row: null, preliminary: false, note: 'no row on this route' };
const emptied = { row: null, preliminary: false, note: 'every row on this route left the pool' };
const usd = (value) => `$${value.toFixed(2)}`;

/**
 * The candidates of each route for the three profiles. Rows past the admission are used when nobody on the route
 * passed it, and then every cell is preliminary.
 */
export function pickProfiles(rows, baseline) {
  const best = {};
  const balanced = {};
  const value = {};
  // For ranking only: a row with no judge measured on #418 would look cheapest for that reason alone.
  const estimate = baseline.judgeUsd ?? null;
  const cost = (row) => (row.productionUsd ?? Infinity) + (row.judgeUsd === null ? estimate ?? 0 : 0);
  const judgeNote = (row) => {
    if (row.judgeUsd !== null) return '';
    return estimate === null ? 'no judge cost in the price yet' : `judge cost estimated at ${usd(estimate)} from the baseline`;
  };
  const isBaseline = (row) => row.label === baseline.label && row.judge === baseline.judge;
  const notes = (...parts) => parts.filter((part) => part !== '').join('; ');
  const byMeritThen930ThenCost = (a, b) => merit(b) - merit(a) || on930(b) - on930(a) || cost(a) - cost(b);

  for (const route of ROUTES) {
    const onRoute = rows.filter((r) => r.route === route && !r.generic);
    if (onRoute.length === 0) {
      best[route] = balanced[route] = value[route] = empty;
      continue;
    }
    const inFunnel = onRoute.filter((r) => !r.dropped && (r.refutedMean === null || r.refutedMean < MAX_REFUTED_MEAN));
    if (inFunnel.length === 0) {
      best[route] = balanced[route] = value[route] = emptied;
      continue;
    }
    const passed = inFunnel.filter((r) => admitted(r).ok);
    const pool = passed.length > 0 ? passed : inFunnel;
    const poolName = passed.length > 0 ? 'admitted' : 'unadmitted';
    const notExpensive = pool.filter((r) => r.tier !== EXPENSIVE);

    const ranked = [...pool].sort(byMeritThen930ThenCost);
    let leader = ranked[0];
    let bestNote = '';
    if (baseline.route === route && !isBaseline(leader)) {
      const confirmed = merit(leader) > merit(baseline) ? leader.medianRecall930 !== null && baseline.medianRecall930 !== null && leader.medianRecall930 > baseline.medianRecall930 : true;
      if (!confirmed) {
        leader = baseline;
        bestNote = 'the lead over the baseline is not confirmed on #930, so the baseline stays';
      }
    }
    best[route] = cellOf(leader, poolName, notes(bestNote, judgeNote(leader)));

    const within = notExpensive
      .filter((r) => merit(r) >= merit(leader) - 1 && (leader.medianRecall930 === null || (r.medianRecall930 !== null && r.medianRecall930 >= leader.medianRecall930 - 1)))
      .sort((a, b) => cost(a) - cost(b) || b.corpus.real - a.corpus.real);
    const pick = within[0] ?? (leader.tier === EXPENSIVE ? null : leader);
    const gives = (row) => {
      if (row === leader) return '';
      const lost = defectsOf(leader).filter((id) => !defectsOf(row).includes(id));
      const saving = cost(leader) - cost(row);
      return `loses ${lost.length === 0 ? 'no named defect' : lost.join(', ')} against ${leader.label}; ${Number.isFinite(saving) ? `saves ${usd(saving)} per PR` : 'the saving is unknown'}`;
    };
    balanced[route] =
      pick === null
        ? { row: null, preliminary: false, note: 'nobody outside the expensive tier is within one defect of the leader' }
        : cellOf(pick, poolName, notes(gives(pick), judgeNote(pick)));

    const cheap = notExpensive
      .filter((r) => merit(r) >= VALUE_MIN_418 && (r.medianRecall930 === null || r.medianRecall930 >= VALUE_MIN_930))
      .sort((a, b) => cost(a) - cost(b) || (a.refutedMean ?? Infinity) - (b.refutedMean ?? Infinity));
    value[route] = cheap.length === 0 ? { row: null, preliminary: false, note: 'nobody reaches 3 on #418 and 1 on #930' } : cellOf(cheap[0], poolName, judgeNote(cheap[0]));
  }
  return { best, balanced, value };
}

/** The labels the report offers as finalists: whoever leads a profile, without the baseline, once each. */
export function proposeFinalists(picks, baselineLabel) {
  const cells = [picks.best, picks.balanced, picks.value].flatMap((profile) => ROUTES.map((route) => profile[route]));
  return [...new Set(cells.filter((cell) => cell.row !== null).map((cell) => cell.row.label))].filter((label) => label !== baselineLabel);
}
