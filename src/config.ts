// detent.json: the project config (spec, «Конфіг проєкту»). Pure: the caller reads the file and
// passes its text, or null when there is none.
import { REVIEWER_IDS, isReviewerId, type ReviewerId } from './review/adapters.js';

export interface Config {
  language: string;
  specFile: string;
  specsDir: string;
  plansDir: string;
  gate: string;
  baseBranch: string;
  tmpDir: string;
  reviewers: ReviewerId[];
  models: Partial<Record<ReviewerId, string>>;
  reviewContext?: string;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  language: 'uk',
  specFile: 'spec.md',
  specsDir: 'docs/specs',
  plansDir: 'docs/plans',
  gate: 'npm test && npm run typecheck',
  baseBranch: 'origin/main',
  tmpDir: 'tmp',
  reviewers: Object.freeze(['codex', 'claude', 'agy']) as ReviewerId[],
  models: Object.freeze({ codex: 'gpt-6.1-sol', agy: 'gemini-4-argon' }),
});

const STRING_KEYS = ['language', 'specFile', 'specsDir', 'plansDir', 'gate', 'baseBranch', 'tmpDir'] as const;
const EXPECTED_IDS = REVIEWER_IDS.join('|');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaults(): Config {
  return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], models: { ...DEFAULT_CONFIG.models } };
}

// No file → the defaults. A file → shallow merge over the defaults (a `models` in the file
// replaces the default `models` whole). Unknown top-level keys are ignored.
export function parseConfig(text: string | null): { ok: true; config: Config } | { ok: false; error: string } {
  if (text === null) return { ok: true, config: defaults() };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, '')); // a BOM from a Windows editor is not content
  } catch (e) {
    return { ok: false, error: `detent.json is not valid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(raw)) return { ok: false, error: 'detent.json must be a JSON object' };
  const config = defaults();

  for (const key of STRING_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const v = raw[key];
    if (typeof v !== 'string') return { ok: false, error: `detent.json: "${key}" must be a string` };
    config[key] = v;
  }

  if (Object.hasOwn(raw, 'reviewers')) {
    const v = raw.reviewers;
    if (!Array.isArray(v)) return { ok: false, error: 'detent.json: "reviewers" must be an array of reviewer ids' };
    const reviewers: ReviewerId[] = [];
    for (const id of v as unknown[]) {
      if (typeof id !== 'string') return { ok: false, error: 'detent.json: "reviewers" must be an array of reviewer ids' };
      if (!isReviewerId(id)) return { ok: false, error: `detent.json: unknown reviewer "${id}" in "reviewers" (expected ${EXPECTED_IDS})` };
      reviewers.push(id);
    }
    config.reviewers = reviewers;
  }

  if (Object.hasOwn(raw, 'models')) {
    const v = raw.models;
    if (!isPlainObject(v)) return { ok: false, error: 'detent.json: "models" must be an object' };
    const models: Partial<Record<ReviewerId, string>> = {};
    for (const [id, model] of Object.entries(v)) {
      if (!isReviewerId(id)) return { ok: false, error: `detent.json: unknown reviewer "${id}" in "models" (expected ${EXPECTED_IDS})` };
      if (typeof model !== 'string' || model === '') {
        return { ok: false, error: `detent.json: "models.${id}" must be a non-empty string` };
      }
      models[id] = model;
    }
    config.models = models;
  }

  if (Object.hasOwn(raw, 'reviewContext')) {
    const v = raw.reviewContext;
    if (typeof v !== 'string') return { ok: false, error: 'detent.json: "reviewContext" must be a string' };
    config.reviewContext = v;
  }

  return { ok: true, config };
}
