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

/**
 * `runs` are `run` lines; `read(findingsFile)` returns the saved findings of a find.
 * Returns the items for the grader and the key that stays out of its task.
 */
export function anonymize({ runs, read, shuffle = shuffleInPlace }) {
  const entries = runs
    .filter((run) => isScorable(run) && !run.expectFailure)
    .map((run) => {
      const id = randomUUID();
      return {
        item: { id, pr: run.pr, head: run.head, stage: run.mode, findings: findingsOf(run, read) },
        mapped: { label: run.label, draw: run.draw, pr: run.pr, batch: run.batch, attempt: run.attempt },
      };
    });
  const key = {};
  for (const { item, mapped } of entries) key[item.id] = mapped;
  return { items: shuffle(entries.map((e) => e.item)), key };
}

/** Anonymous scores to `{label: {draw: scores}}`; an id missing from the key is a mix-up and throws. */
export function applyKey(anonScores, key) {
  const scores = {};
  for (const [id, value] of Object.entries(anonScores)) {
    const entry = key[id];
    if (entry === undefined) throw new Error(`anonymize: id ${id} is not in the key`);
    scores[entry.label] ??= {};
    scores[entry.label][entry.draw] = value;
  }
  return scores;
}
