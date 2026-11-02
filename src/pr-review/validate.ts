import type { RawFinding } from './types.js';
import type { ReviewState } from './state.js';

// Hand-written replacements for the zod schemas of warsaw-beer-bot. Like
// `zod.object`, they check only the fields they name and ignore the rest.

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isOneOf(v: unknown, allowed: readonly string[]): boolean {
  return typeof v === 'string' && allowed.includes(v);
}

const SEVERITIES = ['P0', 'P1', 'P2'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;
const VERDICTS = ['confirmed', 'refuted', 'out_of_scope'] as const;

function isRawFinding(v: unknown): v is RawFinding {
  return (
    isObj(v) &&
    isStr(v.file) &&
    isInt(v.start_line) &&
    isInt(v.end_line) &&
    isStr(v.quote) &&
    isStr(v.claim) &&
    isStr(v.why_it_breaks) &&
    isOneOf(v.severity, SEVERITIES) &&
    isOneOf(v.confidence, CONFIDENCES)
  );
}

export function isFindings(v: unknown): v is { findings: RawFinding[] } {
  return isObj(v) && Array.isArray(v.findings) && v.findings.every(isRawFinding);
}

function isVerdictItem(v: unknown): boolean {
  return isObj(v) && isInt(v.index) && isOneOf(v.verdict, VERDICTS) && isStr(v.evidence);
}

export function isVerdicts(
  v: unknown,
): v is { verdicts: Array<{ index: number; verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }> } {
  return isObj(v) && Array.isArray(v.verdicts) && v.verdicts.every(isVerdictItem);
}

function isStoredFinding(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.file) &&
    isStr(v.quote) &&
    isInt(v.matchedLine) &&
    isInt(v.matchedEndLine) &&
    isStr(v.claim) &&
    isStr(v.why_it_breaks) &&
    isOneOf(v.severity, SEVERITIES) &&
    isStr(v.evidence)
  );
}

export function isReviewState(v: unknown): v is ReviewState {
  if (!isObj(v) || v.v !== 1 || !isStr(v.head)) return false;
  if (!Array.isArray(v.findings) || !v.findings.every(isStoredFinding)) return false;
  if (v.scope !== undefined && !isStr(v.scope)) return false;
  const s = v.spend;
  return isObj(s) && typeof s.usd === 'number' && isInt(s.runs) && isInt(s.unpriced);
}
