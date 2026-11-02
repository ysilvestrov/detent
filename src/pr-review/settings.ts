// What a PR review is configured with, read from the BASE branch and never from the PR's own head.
// A PR that rewrote detent.json or the prompts could otherwise switch its own review off or steer it;
// reading the base means the settings change only through a change someone already merged.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig, type PrReviewConfig } from '../config.js';
import { renderPrompt } from '../review/protocol.js';

/** A broken project configuration: the review does not run (exit 2). */
export class ConfigError extends Error {}

export interface FilePatterns {
  include: string[];
  ignore: string[];
  bodyExclude: string[];
  bodyInclude: string[];
}

export const DEFAULT_PATTERNS: FilePatterns = {
  include: ['**'],
  ignore: ['**/*.md', 'docs/**', 'package-lock.json'],
  bodyExclude: ['**/*.test.*', 'tests/**'],
  bodyInclude: [],
};

export interface ReviewSettings {
  patterns: FilePatterns;
  findPrompt: string;
  verifyPrompt: string;
  /** Fingerprint of the config and the prompts; see `scopeOf`. */
  scope: string;
  configured: PrReviewConfig;
}

const FIND_PROMPT = 'pr-review-find.md';
const VERIFY_PROMPT = 'pr-review-verify.md';

function packagePrompt(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url)), 'utf8');
}

// The four things a review's result depends on. Any of them changing makes an earlier review stale.
function scopeOf(prReview: PrReviewConfig | undefined, reviewContext: string | undefined, findPrompt: string, verifyPrompt: string): string {
  return createHash('sha256')
    .update(JSON.stringify([prReview ?? null, reviewContext ?? null, findPrompt, verifyPrompt]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * `read` returns the text of a repo-relative path, or null when there is no such file.
 * `readDefault` reads a prompt shipped in the package; it is a parameter so the lookup can be tested.
 */
export function loadSettings(
  read: (path: string) => string | null,
  readDefault: (name: string) => string = packagePrompt,
): ReviewSettings {
  const parsed = parseConfig(read('detent.json'));
  if (!parsed.ok) throw new ConfigError(parsed.error);
  const { config } = parsed;
  const configured = config.prReview ?? {};

  const prompt = (name: string): string => {
    const path = `.detent/prompts/${name}`;
    const template = read(path) ?? readDefault(name);
    try {
      return renderPrompt(template, { reviewContext: config.reviewContext ?? 'none stated' });
    } catch (e) {
      throw new ConfigError(`${path}: ${(e as Error).message}`);
    }
  };
  const findPrompt = prompt(FIND_PROMPT);
  const verifyPrompt = prompt(VERIFY_PROMPT);

  return {
    patterns: {
      include: configured.include ?? DEFAULT_PATTERNS.include,
      ignore: configured.ignore ?? DEFAULT_PATTERNS.ignore,
      bodyExclude: configured.bodyExclude ?? DEFAULT_PATTERNS.bodyExclude,
      bodyInclude: configured.bodyInclude ?? DEFAULT_PATTERNS.bodyInclude,
    },
    findPrompt,
    verifyPrompt,
    scope: scopeOf(config.prReview, config.reviewContext, findPrompt, verifyPrompt),
    configured,
  };
}

/**
 * A reader of files as they are on `origin/<baseRef>`. A missing ref is a ConfigError, not a quiet
 * fall back to the defaults: an incomplete checkout would otherwise review under settings nobody chose.
 */
export function baseReader(cwd: string, baseRef: string): (path: string) => string | null {
  // The full ref name: a tag called `origin/<base>` would otherwise shadow the branch, and a same-repo
  // author could steer the review from a tag that is not in the PR diff.
  const ref = `refs/remotes/origin/${baseRef}`;
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

  const check = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (check.error || check.status !== 0) {
    throw new ConfigError(`cannot read the settings: origin/${baseRef} is not in this checkout (fetch the base branch, e.g. actions/checkout with fetch-depth: 0)`);
  }
  return (path) => {
    const r = git(['show', `${ref}:${path}`]);
    return r.error || r.status !== 0 ? null : r.stdout;
  };
}
