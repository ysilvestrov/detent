// The selection rules between batches: who is dropped by the scores, and the refusal to run a batch outside them.

const MIN_DEFECTS = 2;
const MAX_LABELS_BATCH_7 = 5;
const MAX_LABELS_BATCH_101 = 2;
/** The batches whose scores qualify a label for batch 7. Batch 6 is not required: the ceiling can cut it. */
const SCORED_FOR_7 = [2, 3, 4, 5, 6];
/** The batch whose scores decide who runs in a batch. */
const SCORED_BEFORE = { 4: 3, 6: 5 };

/** Unstable: the draws differ by 2 defects or more, or one has at least twice the findings of another. */
export function isUnstable(draws) {
  const rows = Object.values(draws);
  const defects = rows.map((row) => row.defects.length);
  const findings = rows.map((row) => row.findings);
  const mostFindings = Math.max(...findings);
  return Math.max(...defects) - Math.min(...defects) >= MIN_DEFECTS || (mostFindings > 0 && mostFindings >= 2 * Math.min(...findings));
}

/** Labels that go on to the batch, from the scores of the batch before it. */
export function survivors(batch, scoresByBatch) {
  const before = SCORED_BEFORE[batch];
  if (before === undefined) throw new Error(`batch ${batch} has no selection rule`);
  const scores = scoresByBatch[before];
  if (scores === undefined) throw new Error(`batch ${batch} needs the scores of batch ${before}`);
  return Object.keys(scores).filter((label) => {
    const draws = scores[label];
    if (draws[1] === undefined || draws[1].defects.length < MIN_DEFECTS) return false;
    return batch === 4 || !isUnstable(draws);
  });
}

/** The reason a batch must not start with these labels, or null. */
export function checkLabels({ batch, labels, scoresByBatch }) {
  const before = SCORED_BEFORE[batch];
  if (before !== undefined) {
    if (scoresByBatch[before] === undefined) return `batch ${batch} needs the scores of batch ${before}`;
    const alive = survivors(batch, scoresByBatch);
    const dropped = labels.filter((label) => !alive.includes(label));
    if (dropped.length > 0) return `batch ${batch}: ${dropped.join(', ')} did not survive batch ${before}`;
  }
  if (batch === 7 && labels.length > MAX_LABELS_BATCH_7) return `batch 7 takes at most ${MAX_LABELS_BATCH_7} labels, got ${labels.length}`;
  if (batch === 7) {
    const scored = new Set(SCORED_FOR_7.flatMap((b) => Object.keys(scoresByBatch[b] ?? {})));
    const unscored = labels.filter((label) => !scored.has(label));
    if (unscored.length > 0) return `batch 7: ${unscored.join(', ')} has no score in batches 2-6`;
  }
  if (batch === 101 && labels.length > MAX_LABELS_BATCH_101) return `batch 101 takes at most ${MAX_LABELS_BATCH_101} labels, got ${labels.length}`;
  return null;
}
