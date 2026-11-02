// The review itself: which files, the find and verify passes, what is published and what is carried.
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReviewContext } from './context.js';
import { runFind } from './find.js';
import { applyGate, changedLineRanges, findingKey } from './gate.js';
import { decideMode, incrementalScope, reconcileFindings, type ClosedFinding } from './incremental.js';
import type { Provider } from './providers.js';
import { renderBody, type OpenFinding } from './render.js';
import type { FilePatterns, ReviewSettings } from './settings.js';
import { parseState, toStored, type StoredFinding } from './state.js';
import type { GatedFinding, VerifyRequest } from './types.js';
import { EMPTY_USAGE, addUsage, costUsd, formatCostLine } from './usage.js';
import { verifyAll } from './verify.js';

/**
 * Paths whose BODY is never embedded in the review context — their diff still is,
 * and findings inside them are still legal and publishable.
 *
 * Deliberately not `ignore`: that removes a file from review entirely. `bodyExclude`
 * removes only the body, because a test body is the most expensive thing in the
 * context and the least useful. Measured 2026-09-22 on warsaw-beer-bot: test bodies
 * were 41% of the assembled context (687k of 1686k chars over nine PRs), and when the
 * budget binds, churn ordering spends it on them — on warsaw-beer-bot#670 that demoted
 * 31 SOURCE files to diff-only, on warsaw-beer-bot#669 the context held 168k chars of
 * tests against 2k of source. Only 1 of 38 published findings in live reviews targeted
 * a test file, and its quoted line was an ADDED line, present in the diff without the
 * body — which is general, not luck: the gate drops everything `outside_changed_lines`,
 * so a publishable finding always anchors to a line the diff already carries.
 *
 * `bodyInclude` takes a path back out of the exclusion (a file that matches a test
 * pattern by name but is not a test). Name test roots explicitly: globToRegExp compiles a
 * double star to `.*` with no path-boundary anchoring, so a pattern like "any-depth/tests/"
 * would also match `src/contests/foo.ts`. An over-broad exclusion hides real source from the
 * reviewer.
 */
export function isBodyExcluded(path: string, patterns: FilePatterns): boolean {
  if (matchesAny(path, patterns.bodyInclude)) return false;
  return matchesAny(path, patterns.bodyExclude);
}

/**
 * Wrap a file reader for CONTEXT ASSEMBLY ONLY.
 *
 * `buildReviewContext` treats `null` as "list this path as diff-only", which is
 * exactly the behaviour we want for a test file.
 *
 * Never hand this to `applyGate` or `verifyAll`. The gate locates the model's
 * verbatim quote in the real file and corrects the line number; verify reads the
 * body to adjudicate. Give either of them this reader and every finding inside a
 * test file becomes `quote_not_found` — the run stays green and a whole class of
 * finding disappears without a trace.
 *
 * A body with a NUL byte is binary and is hidden the same way: under the default `include: ["**"]`
 * it would otherwise go into the prompt as text.
 */
export function contextReader(
  readFile: (path: string) => string | null,
  patterns: FilePatterns,
): (path: string) => string | null {
  return (path) => {
    if (isBodyExcluded(path, patterns)) return null;
    const body = readFile(path);
    // A binary file matched by a wide include is diff-only: its bytes as text are noise for the model.
    return body !== null && body.includes('\0') ? null : body;
  };
}


export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function filterReviewableFiles(files: string[], patterns: FilePatterns): string[] {
  return files.filter((f) => matchesAny(f, patterns.include) && !matchesAny(f, patterns.ignore));
}

export function partitionPrFiles(files: string[], patterns: FilePatterns): {
  reviewable: string[];
  ignored: string[];
  unreviewed: string[];
} {
  const reviewable: string[] = [];
  const ignored: string[] = [];
  const unreviewed: string[] = [];
  for (const f of files) {
    if (matchesAny(f, patterns.include) && !matchesAny(f, patterns.ignore)) {
      reviewable.push(f);
    } else if (matchesAny(f, patterns.ignore)) {
      ignored.push(f);
    } else {
      unreviewed.push(f);
    }
  }
  return { reviewable, ignored, unreviewed };
}

/** What the caller knows about the pull request. */
export interface PrContext {
  repo: string;
  prNumber: number;
  baseRef: string;
  prTitle: string;
  prBody: string;
  githubToken: string;
}

/** How the review is run: the settings of the project, the provider and the models. */
export interface RunSettings {
  settings: ReviewSettings;
  provider: Provider;
  apiKey: string;
  findModel: string;
  verifyModel: string;
}

export const MARKER = '<!-- ai-pr-review -->';

export function wrapBody(summary: string): string {
  return `${MARKER}\n\n## 🤖 AI PR Review\n\n${summary.trim()}\n`;
}

export function formatCodeSpan(text: string): string {
  if (!text.includes('`')) {
    return `\`${text}\``;
  }
  const matches = text.match(/`+/g) ?? [];
  let maxLen = 0;
  for (const m of matches) {
    if (m.length > maxLen) {
      maxLen = m.length;
    }
  }
  const delimiter = '`'.repeat(maxLen + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

export const MAX_UNREVIEWED_DISPLAY = 50;

export function renderSkipBody(params: { unreviewed: string[] }): string {
  if (params.unreviewed.length > 0) {
    const total = params.unreviewed.length;
    const displayed = params.unreviewed.slice(0, MAX_UNREVIEWED_DISPLAY);
    const lines = [
      `**Review skipped:** ${total} changed file(s) not reviewed (outside reviewer scope):`,
      ...displayed.map((f) => `- ${formatCodeSpan(f)}`),
    ];
    if (total > MAX_UNREVIEWED_DISPLAY) {
      lines.push(`- … and ${total - MAX_UNREVIEWED_DISPLAY} more file(s)`);
    }
    return lines.join('\n');
  }
  return '**Review skipped:** No reviewable code changed in this pull request (all changed files are documentation or ignored assets).';
}

export function isSkipReview(body: string): boolean {
  const stripped = body.trimStart();
  if (!stripped.startsWith(MARKER)) {
    return false;
  }
  const content = stripped.slice(MARKER.length).trimStart();
  if (!content.startsWith('## 🤖 AI PR Review')) {
    return false;
  }
  const rest = content.slice('## 🤖 AI PR Review'.length).trimStart();
  return rest.startsWith('**Review skipped:**');
}

export interface GithubDeps {
  repo: string;
  prNumber: number;
  token: string;
  fetchFn?: typeof fetch;
}

interface ReviewRow {
  id: number;
  body?: string;
  user?: { type?: string };
}

interface IssueCommentRow {
  id: number;
  body?: string;
  user?: { type?: string };
}

// Surfaces the GitHub response status AND body so a failed post fails loudly with a
// clear, actionable reason (mirrors the OpenAI non-ok path) rather than a bare code.
async function githubError(action: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  return new Error(`GitHub ${action} HTTP ${res.status}: ${text.slice(0, 300)}`);
}

export interface ExistingReview {
  id: number;
  body: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'detent-pr-review',
    'Content-Type': 'application/json',
  };
}

/**
 * The bot's own marker review, if it has one.
 *
 * Read before the review runs, not only when posting: its body carries the
 * state block that decides whether this run is full, incremental or a free
 * republish. The result is handed to `upsertReview` so the list call is paid
 * for once.
 *
 * The marker review is created on the first run, so it is among the earliest
 * reviews and stays on the first page; per_page=100 finds it without paging.
 */
export async function findExistingReview(deps: GithubDeps): Promise<ExistingReview | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}/reviews`;
  const res = await fetchFn(`${base}?per_page=100`, { headers: githubHeaders(deps.token) });
  if (!res.ok) throw await githubError('list reviews', res);
  const reviews = (await res.json()) as ReviewRow[];
  const existing = reviews.find((r) => r.user?.type === 'Bot' && (r.body ?? '').includes(MARKER));
  return existing ? { id: existing.id, body: existing.body ?? '' } : null;
}

export async function upsertReview(
  deps: GithubDeps,
  body: string,
  existing?: ExistingReview | null,
): Promise<'created' | 'updated'> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}/reviews`;
  const headers = githubHeaders(deps.token);
  const target = existing === undefined ? await findExistingReview(deps) : existing;

  if (target) {
    const res = await fetchFn(`${base}/${target.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw await githubError('update review', res);
    return 'updated';
  }

  const res = await fetchFn(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body, event: 'COMMENT' }),
  });
  if (!res.ok) throw await githubError('create review', res);
  return 'created';
}

export const FAILURE_MARKER = '<!-- ai-pr-review-failure -->';
const FAILURE_COMMENT_LOOKUP_TIMEOUT_MS = 2_000;
const FAILURE_COMMENT_WRITE_TIMEOUT_MS = 8_000;

function failureCommentBody(message: string, headSha: string): string {
  const detail = message.trim().slice(0, 1_000).replace(/\r?\n/g, '\n> ');
  return [
    FAILURE_MARKER,
    '',
    '## ⚠️ AI PR Review failed',
    '',
    `The AI review did not complete for commit \`${headSha}\`.`,
    'The failing check remains authoritative. No new AI review was published for this run.',
    '',
    `> ${detail}`,
  ].join('\n');
}

export async function postFailureComment(
  deps: GithubDeps,
  message: string,
  headSha: string,
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `https://api.github.com/repos/${deps.repo}/issues/${deps.prNumber}/comments`;
  const headers = githubHeaders(deps.token);
  const lookupSignal = AbortSignal.timeout(FAILURE_COMMENT_LOOKUP_TIMEOUT_MS);
  const body = failureCommentBody(message, headSha);
  let pageUrl: string | null = `${url}?per_page=100`;
  let existing: IssueCommentRow | undefined;
  while (pageUrl) {
    try {
      const list: Response = await fetchFn(pageUrl, { headers, signal: lookupSignal });
      if (!list.ok) break;
      const comments = (await list.json()) as IssueCommentRow[];
      existing = comments.find(
        (comment) => comment.user?.type === 'Bot' && (comment.body ?? '').includes(FAILURE_MARKER),
      );
      if (existing) break;
      pageUrl = list.headers?.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    } catch {
      break;
    }
  }
  if (existing?.body === body) return;

  const updateUrl = `https://api.github.com/repos/${deps.repo}/issues/comments/${existing?.id}`;
  const res = await fetchFn(existing ? updateUrl : url, {
    method: existing ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(FAILURE_COMMENT_WRITE_TIMEOUT_MS),
  });
  if (!res.ok) throw await githubError(existing ? 'update failure comment' : 'create failure comment', res);
}

/**
 * Reads a changed file for review context, or null if it cannot be reviewed.
 *
 * Uses `lstat` and refuses anything that is not a regular file, so a symlink is
 * reported as unreadable instead of being followed. `filterReviewableFiles`
 * matches on pathname only, so without this a PR could add an in-scope `.ts`
 * symlink pointing at `/etc/passwd` or `.git/config` and have the target's
 * contents shipped to the model as "the changed file". We want the blob the PR
 * actually adds, never what it points at.
 */
export function readReviewableFile(path: string, root = '.'): string | null {
  try {
    const full = resolve(root, path);
    if (!lstatSync(full).isFile()) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Everything `runReview` touches outside itself. Injected so the whole
 * orchestration — including the incremental path, which otherwise needs a git
 * fixture with real ancestry — is testable without a network or a repository.
 */
export interface ReviewDeps {
  headSha: string;
  hasCommit: (sha: string) => boolean;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  listChangedFiles: (diffSpec: string) => string[];
  getDiff: (diffSpec: string, files: string[]) => string;
  readFile: (path: string) => string | null;
  log: (message: string) => void;
  openaiFetch?: typeof fetch;
  githubFetch?: typeof fetch;
}

function toVerifyRequest(id: string, f: GatedFinding | StoredFinding): VerifyRequest {
  return {
    id,
    file: f.file,
    matchedLine: f.matchedLine,
    matchedEndLine: f.matchedEndLine,
    quote: f.quote,
    claim: f.claim,
    why_it_breaks: f.why_it_breaks,
  };
}

async function runReviewOnce(pr: PrContext, run: RunSettings, deps: ReviewDeps): Promise<void> {
  const { patterns } = run.settings;
  const gh: GithubDeps = {
    repo: pr.repo,
    prNumber: pr.prNumber,
    token: pr.githubToken,
    fetchFn: deps.githubFetch,
  };

  const existing = await findExistingReview(gh);
  const state = parseState(existing?.body);

  const decision = decideMode({
    state,
    headSha: deps.headSha,
    baseRef: pr.baseRef,
    scope: run.settings.scope,
    hasCommit: deps.hasCommit,
    isAncestor: deps.isAncestor,
  });
  deps.log(`::notice::AI review mode: ${decision.mode} — ${decision.reason}`);

  // Nothing new to say and nothing new to charge for: put back exactly what is
  // already there, so the review (and its state) survives a workflow re-run.
  if (decision.mode === 'republish' && existing) {
    await upsertReview(gh, existing.body, existing);
    deps.log(`AI review republished unchanged on PR #${pr.prNumber} (0 API calls).`);
    return;
  }

  const sinceDiffSpec = deps.listChangedFiles(decision.diffSpec);
  let changedFiles = sinceDiffSpec;
  const prFiles =
    decision.diffSpec === decision.prSpec
      ? sinceDiffSpec
      : deps.listChangedFiles(decision.prSpec);
  if (decision.mode === 'incremental') {
    // A merge from the base keeps the stored head an ancestor, so stored..HEAD also
    // carries what the base gained; review only what this PR itself changes (warsaw-beer-bot#742).
    const { inScope, mergedIn } = incrementalScope(sinceDiffSpec, prFiles);
    if (mergedIn.length > 0) {
      deps.log(
        `::notice::AI review: ${mergedIn.length} file(s) changed since the last review are not in this PR's own diff (merged in from the base, or reverted to it) — left out of scope.`,
      );
    }
    changedFiles = inScope;
  }
  const reviewable = filterReviewableFiles(changedFiles, patterns);
  const { unreviewed } = partitionPrFiles(prFiles, patterns);

  // A first review with nothing in scope has nothing to publish. An incremental
  // one still does — the previous run's findings are open until proven closed.
  if (reviewable.length === 0 && !state) {
    if (existing && existing.body && !isSkipReview(existing.body)) {
      deps.log(
        '::notice::AI review skipped: no changed files in reviewer scope; retaining existing review.',
      );
      return;
    }
    const skipBody = wrapBody(renderSkipBody({ unreviewed }));
    await upsertReview(gh, skipBody, existing);
    deps.log('::notice::AI review skipped: no changed files are in the reviewer scope.');
    return;
  }

  const openaiDeps = {
    endpoint: run.provider.endpoint,
    apiKey: run.apiKey,
    providerName: run.provider.name,
    extraBody: run.provider.extraBody,
    fetchFn: deps.openaiFetch,
  };

  // Deliberately runs in `full` mode too, not only incremental: the mode decides
  // what this run re-reads, never what it forgets. A published finding is retired
  // by evidence — its file gone, or a re-check refuting it — and after a
  // force-push the quote it was published against no longer anchors, so it lands
  // in `recheck` and is adjudicated rather than carried. Dropping the state on a
  // force-push would instead delete open findings the maintainer is mid-fix on.
  const { carried, recheck, closed: obsolete } = reconcileFindings({
    stored: state?.findings ?? [],
    fileContent: deps.readFile,
  });

  let findUsage = EMPTY_USAGE;
  let raisedCount = 0;
  let fresh: GatedFinding[] = [];

  if (reviewable.length > 0) {
    const diff = deps.getDiff(decision.diffSpec, reviewable);
    const { text: context, diffOnly } = buildReviewContext({
      diff,
      reviewable,
      readFile: contextReader(deps.readFile, patterns),
    });
    if (diffOnly.length > 0) {
      deps.log(`::notice::Context budget: ${diffOnly.length} file(s) sent as diff only.`);
    }

    const found = await runFind(
      { ...openaiDeps, model: run.findModel },
      {
        instructions: run.settings.findPrompt,
        context,
        prTitle: pr.prTitle,
        prBody: pr.prBody,
      },
    );
    findUsage = found.usage;
    raisedCount = found.findings.length;

    const gateResult = applyGate({
      findings: found.findings,
      reviewable,
      changed: changedLineRanges(diff),
      fileContent: deps.readFile,
      // Carried findings are already published; without this seed an
      // incremental pass over the same file would print each of them twice.
      knownKeys: carried.map((f) => findingKey(f.file, f.quote, f.claim)),
    });
    fresh = gateResult.kept;
    for (const d of gateResult.dropped) {
      deps.log(`::notice::gate dropped [${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
    }
  } else {
    deps.log('::notice::AI review: this push changed no reviewable file; find pass skipped.');
  }

  const freshById = new Map(fresh.map((f, i) => [`f${i}`, f]));
  const recheckById = new Map(recheck.map((f, i) => [`r${i}`, f]));
  const requests = [
    ...fresh.map((f, i) => toVerifyRequest(`f${i}`, f)),
    ...recheck.map((f, i) => toVerifyRequest(`r${i}`, f)),
  ];

  const verified =
    requests.length === 0
      ? { results: [], usage: EMPTY_USAGE }
      : await verifyAll(
          { ...openaiDeps, model: run.verifyModel },
          {
            instructions: run.settings.verifyPrompt,
            requests,
            fileContent: deps.readFile,
          },
        );

  const open: OpenFinding[] = carried.map((finding) => ({
    finding,
    note: 'carried from an earlier push',
  }));
  const closed: ClosedFinding[] = [...obsolete];
  let confirmedCount = 0;

  for (const r of verified.results) {
    const freshFinding = freshById.get(r.id);
    if (freshFinding) {
      // Fresh finding: fail closed. Never publish a claim nobody checked.
      if (r.verdict === 'confirmed') {
        open.push({ finding: toStored(freshFinding, r.evidence) });
        confirmedCount += 1;
      } else {
        deps.log(`::notice::verify withheld [${r.verdict}] ${freshFinding.file}: ${r.evidence}`);
      }
      continue;
    }

    // Re-check of an already published finding: fail OPEN, deliberately. It was
    // published on evidence, and dropping it on a transient API error would
    // lose information the maintainer is acting on.
    const old = recheckById.get(r.id)!;
    if (r.verdict === 'confirmed') {
      open.push({ finding: { ...old, evidence: r.evidence }, note: 'the fix did not close this' });
    } else if (r.verdict === 'error') {
      open.push({ finding: old, note: `unverified this run (${r.evidence})` });
    } else {
      closed.push({ finding: old, reason: 'fixed' });
    }
  }

  const runUsage = addUsage(findUsage, verified.usage);
  const findUsd = costUsd(run.findModel, findUsage);
  const verifyUsd = costUsd(run.verifyModel, verified.usage);
  const runUsd = findUsd === null || verifyUsd === null ? null : findUsd + verifyUsd;
  const previousSpend = state?.spend ?? { usd: 0, runs: 0, unpriced: 0 };
  const spend = {
    usd: previousSpend.usd + (runUsd ?? 0),
    runs: previousSpend.runs + 1,
    unpriced: previousSpend.unpriced + (runUsd === null ? 1 : 0),
  };
  const costLine = formatCostLine({
    find: findUsage,
    verify: verified.usage,
    runUsd,
    totalUsd: spend.usd,
    unpriced: spend.unpriced,
  });
  deps.log(`::notice::AI review cost: ${costLine}`);

  const body = renderBody({
    open,
    closed,
    counts: {
      raised: raisedCount,
      gated: fresh.length,
      verified: confirmedCount,
      carried: carried.length,
      closed: closed.length,
    },
    costLine,
    head: deps.headSha,
    spend,
    scope: run.settings.scope,
    unreviewedCount: unreviewed.length,
  });

  const how = await upsertReview(gh, wrapBody(body), existing);

  deps.log(
    `AI review ${how} on PR #${pr.prNumber} [${decision.mode}]: ` +
      `${raisedCount} raised → ${fresh.length} gated → ${confirmedCount} confirmed, ` +
      `${carried.length} carried, ${closed.length} closed ` +
      `(${reviewable.length} file(s) in scope, ${runUsage.calls} API call(s)).`,
  );
}

export async function runReview(pr: PrContext, run: RunSettings, deps: ReviewDeps): Promise<void> {
  try {
    await runReviewOnce(pr, run, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await postFailureComment(
        {
          repo: pr.repo,
          prNumber: pr.prNumber,
          token: pr.githubToken,
          fetchFn: deps.githubFetch,
        },
        message,
        deps.headSha,
      );
      deps.log(`::notice::AI review failure comment posted on PR #${pr.prNumber}.`);
    } catch (commentErr) {
      const commentMessage = commentErr instanceof Error ? commentErr.message : String(commentErr);
      deps.log(`::error::AI review failure comment could not be posted: ${commentMessage}`);
    }
    throw err;
  }
}
