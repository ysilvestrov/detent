// The record file of a replay: one JSON object per line, appended as the run goes.
//
// A `call` line is written the moment a model response arrives, so a run that dies later still leaves
// every paid call behind. The `run` line closes the run; a run without one is broken, and the
// evaluation counts its calls as spend but does not score it
// (spec 2026-11-03-pr-review-big-test-design.md, «Формат запису»).
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CallInfo } from './openai.js';
import type { Confidence, DropReason, Severity, Verdict } from './types.js';

export interface CallLine extends CallInfo {
  type: 'call';
  runId: string;
  stage: 'find' | 'verify';
}

export interface RunLine {
  type: 'run';
  runId: string;
  batch: number | null;
  label: string | null;
  provider: string | null;
  findModel: string | null;
  /** Null when the run never reaches the verify stage. */
  verifyModel: string | null;
  only: { find: string[] | null; verify: string[] | null };
  cacheMode: string;
  pr: string;
  /** Null when the run failed before the head was known. */
  head: string | null;
  base: string | null;
  draw: number | null;
  startedAt: string;
  diffOnly: string[];
  raised: number;
  gated: number;
  dropped: Array<{ file: string; reason: DropReason; claim: string }>;
  results: Array<{
    file: string;
    line: number;
    severity: Severity;
    confidence: Confidence;
    quote: string;
    claim: string;
    whyItBreaks: string;
    verdict: Verdict;
    evidence: string;
  }>;
  exit: number;
  /** Null on success. */
  error: string | null;
}

export interface RecordWriter {
  call(stage: 'find' | 'verify', info: CallInfo): void;
  run(line: Omit<RunLine, 'type' | 'runId'>): void;
}

/**
 * Opens `path` for appending, creating its folder. The file is opened here, not at the first write,
 * so an unwritable path fails before the run has spent anything.
 */
export function openRecord(path: string, runId: string): RecordWriter {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  // Windows opens a directory for appending without complaint and fails only at the first write, after the spend.
  if (fstatSync(fd).isDirectory()) {
    closeSync(fd);
    throw new Error(`${path} is a directory`);
  }
  const append = (line: CallLine | RunLine): void => {
    appendFileSync(fd, `${JSON.stringify(line)}\n`);
  };
  return {
    call: (stage, info) => append({ type: 'call', runId, stage, ...info }),
    run: (line) => append({ type: 'run', runId, ...line }),
  };
}
