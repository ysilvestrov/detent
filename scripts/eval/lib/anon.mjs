// Strips a run down to what the blind grader may see, and maps the grader's scores back through the key.
import { randomUUID } from 'node:crypto';
import { isScorable } from './records.mjs';

const BASE_FIELDS = ['file', 'line', 'severity', 'confidence', 'quote', 'claim', 'whyItBreaks'];
const VERIFY_FIELDS = ['verdict', 'evidence'];

const pick = (source, fields) => Object.fromEntries(fields.map((f) => [f, source[f]]));

/** A `kept` finding of a find-only file, in the shape the other stages use. */
const fromKept = (k) => ({
  file: k.file,
  line: k.matchedLine,
  severity: k.severity,
  confidence: k.confidence,
  quote: k.quote,
  claim: k.claim,
  whyItBreaks: k.why_it_breaks,
});

function shuffleInPlace(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function findingsOf(run, read) {
  if (run.mode === 'find') return read(run.findingsFile).kept.map((k) => pick(fromKept(k), BASE_FIELDS));
  return run.results.map((r) => pick(r, [...BASE_FIELDS, ...VERIFY_FIELDS]));
}

const TEXT_FIELDS = ['file', 'quote', 'claim', 'whyItBreaks', 'evidence'];

/** The run's own names; a finding's text holding one may tell the grader whose it is. */
const namesOf = (run) => [run.label, run.findModel, run.verifyModel].filter((n) => typeof n === 'string' && n !== '');

const mentionsOwnName = (run, findings) =>
  findings.some((f) => TEXT_FIELDS.some((field) => typeof f[field] === 'string' && namesOf(run).some((name) => f[field].includes(name))));

/** Batches that hold more than one item per label and draw: batch 1 a find and a verify, batch 104 several judges. */
const MULTI_ITEM_BATCHES = [1, 104];

/** In those batches a verify is keyed as `label@verifyModel`, so the scores do not collide. */
const keyLabel = (run) => (MULTI_ITEM_BATCHES.includes(run.batch) && run.mode === 'verify' && run.verifyModel ? `${run.label}@${run.verifyModel}` : run.label);

/**
 * `runs` are `run` lines; `read(findingsFile)` returns the saved findings of a find.
 * Returns the items for the grader, the key that stays out of its task, and `suspects`: ids of items whose text
 * holds the run's own label or model id (text is left as it is, since the grader checks quotes against the tree).
 */
export function anonymize({ runs, read, shuffle = shuffleInPlace }) {
  const entries = runs
    .filter((run) => isScorable(run) && !run.expectFailure)
    .map((run) => {
      const id = randomUUID();
      const findings = findingsOf(run, read);
      return {
        suspect: mentionsOwnName(run, findings),
        item: { id, pr: run.pr, head: run.head, stage: run.mode, findings },
        mapped: { label: keyLabel(run), draw: run.draw, pr: run.pr, batch: run.batch, attempt: run.attempt },
      };
    });
  const key = {};
  for (const { item, mapped } of entries) key[item.id] = mapped;
  const suspects = entries.filter((e) => e.suspect).map((e) => e.item.id);
  return { items: shuffle(entries.map((e) => e.item)), key, suspects };
}

/** Anonymous scores to `{label: {draw: scores}}`; an id missing from the key is a mix-up and throws. */
export function applyKey(anonScores, key) {
  const scores = {};
  const taken = {};
  for (const [id, value] of Object.entries(anonScores)) {
    const entry = key[id];
    if (entry === undefined) throw new Error(`anonymize: id ${id} is not in the key`);
    const slot = `${entry.label}|${entry.draw}`;
    if (taken[slot] !== undefined) throw new Error(`anonymize: ids ${taken[slot]} and ${id} are both label ${entry.label}, draw ${entry.draw}`);
    taken[slot] = id;
    scores[entry.label] ??= {};
    scores[entry.label][entry.draw] = value;
  }
  return scores;
}
