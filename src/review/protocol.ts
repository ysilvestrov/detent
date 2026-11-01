// The review protocol: the prompt, the result line, the marker and its reasons.
// It knows nothing about processes (spec, «Під реліз 2»); the CLI runner does the I/O.

export type Mode = 'diff' | 'spec';
export type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string };

const RESULT_LINE = /^CROSS-REVIEW-RESULT: (\d+) findings?\s*$/;
const MARKER_REASON_MAX = 200;

// Only the very last line of the report counts, so a result line the reviewer quotes mid-report
// (the prompt, a code fence) can never be the verdict.
export function classifyResult(report: string): Verdict {
  const last = report.trimEnd().split('\n').pop() ?? '';
  const m = RESULT_LINE.exec(last);
  if (!m) return { kind: 'failed', reason: 'output does not end with a CROSS-REVIEW-RESULT line' };
  return { kind: 'ok', findings: Number(m[1]) };
}

// A reason inside the marker: one line, bounded (a codex usage-limit line carries URLs).
export function markerReason(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  if (first === '') return 'unknown error';
  const chars = Array.from(first); // code points: a cut must not leave half a surrogate pair
  return chars.length <= MARKER_REASON_MAX ? first : `${chars.slice(0, MARKER_REASON_MAX - 1).join('')}…`;
}

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`unfilled placeholder {{${key}}}`);
    return vars[key] as string;
  });
}

export interface ReviewerFailure { reviewer: string; reason: string }

// The marker after a successful review. The count is not agreed with its noun (`1 findings`):
// the marker format is fixed by the spec. A model not given explicitly is `default`.
export function successBody(p: {
  reviewer: string; model?: string; sha7: string; author: string; findings: number; fallbacks: ReviewerFailure[];
}): string {
  const head = `${p.reviewer}/${p.model || 'default'} @ ${p.sha7} (author: ${p.author}) — ${p.findings} findings: <f> fixed, <r> rejected`;
  if (p.fallbacks.length === 0) return head;
  const tail = p.fallbacks.map((f) => `${f.reviewer} — ${markerReason(f.reason)}`).join('; ');
  return `${head} (fallback: ${tail})`;
}

// The marker after the chain is exhausted or stopped by a timeout.
export function failedBody(author: string, failures: ReviewerFailure[]): string {
  const parts = [`author: ${author}`, ...failures.map((f) => `${f.reviewer}: ${markerReason(f.reason)}`)];
  return `failed (${parts.join('; ')})`;
}

// Where the author pastes the result: a PR body (diff mode) or the spec's own header (spec mode).
export function markerLine(mode: Mode, body: string): string {
  return mode === 'spec' ? `Spec marker: Spec-review: ${body}` : `PR marker: Cross-review: ${body}`;
}
