// Checks before any reviewer runs, and where a run keeps its files. Pure: the caller reads git.
import { join } from 'node:path';
import type { Mode } from './protocol.js';
import type { ReviewerId } from './adapters.js';

const DIRTY = 'working tree is dirty — commit first; the review is pinned to a SHA';

export function isNestedRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CROSS_REVIEW_ACTIVE === '1';
}

export function preflight(s: { dirty: boolean; diffBytes: number }): string | null {
  if (s.dirty) return DIRTY;
  if (s.diffBytes === 0) return 'empty diff against the base — nothing to review';
  return null;
}

export function specPreflight(s: { dirty: boolean; inHead: boolean }): string | null {
  if (s.dirty) return DIRTY;
  if (!s.inHead) return 'the spec is not committed at HEAD — commit it first; the review is pinned to a SHA';
  return null;
}

// A spec review reads one committed file, so the path is normalised (a Windows shell passes
// backslashes) and must name a spec in a month folder; anything else is a usage error.
export function normalizeSpecPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function specPathError(p: string, specsDir: string): string | null {
  const dir = normalizeSpecPath(specsDir).replace(/\/+$/, '');
  const pattern = new RegExp(`^${escapeRegExp(dir)}/\\d{4}-\\d{2}/[^/]+\\.md$`);
  return pattern.test(p) ? null : `--spec must name a .md file under ${dir}/<YYYY-MM>/, got "${p}"`;
}

// Every run owns a fresh directory (mkdtemp appends a unique suffix to this prefix), so two concurrent
// runs — same reviewer, branch and SHA included — never share a diff, report, log or snapshot.
export function runDirPrefix(tmpDir: string, reviewer: ReviewerId, branch: string, sha: string, mode: Mode): string {
  const kind = mode === 'spec' ? 'spec-' : '';
  return join(tmpDir, `cross-review-${kind}${reviewer}-${branch.replace(/\//g, '-')}-${sha.slice(0, 7)}-`);
}

export function runArtifacts(runDir: string): { diff: string; report: string; log: string; snapshot: string } {
  return {
    diff: join(runDir, 'branch.diff'),
    report: join(runDir, 'report.md'),
    log: join(runDir, 'reviewer.log'),
    snapshot: join(runDir, 'snapshot'),
  };
}
