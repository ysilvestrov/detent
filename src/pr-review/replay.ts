// `detent pr-review --replay <pr>`: the review pipeline against a merged or open PR, without posting anything.
//
// Reads file bodies from the PR's head commit via `git show`, so it never touches the working tree.
// It differs from the run in CI in two places, because the person running it owns the key and
// the machine (spec 2026-11-02-pr-review-design.md, «Команда»): the settings come from the working tree,
// not from the base branch, and AI_REVIEW_MODEL, AI_REVIEW_VERIFY_MODEL and --provider pick the candidates.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewContext } from './context.js';
import { runFind } from './find.js';
import { applyGate, changedLineRanges } from './gate.js';
import { NonRetryableError, type OpenAiDeps } from './openai.js';
import { PROVIDER_IDS, isProviderId, resolveModels, selectProvider, type Provider, type ProviderId } from './providers.js';
import { openRecord, type RecordWriter, type RunLine } from './record.js';
import { contextReader, filterReviewableFiles } from './review.js';
import { checkFindingsPath, readFindings, saveFindings, type SavedFindings } from './saved-findings.js';
import { ConfigError, loadSettings } from './settings.js';
import type { DroppedFinding, GatedFinding } from './types.js';
import { EMPTY_USAGE, costUsd, formatCostLine, type Usage } from './usage.js';
import { verifyAll } from './verify.js';

type Env = Readonly<Record<string, string | undefined>>;

/** What a command needs from its surroundings. `gh` is replaceable so the replay can be tested without GitHub. */
export interface ReplayIo {
  cwd: string;
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  fetchFn?: typeof fetch;
  gh?: (args: string[]) => string;
}

export const EXIT = { ok: 0, usage: 2, failed: 5 } as const;

function sh(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Make sure the PR's head commit is in this clone before anything reads it.
 *
 * A fresh checkout has never fetched `refs/pull/<n>/head`, so `git show
 * <head>:<path>` and `git merge-base` fail on an object that was simply never
 * downloaded — which reads like a broken replay rather than a missing fetch.
 */
export function ensureHeadCommit(params: {
  pr: string;
  head: string;
  hasCommit: (sha: string) => boolean;
  fetchHead: () => void;
  log: (message: string) => void;
}): void {
  const { pr, head, hasCommit, fetchHead, log } = params;
  const ref = `pull/${pr}/head`;
  if (hasCommit(head)) return;

  log(`head ${head} is not in this clone; fetching origin ${ref} (may take a moment)…`);
  try {
    fetchHead();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`git fetch origin ${ref} failed: ${detail}`);
  }

  if (!hasCommit(head)) {
    throw new Error(`git fetch origin ${ref} did not produce commit ${head}; fetch it manually and retry`);
  }
}

/**
 * Which commit the replay diffs against.
 *
 * Without an explicit base a replay always measures a *first* review, which is
 * no longer what CI usually runs. Passing the previously reviewed head lets a
 * real incremental run be measured offline — including its much smaller find
 * prompt — before betting money on a config change.
 */
export function resolveReplayBase(p: {
  explicit: string | undefined;
  baseRefName: string;
  head: string;
  mergeBase: (a: string, b: string) => string;
}): string {
  return p.explicit ?? p.mergeBase(`refs/remotes/origin/${p.baseRefName}`, p.head);
}

export interface ReplayArgs {
  pr: string;
  explicitBase?: string;
  headOverride?: string;
  provider?: ProviderId;
  /** File the run appends its `call` and `run` lines to. */
  record?: string;
  /** Print the context budget and stop: no key, no model call. */
  contextOnly?: boolean;
  /** Stop after the gate: find once and leave the findings in `saveFindings`. */
  findOnly?: boolean;
  saveFindings?: string;
  /** Skip the find: verify the findings a find-only run saved, at the head and base it recorded. */
  verifyFrom?: string;
}

/** The files that went to the model as a diff only, because their bodies did not fit. */
export function formatContextBudget(diffOnly: string[]): string {
  return diffOnly.length === 0
    ? 'Context budget: 0 file(s) sent as diff only.'
    : `Context budget: ${diffOnly.length} file(s) sent as diff only: ${diffOnly.join(', ')}`;
}

/**
 * Replay arguments: `<pr> [--head <sha>] [--base <sha>] [--provider <id>]`.
 *
 * `--head` exists for the recall probe. Replaying a PR at its MERGED head
 * measures nothing about what a config would have FOUND: the findings the live
 * review produced have been fixed by then, which is precisely why they are known
 * to be real. The head the live review saw is in its own state block
 * (`<!-- ai-pr-review-state {"head":…} -->`), or is the commit before the fix.
 * This trap has cost two investigations — warsaw-beer-bot#344 in 2026-07, warsaw-beer-bot#418 in 2026-09 —
 * which is why it is a flag now rather than a thing to remember.
 */
export function resolveReplayArgs(argv: readonly string[]): ReplayArgs {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flagsWithValue = ['--head', '--base', '--provider', '--record', '--save-findings', '--verify-from'];
  const needs: Record<string, string> = {
    '--provider': `one of ${PROVIDER_IDS.join('|')}`,
    '--record': 'a file path',
    '--save-findings': 'a file path',
    '--verify-from': 'a file path',
  };
  let contextOnly = false;
  let findOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (flagsWithValue.includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs ${needs[arg] ?? 'a commit sha'}`);
      values[arg] = value;
      i++;
      continue;
    }
    if (arg === '--context-only') {
      contextOnly = true;
      continue;
    }
    if (arg === '--find-only') {
      findOnly = true;
      continue;
    }
    // A mistyped `--head=abc` must not fall through and be taken for a positional argument.
    if (arg.startsWith('--')) throw new Error(`unrecognised option: ${arg}`);
    positional.push(arg);
  }

  const [pr, extra] = positional;
  if (pr === undefined) throw new Error('--replay needs a PR number');
  if (!/^\d+$/.test(pr)) throw new Error(`the PR number must be digits, got "${pr}"`);
  if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
  const provider = values['--provider'];
  if (provider !== undefined && !isProviderId(provider)) {
    throw new Error(`unknown provider "${provider}": one of ${PROVIDER_IDS.join('|')}`);
  }
  if (contextOnly && values['--record'] !== undefined) throw new Error('--context-only cannot be combined with --record');
  if (contextOnly && findOnly) throw new Error('--context-only cannot be combined with --find-only');
  for (const flag of ['--save-findings', '--verify-from']) {
    if (contextOnly && values[flag] !== undefined) throw new Error(`--context-only cannot be combined with ${flag}`);
  }
  if (values['--verify-from'] !== undefined && (findOnly || values['--head'] || values['--base'])) {
    throw new Error('--verify-from takes the head and the base from its file');
  }
  if (findOnly !== (values['--save-findings'] !== undefined)) throw new Error('--find-only needs --save-findings');
  return {
    pr,
    ...(values['--base'] ? { explicitBase: values['--base'] } : {}),
    ...(values['--head'] ? { headOverride: values['--head'] } : {}),
    ...(provider !== undefined ? { provider: provider as ProviderId } : {}),
    ...(values['--record'] !== undefined ? { record: values['--record'] } : {}),
    ...(contextOnly ? { contextOnly } : {}),
    ...(findOnly ? { findOnly } : {}),
    ...(values['--save-findings'] !== undefined ? { saveFindings: values['--save-findings'] } : {}),
    ...(values['--verify-from'] !== undefined ? { verifyFrom: values['--verify-from'] } : {}),
  };
}

// The project's files as they are in the working tree: a replay measures settings before they are merged.
function worktreeReader(cwd: string): (path: string) => string | null {
  return (path) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
}

const modelFromEnv = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/** The names in a comma-separated variable; none when it is unset or blank. */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The names in a pin variable. Null when it is unset or blank. */
function parsePin(raw: string | undefined): string[] | null {
  const names = splitList(raw);
  return names.length === 0 ? null : names;
}

/** Whether a request to this model carries the switch that turns cache writes off. */
function cacheWritesOff(p: { model: string; cacheOff: boolean; cacheOffModels: string | undefined }): boolean {
  return p.cacheOff && splitList(p.cacheOffModels).includes(p.model);
}

/**
 * The extra request fields one stage sends: the provider's own, the OpenRouter executor pin, and the
 * switch that turns cache writes off. The switch touches only models named in `cacheOffModels`, because
 * Azure answers `gpt-5.5` with a 400 on `prompt_cache_options` (spec 2026-11-03-pr-review-big-test-design.md, «Кеш»).
 */
export function stageExtraBody(p: {
  provider: Provider;
  model: string;
  only: string | undefined;
  cacheOff: boolean;
  cacheOffModels: string | undefined;
  reasoning?: string | undefined;
}): Record<string, unknown> | undefined {
  const only = parsePin(p.only);
  const cacheOff = cacheWritesOff(p);
  if (only === null && !cacheOff && p.reasoning === undefined) return p.provider.extraBody;
  const body: Record<string, unknown> = { ...p.provider.extraBody };
  if (only !== null) {
    body.provider = { ...(p.provider.extraBody?.provider as object | undefined), only, allow_fallbacks: false };
  }
  if (cacheOff) body.prompt_cache_options = { mode: 'explicit' };
  if (p.reasoning !== undefined) body.reasoning = { effort: p.reasoning };
  return body;
}

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

/**
 * The find stage's settings for the second try at the models cut by the limit, from `AI_REVIEW_FIND_MAX_TOKENS` and
 * `AI_REVIEW_FIND_REASONING`. Replay only: the review in CI has neither.
 */
export function parseFindTuning(env: Record<string, string | undefined>): { maxTokens?: number; reasoning?: string } | { error: string } {
  const tuning: { maxTokens?: number; reasoning?: string } = {};
  const maxTokens = env.AI_REVIEW_FIND_MAX_TOKENS;
  if (maxTokens !== undefined) {
    if (!/^[1-9]\d*$/.test(maxTokens)) return { error: 'AI_REVIEW_FIND_MAX_TOKENS must be a positive whole number' };
    tuning.maxTokens = Number(maxTokens);
  }
  const reasoning = env.AI_REVIEW_FIND_REASONING;
  if (reasoning !== undefined) {
    if (!REASONING_EFFORTS.includes(reasoning)) return { error: `AI_REVIEW_FIND_REASONING must be one of ${REASONING_EFFORTS.join(', ')}` };
    tuning.reasoning = reasoning;
  }
  return tuning;
}

type RecordMeta = Pick<RunLine, 'batch' | 'label' | 'draw'>;

/** `AI_REVIEW_RECORD_META` is a JSON object; a field it leaves out is null. Null when it is anything else. */
function parseRecordMeta(raw: string | undefined): RecordMeta | null {
  if (raw === undefined) return { batch: null, label: null, draw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { batch = null, label = null, draw = null } = parsed as Record<string, unknown>;
  const numberOrNull = (v: unknown): number | null | undefined => (v === null || typeof v === 'number' ? v : undefined);
  const labelOrNull = typeof label === 'string' || label === null ? label : undefined;
  const [b, d] = [numberOrNull(batch), numberOrNull(draw)];
  return b === undefined || d === undefined || labelOrNull === undefined ? null : { batch: b, label: labelOrNull, draw: d };
}

/** Runs the replay and returns the exit code. Throws only on a failed run (the caller maps that to 5). */
export async function runReplay(args: ReplayArgs, io: ReplayIo): Promise<number> {
  const usage = (message: string): number => {
    io.err(`pr-review: ${message}`);
    return EXIT.usage;
  };

  let settings;
  try {
    settings = loadSettings(worktreeReader(io.cwd));
  } catch (error) {
    if (error instanceof ConfigError) return usage(error.message);
    throw error;
  }

  // The file comes first, before a provider is looked at: a file that is not this PR's, or not for these
  // prompts, must not cost a key lookup, let alone a call.
  let saved: SavedFindings | null = null;
  if (args.verifyFrom !== undefined) {
    try {
      saved = readFindings(args.verifyFrom);
    } catch (error) {
      return usage(error instanceof Error ? error.message : String(error));
    }
    if (saved.pr !== args.pr) return usage(`${args.verifyFrom} holds the findings of PR #${saved.pr}, not PR #${args.pr}`);
    if (saved.scope !== settings.scope) {
      return usage(`${args.verifyFrom} was found under other prompts or settings than the ones in this working tree`);
    }
  }

  // The stages this run calls a model for.
  const runsFind = args.verifyFrom === undefined && !args.contextOnly;
  const runsVerify = !args.findOnly && !args.contextOnly;
  const pins = {
    find: runsFind ? parsePin(io.env.AI_REVIEW_OPENROUTER_ONLY) : null,
    verify: runsVerify ? parsePin(io.env.AI_REVIEW_VERIFY_OPENROUTER_ONLY) : null,
  };
  const parsedTuning = parseFindTuning(io.env);
  if ('error' in parsedTuning) return usage(parsedTuning.error);
  const findTuning = parsedTuning;
  // A setting for a find this run does not make would be silently ignored, and the run would not be what was asked for.
  if (!runsFind && (findTuning.maxTokens !== undefined || findTuning.reasoning !== undefined)) {
    return usage('AI_REVIEW_FIND_MAX_TOKENS and AI_REVIEW_FIND_REASONING need a run that finds');
  }

  // `--context-only` never calls a model, so it needs neither a provider nor a key.
  // `verifyModel` is null when the run stops before the verify stage.
  let chosen: { provider: Provider; apiKey: string; findModel: string; verifyModel: string | null } | null = null;
  if (!args.contextOnly) {
    const selection = selectProvider(args.provider ?? settings.configured.provider, io.env);
    if (selection.kind === 'ambiguous') {
      return usage(`more than one provider key is set (${selection.keys.join(', ')}): pass --provider`);
    }
    if (selection.kind === 'no-key') return usage(`${selection.wanted} is not set`);
    // A half run needs one model, and the provider may have no default for the other, so the model it
    // does not use is filled in with a stand-in that is dropped below and never reaches a call, a record or the output.
    const findCandidate = saved?.findModel ?? modelFromEnv(io.env, 'AI_REVIEW_MODEL') ?? settings.configured.findModel;
    const models = resolveModels(selection.provider, {
      findModel: findCandidate,
      verifyModel: args.findOnly
        ? (findCandidate ?? 'unused')
        : (modelFromEnv(io.env, 'AI_REVIEW_VERIFY_MODEL') ?? settings.configured.verifyModel),
    });
    if (!models.ok) return usage(models.error);
    chosen = { provider: selection.provider, apiKey: selection.apiKey, findModel: models.find, verifyModel: args.findOnly ? null : models.verify };
    // A pin is an OpenRouter request field; anywhere else it would be silently ignored, and the run would not be what was asked for.
    // A stage that does not run has no pin to check, and its pin is not on the run line.
    for (const [name, stage] of [['AI_REVIEW_OPENROUTER_ONLY', 'find'], ['AI_REVIEW_VERIFY_OPENROUTER_ONLY', 'verify']] as const) {
      if (pins[stage] !== null && selection.provider.id !== 'openrouter') {
        return usage(`${name} works only with the openrouter provider, not ${selection.provider.id}`);
      }
    }
    if (findTuning.reasoning !== undefined && selection.provider.id !== 'openrouter') {
      return usage(`AI_REVIEW_FIND_REASONING works only with the openrouter provider, not ${selection.provider.id}`);
    }
  }
  const cacheOff = io.env.AI_REVIEW_CACHE === 'off';

  // These checks come before the first call: a file that cannot be written must not be found out after the money is spent.
  if (args.saveFindings !== undefined) {
    try {
      checkFindingsPath(args.saveFindings);
    } catch (error) {
      return usage(`cannot open the findings file ${args.saveFindings}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const runId = randomUUID();
  let rec: RecordWriter | null = null;
  let recordMeta: RecordMeta = { batch: null, label: null, draw: null };
  if (args.record !== undefined) {
    const parsed = parseRecordMeta(io.env.AI_REVIEW_RECORD_META);
    if (parsed === null) return usage('AI_REVIEW_RECORD_META must be a JSON object {batch, label, draw}');
    recordMeta = parsed;
    try {
      rec = openRecord(args.record, runId);
    } catch (error) {
      return usage(`cannot open the record file ${args.record}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const startedAt = new Date().toISOString();
  /** Set when the run ended 0 but not whole; it goes on the `run` line. */
  let runError: string | null = null;
  // What the `run` line reports. Filled in as the run learns it, so a failure still leaves what was known.
  const state: Pick<RunLine, 'head' | 'base' | 'diffOnly' | 'raised' | 'gated' | 'dropped' | 'results'> = {
    head: null,
    base: null,
    diffOnly: [],
    raised: 0,
    gated: 0,
    dropped: [],
    results: [],
  };
  const runLine = (exit: number, error: string | null): Omit<RunLine, 'type' | 'runId'> => ({
    ...recordMeta,
    provider: chosen?.provider.id ?? null,
    findModel: chosen?.findModel ?? null,
    verifyModel: chosen?.verifyModel ?? null,
    only: pins,
    // 'off' only when a stage that ran sent the switch, so a run the list did not touch is not labelled as one that was.
    cacheMode: [runsFind ? chosen?.findModel : undefined, runsVerify ? chosen?.verifyModel : undefined].some(
      (model) => model != null && cacheWritesOff({ model, cacheOff, cacheOffModels: io.env.AI_REVIEW_CACHE_OFF_MODELS }),
    )
      ? 'off'
      : 'default',
    pr: args.pr,
    startedAt,
    ...state,
    exit,
    error,
  });

  const { pr, explicitBase, headOverride } = args;
  const git = (a: string[]): string => sh(io.cwd, 'git', a);
  const gh = io.gh ?? ((a: string[]): string => sh(io.cwd, 'gh', a));

  // The request one stage sends. One hook per stage, so a call line says which stage paid for it.
  const writer = rec;
  // `verifyAll` turns every failure into an `error` verdict and goes on to the next file, so a failed record
  // write would otherwise be followed by more paid calls whose lines are lost too. The first write error stops
  // the run's own requests and is rethrown once the stage returns.
  let writeError: unknown = null;
  const fetchOnce: typeof fetch = (input, init) => {
    if (writeError !== null) throw new NonRetryableError('not sent: an earlier call line could not be written');
    return (io.fetchFn ?? fetch)(input, init);
  };
  const stageDeps = (stage: 'find' | 'verify', model: string, only: string[] | null): OpenAiDeps => {
    // Present whenever a model is called: `--context-only` returns before any stage.
    const { provider, apiKey } = chosen!;
    return {
      endpoint: provider.endpoint,
      apiKey,
      providerName: provider.name,
      fetchFn: fetchOnce,
      ...(writer
        ? {
            onResponse: (info) => {
              try {
                writer.call(stage, info);
              } catch (error) {
                writeError ??= error;
                throw error;
              }
            },
          }
        : {}),
      model,
      extraBody: stageExtraBody({
        provider,
        model,
        only: only?.join(','),
        cacheOff,
        cacheOffModels: io.env.AI_REVIEW_CACHE_OFF_MODELS,
        reasoning: stage === 'find' ? findTuning.reasoning : undefined,
      }),
      ...(stage === 'find' && findTuning.maxTokens !== undefined ? { maxCompletionTokens: findTuning.maxTokens } : {}),
    };
  };

  // The verify stage and what a run prints, shared by a whole run and by `--verify-from`, so the two send the same request.
  const verifyAndPrint = async (p: {
    raised: number;
    kept: GatedFinding[];
    dropped: DroppedFinding[];
    readFile: (path: string) => string | null;
    findUsage: Usage;
  }): Promise<number> => {
    const { kept, dropped, readFile } = p;
    const { findModel } = chosen!;
    const verifyModel = chosen!.verifyModel!;
    const verified = await verifyAll(stageDeps('verify', verifyModel, pins.verify), {
      instructions: settings.verifyPrompt,
      requests: kept.map((f, i) => ({
        id: `f${i}`,
        file: f.file,
        matchedLine: f.matchedLine,
        matchedEndLine: f.matchedEndLine,
        quote: f.quote,
        claim: f.claim,
        why_it_breaks: f.why_it_breaks,
      })),
      fileContent: readFile,
    });
    if (writeError !== null) throw writeError;
    const byId = new Map(kept.map((f, i) => [`f${i}`, f]));
    state.results = verified.results.map((r) => {
      const f = byId.get(r.id)!;
      return {
        file: f.file,
        line: f.matchedLine,
        severity: f.severity,
        confidence: f.confidence,
        quote: f.quote,
        claim: f.claim,
        whyItBreaks: f.why_it_breaks,
        verdict: r.verdict,
        evidence: r.evidence,
      };
    });
    const confirmed = verified.results
      .filter((r) => r.verdict === 'confirmed')
      .map((r) => ({ finding: byId.get(r.id)!, evidence: r.evidence }));
    const rejected = verified.results
      .filter((r) => r.verdict !== 'confirmed')
      .map((r) => ({ finding: byId.get(r.id)!, verdict: r.verdict, evidence: r.evidence }));

    io.out(`\n=== PR #${pr} (${findModel} → ${verifyModel}) ===`);
    io.out(`raised ${p.raised} → gated ${kept.length} → verified ${confirmed.length}\n`);
    for (const d of dropped) io.out(`  [gate:${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
    for (const r of rejected) io.out(`  [verify:${r.verdict}] ${r.finding.file}: ${r.finding.claim}`);
    for (const c of confirmed) {
      io.out(`\n  PUBLISHED ${c.finding.severity} ${c.finding.file}:${c.finding.matchedLine}`);
      io.out(`    claim:    ${c.finding.claim}`);
      io.out(`    evidence: ${c.evidence}`);
    }

    const findUsd = costUsd(findModel, p.findUsage);
    const verifyUsd = costUsd(verifyModel, verified.usage);
    const runUsd = findUsd === null || verifyUsd === null ? null : findUsd + verifyUsd;
    io.out(`\n${formatCostLine({ find: p.findUsage, verify: verified.usage, runUsd, totalUsd: runUsd, unpriced: runUsd === null ? 1 : 0 })}`);

    // The exit code stays 0, as it always was; the run line says the verdicts are incomplete, so the harness does not score it.
    const failed = verified.results.filter((r) => r.verdict === 'error').length;
    if (failed > 0) {
      runError = `${failed} of ${verified.results.length} findings not verified`;
      io.err(runError);
    }
    return EXIT.ok;
  };

  const execute = async (): Promise<number> => {
    // `baseRefOid` is not exposed by every gh version, so the base is resolved from its branch name:
    // for a squash-merged PR the head commit is not an ancestor of the base branch, so the merge-base is still the fork point.
    // `--verify-from` has its head and base in the file and never asks GitHub.
    const meta =
      saved === null
        ? (JSON.parse(gh(['pr', 'view', pr, '--json', 'title,body,headRefOid,baseRefName'])) as {
            title: string;
            body: string | null;
            headRefOid: string;
            baseRefName: string;
          })
        : null;

    // A head named by the person, or by the file, is fetched by name when the pull ref cannot deliver it.
    const namedHead = saved?.head ?? headOverride;
    const head = namedHead ?? meta!.headRefOid;
    state.head = head;
    const hasCommit = (sha: string): boolean => {
      try {
        git(['cat-file', '-e', `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    ensureHeadCommit({
      pr,
      head,
      hasCommit,
      fetchHead: () => {
        // `refs/pull/<n>/head` tracks the PR's CURRENT head, so it cannot deliver a commit a later
        // force-push made unreachable — and that is exactly the commit a recall probe asks for. GitHub
        // still serves such a commit by sha, so ask for it by name. Only for an explicit `--head`.
        try {
          git(['fetch', 'origin', `pull/${pr}/head`]);
        } catch (err) {
          // With a named head the pull ref is a best-effort first try; throwing here would bury the by-sha attempt.
          if (!namedHead) throw err;
        }
        if (namedHead && !hasCommit(head)) git(['fetch', 'origin', head]);
      },
      log: (message) => io.err(message),
    });

    const mergeBase =
      saved?.base ??
      resolveReplayBase({
        explicit: explicitBase,
        baseRefName: meta!.baseRefName,
        head,
        mergeBase: (a, b) => git(['merge-base', a, b]).trim(),
      });
    state.base = mergeBase;
    io.err(`replaying ${mergeBase}..${head}`);

    const readFile = (path: string): string | null => {
      try {
        return git(['show', `${head}:${path}`]);
      } catch {
        return null;
      }
    };

    // The find is already done: its findings and the gate's verdict on them are in the file.
    if (saved !== null) {
      state.raised = saved.raised.length;
      state.gated = saved.kept.length;
      state.dropped = saved.dropped.map((d) => ({ file: d.finding.file, reason: d.reason, claim: d.finding.claim }));
      return verifyAndPrint({ raised: saved.raised.length, kept: saved.kept, dropped: saved.dropped, readFile, findUsage: EMPTY_USAGE });
    }

    const changed = git(['-c', 'core.quotePath=off', 'diff', '--name-only', `${mergeBase}..${head}`])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const reviewable = filterReviewableFiles(changed, settings.patterns);
    if (reviewable.length === 0) {
      // A find-only run still leaves a file `--verify-from` accepts: nothing was found, and nothing is left to verify.
      if (args.findOnly) {
        saveFindings(args.saveFindings!, { v: 1, pr, head, base: mergeBase, findModel: chosen!.findModel, scope: settings.scope, raised: [], kept: [], dropped: [] });
      }
      io.out('no reviewable files');
      return EXIT.ok;
    }

    const diff = git(['-c', 'core.quotePath=off', 'diff', `${mergeBase}..${head}`, '--', ...reviewable]);
    const { text: context, diffOnly } = buildReviewContext({
      diff,
      reviewable,
      readFile: contextReader(readFile, settings.patterns),
    });
    state.diffOnly = diffOnly;
    io.out(formatContextBudget(diffOnly));
    if (args.contextOnly) return EXIT.ok;

    const { findModel } = chosen!;
    const found = await runFind(stageDeps('find', findModel, pins.find), {
      instructions: settings.findPrompt,
      context,
      prTitle: meta!.title,
      prBody: meta!.body ?? '',
    });
    const raised = found.findings;
    state.raised = raised.length;

    const { kept, dropped } = applyGate({
      findings: raised,
      reviewable,
      changed: changedLineRanges(diff),
      fileContent: readFile,
    });
    state.gated = kept.length;
    state.dropped = dropped.map((d) => ({ file: d.finding.file, reason: d.reason, claim: d.finding.claim }));

    if (args.findOnly) {
      saveFindings(args.saveFindings!, { v: 1, pr, head, base: mergeBase, findModel, scope: settings.scope, raised, kept, dropped });
      io.out(`\n=== PR #${pr} (${findModel}, find only) ===`);
      io.out(`raised ${raised.length} → gated ${kept.length}`);
      for (const d of dropped) io.out(`  [gate:${d.reason}] ${d.finding.file}: ${d.finding.claim}`);
      const findUsd = costUsd(findModel, found.usage);
      io.out(`\n${formatCostLine({ find: found.usage, verify: EMPTY_USAGE, runUsd: findUsd, totalUsd: findUsd, unpriced: findUsd === null ? 1 : 0 })}`);
      return EXIT.ok;
    }

    return verifyAndPrint({ raised: raised.length, kept, dropped, readFile, findUsage: found.usage });
  };

  if (rec === null) return execute();
  let code: number;
  try {
    code = await execute();
  } catch (error) {
    // Only the error text is scrubbed: the model's own words in the record cannot hold a key it never saw.
    const message = error instanceof Error ? error.message : String(error);
    rec.run(runLine(EXIT.failed, chosen!.apiKey === '' ? message : message.replaceAll(chosen!.apiKey, '***')));
    throw error;
  }
  rec.run(runLine(code, runError));
  return code;
}
