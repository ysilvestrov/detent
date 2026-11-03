// What a find-only replay leaves behind for `--verify-from`: the find's output and the gate's verdict on it.
//
// The funnel of the big test runs find once per candidate model, then verifies the same findings with
// other judges (spec 2026-11-03-pr-review-big-test-design.md). `scope` ties the file to the prompts and
// settings it was found with, so a verify under other prompts is refused rather than silently compared.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DroppedFinding, DropReason, GatedFinding, RawFinding } from './types.js';

export interface SavedFindings {
  v: 1;
  pr: string;
  head: string;
  base: string;
  findModel: string;
  scope: string;
  raised: RawFinding[];
  kept: GatedFinding[];
  dropped: DroppedFinding[];
}

/**
 * Creates the folder and opens the file for appending, then lets go of it. Done before the paid find call,
 * so a path that cannot be written is found out before the money is spent; `saveFindings` replaces the content later.
 */
export function checkFindingsPath(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    // Windows opens a directory for appending without complaint and fails only at the first write.
    if (fstatSync(fd).isDirectory()) throw new Error(`${path} is a directory`);
  } finally {
    closeSync(fd);
  }
}

export function saveFindings(path: string, s: SavedFindings): void {
  writeFileSync(path, JSON.stringify(s));
}

// Hand-written checks, as in validate.ts: they name the first field that is wrong.
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

const SEVERITIES = ['P0', 'P1', 'P2'];
const CONFIDENCES = ['high', 'medium', 'low'];
const REASONS: DropReason[] = ['out_of_scope', 'quote_not_found', 'outside_changed_lines', 'duplicate'];

const RAW_CHECKS: Array<[string, (v: unknown) => boolean]> = [
  ['file', isStr],
  ['start_line', isInt],
  ['end_line', isInt],
  ['quote', isStr],
  ['claim', isStr],
  ['why_it_breaks', isStr],
  ['severity', (v) => isStr(v) && SEVERITIES.includes(v)],
  ['confidence', (v) => isStr(v) && CONFIDENCES.includes(v)],
];

/** Throws with the name of the first field of `v` that fails its check. */
function checkFields(v: unknown, where: string, checks: Array<[string, (v: unknown) => boolean]>): asserts v is Obj {
  if (!isObj(v)) throw new Error(`${where} is not an object`);
  for (const [name, ok] of checks) {
    if (!ok(v[name])) throw new Error(`${where}: field "${name}" is missing or wrong`);
  }
}

function checkList(v: unknown, where: string, checkItem: (item: unknown, at: string) => void): void {
  if (!Array.isArray(v)) throw new Error(`field "${where}" is missing or not a list`);
  v.forEach((item, i) => checkItem(item, `${where}[${i}]`));
}

export function readFindings(path: string): SavedFindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the findings file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const where = `findings file ${path}`;
  checkFields(parsed, where, [
    ['v', (v) => v === 1],
    ['pr', isStr],
    ['head', isStr],
    ['base', isStr],
    ['findModel', isStr],
    ['scope', isStr],
  ]);
  checkList(parsed.raised, 'raised', (item, at) => checkFields(item, at, RAW_CHECKS));
  checkList(parsed.kept, 'kept', (item, at) =>
    checkFields(item, at, [...RAW_CHECKS, ['matchedLine', isInt], ['matchedEndLine', isInt]]),
  );
  checkList(parsed.dropped, 'dropped', (item, at) => {
    checkFields(item, at, [['reason', (v) => isStr(v) && (REASONS as string[]).includes(v)]]);
    checkFields(item.finding, `${at}.finding`, RAW_CHECKS);
  });
  return parsed as unknown as SavedFindings;
}
