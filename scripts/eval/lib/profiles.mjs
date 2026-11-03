// The profile rules of the spec ("Правила профілів"), applied to the rows of summary.mjs, one cell per route.
const ROUTES = ['openai', 'anthropic', 'openrouter'];
const MIN_CORPUS_PRS = 3;
const MIN_PUBLISHED_ON_CORPUS = 3;
const MIN_CONSENSUS = 14;
const MAX_BROKEN_CALLS = 1;
const VALUE_MIN_418 = 3;
const VALUE_MIN_930 = 1;

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
const cost = (row) => row.productionUsd ?? Infinity;
const byMeritThen930ThenCost = (a, b) => merit(b) - merit(a) || on930(b) - on930(a) || cost(a) - cost(b);

function cellOf(row, pool, extra = '') {
  const verdict = admitted(row);
  const notes = [];
  if (!verdict.ok) notes.push(`not admitted: ${verdict.reasons.join('; ')}`);
  if (row.medianRecall930 === null) notes.push('no #930 yet');
  if (row.unstable) notes.push('unstable: the owner decides');
  if (row.composite) notes.push('composite pair');
  if (pool === 'unadmitted') notes.push('nobody on the route passed the admission');
  if (extra !== '') notes.push(extra);
  return { row, preliminary: !verdict.ok || row.medianRecall930 === null, note: notes.join('; ') };
}

const empty = { row: null, preliminary: false, note: 'no row on this route' };

/**
 * The candidates of each route for the three profiles. Rows past the admission are used when nobody on the route
 * passed it, and then every cell is preliminary.
 */
export function pickProfiles(rows, baseline) {
  const best = {};
  const balanced = {};
  const value = {};
  for (const route of ROUTES) {
    const onRoute = rows.filter((r) => r.route === route);
    if (onRoute.length === 0) {
      best[route] = balanced[route] = value[route] = empty;
      continue;
    }
    const passed = onRoute.filter((r) => admitted(r).ok);
    const pool = passed.length > 0 ? passed : onRoute;
    const poolName = passed.length > 0 ? 'admitted' : 'unadmitted';

    const ranked = [...pool].sort(byMeritThen930ThenCost);
    let leader = ranked[0];
    let bestNote = '';
    if (baseline.route === route && leader.label !== baseline.label) {
      const confirmed = merit(leader) > merit(baseline) ? leader.medianRecall930 !== null && baseline.medianRecall930 !== null && leader.medianRecall930 > baseline.medianRecall930 : true;
      if (!confirmed) {
        leader = baseline;
        bestNote = 'the lead over the baseline is not confirmed on #930, so the baseline stays';
      }
    }
    best[route] = cellOf(leader, poolName, bestNote);

    const within = pool
      .filter((r) => merit(r) >= merit(leader) - 1 && (leader.medianRecall930 === null || (r.medianRecall930 !== null && r.medianRecall930 >= leader.medianRecall930 - 1)))
      .sort((a, b) => cost(a) - cost(b) || b.corpus.real - a.corpus.real);
    balanced[route] = cellOf(within[0] ?? leader, poolName);

    const cheap = pool
      .filter((r) => merit(r) >= VALUE_MIN_418 && (r.medianRecall930 === null || r.medianRecall930 >= VALUE_MIN_930))
      .sort((a, b) => cost(a) - cost(b) || (a.refutedMean ?? Infinity) - (b.refutedMean ?? Infinity));
    value[route] = cheap.length === 0 ? { row: null, preliminary: false, note: 'nobody reaches 3 on #418 and 1 on #930' } : cellOf(cheap[0], poolName);
  }
  return { best, balanced, value };
}
