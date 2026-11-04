// Runs a batch of the big test: one child process per run, under the spend ceiling, into the shared records.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, nextAction, runKey, savedFindings, startedFinds } from './batches.mjs';
import { isScorable, parseRecords, scrubKeys, totalSpend } from './records.mjs';

const KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const BASE_ENV = ['PATH', 'HOME', 'GH_TOKEN', ...PROXY_ENV, 'NODE_USE_ENV_PROXY'];
const FINDINGS_DIR = 'findings';
const META_SUFFIX = '.meta.json';
const MIN_CORPUS = 3;
const STDERR_TAIL = 3;
const SOURCE_BUDGET = /^Context budget: \d+ file\(s\) sent as diff only(?:: (.+)|\.)$/m;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\//;
const EXIT = { usage: 2, ceiling: 3, leaked: 4, failed: 5 };
const ORPHAN = 'the funnel stopped before this run was absorbed';

/** The arguments after `node cli.js` for one run. `paths` holds the record, the findings to write, the findings to verify. */
export function childArgs(run, paths) {
  const head = run.head === null ? [] : ['--head', run.head];
  const common = ['pr-review', '--replay', run.pr];
  const route = ['--provider', run.route, '--record', paths.record];
  if (run.mode === 'verify') return [...common, ...route, '--verify-from', paths.verifyFrom];
  if (run.mode === 'find') return [...common, ...head, ...route, '--find-only', '--save-findings', paths.findings];
  return [...common, ...head, ...route];
}

/**
 * The reason this process cannot reach the network, or null. Node's fetch ignores a proxy unless NODE_USE_ENV_PROXY=1
 * is set when node starts, and in the sandbox a proxy is the only way out.
 */
export function proxyRefusal(env) {
  const proxied = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((name) => env[name] !== undefined);
  if (!proxied || env.NODE_USE_ENV_PROXY === '1') return null;
  return 'a proxy is set, and fetch ignores it without NODE_USE_ENV_PROXY=1: start with NODE_USE_ENV_PROXY=1 node scripts/eval/funnel.mjs ...';
}

/** The environment of the child: the base variables, the key of the route, and the settings of the run. */
export function childEnv(run, keys, base) {
  const env = {};
  for (const name of BASE_ENV) if (base[name] !== undefined) env[name] = base[name];
  env[KEY_ENV[run.route]] = keys[KEY_ENV[run.route]];
  const finds = run.mode !== 'verify';
  const verifies = run.mode !== 'find';
  if (finds) env.AI_REVIEW_MODEL = run.findModel;
  if (verifies) env.AI_REVIEW_VERIFY_MODEL = run.verifyModel;
  if (finds && run.only.find !== null) env.AI_REVIEW_OPENROUTER_ONLY = run.only.find.join(',');
  if (verifies && run.only.verify !== null) env.AI_REVIEW_VERIFY_OPENROUTER_ONLY = run.only.verify.join(',');
  if (run.cacheOffModels !== null) {
    env.AI_REVIEW_CACHE = 'off';
    env.AI_REVIEW_CACHE_OFF_MODELS = run.cacheOffModels.join(',');
  }
  env.AI_REVIEW_RECORD_META = JSON.stringify({ batch: run.batch, label: run.label, draw: run.draw });
  return env;
}

/** Every line of every shared record file, in file order. A broken line names its file. */
function readShared(recordsDir) {
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => {
      try {
        return parseRecords(readFileSync(join(recordsDir, name), 'utf8'));
      } catch (error) {
        throw new Error(`${name}: ${error.message}`);
      }
    });
}

/** The first shared file that ends in a line which is not JSON, or null. Such a tear is for the owner to cut away. */
function tornShared(recordsDir) {
  if (!existsSync(recordsDir)) return null;
  for (const name of readdirSync(recordsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const rows = readFileSync(join(recordsDir, name), 'utf8').split('\n').filter((raw) => raw.trim() !== '');
    if (rows.length === 0) continue;
    try {
      JSON.parse(rows.at(-1));
    } catch {
      return name;
    }
  }
  return null;
}

/** Appends whole lines; if the file ends in a torn line, the new ones start on a line of their own. */
function appendLines(file, lines) {
  if (lines.length === 0) return;
  mkdirSync(join(file, '..'), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, lead + lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

/** Only the provider keys are secrets; another value in the keys file may be a plain number. */
function scrubber(keys) {
  const secrets = Object.fromEntries(Object.values(KEY_ENV).filter((name) => keys[name]).map((name) => [name, keys[name]]));
  let leaked = false;
  return {
    scrub(text) {
      const scrubbed = scrubKeys(text, secrets);
      leaked ||= scrubbed.leaked;
      return scrubbed.text;
    },
    leaked: () => leaked,
  };
}

/** Parseable lines of a temp record. Only a torn last line is excused; a broken line before it marks the run. */
function salvage(text) {
  const rows = text.split('\n').filter((raw) => raw.trim() !== '');
  const lines = [];
  let broken = false;
  rows.forEach((raw, i) => {
    try {
      const line = JSON.parse(raw);
      if (typeof line === 'object' && line !== null && !Array.isArray(line)) lines.push(line);
      else broken = true;
    } catch {
      if (i < rows.length - 1) broken = true;
    }
  });
  return { lines, broken };
}

const findingsName = (run, attempt) => `b${run.batch}-${run.label}-pr${run.pr}-d${run.draw}-a${attempt}-${run.mode}.json`;
const tail = (text) => text.trim().split('\n').filter(Boolean).slice(-STDERR_TAIL).join(' | ');

/**
 * Moves the lines of one temp record into the shared record, scrubbed and enriched. The `call` lines go first, so a
 * failure after them cannot lose paid calls; the findings copy comes next, and the `run` line closes the run last.
 * A run the child did not close properly gets a failed `run` line of the funnel's own.
 * Every line carries `tempId`, so a crash before the `.absorbed` marker repeats nothing: the next absorb skips the `call`
 * lines as a group, and the `run` line on its own, when the shared record already has them.
 * `childCode` is null for an orphan, whose child's exit was never seen.
 */
function absorb({ meta, recordPath, findingsPath, childCode, recordsDir, scrub }) {
  const { lines, broken } = salvage(existsSync(recordPath) ? scrub(readFileSync(recordPath, 'utf8')) : '');
  const closing = lines.find((line) => line.type === 'run');
  const code = childCode ?? closing?.exit ?? null;
  let problem = null;
  if (broken) problem = 'the record had an unreadable line';
  else if (closing === undefined) problem = code === null ? ORPHAN : `the child ended with exit ${code} and wrote no run line`;
  else if (code !== closing.exit) problem = `the child exited ${code} after writing a run line with exit ${closing.exit}`;

  const enrich = (line, findingsFile) => ({
    ...line,
    tempId: meta.id,
    requestedModel: meta.models[line.type === 'call' ? line.stage : meta.mode === 'verify' ? 'verify' : 'find'],
    key: meta.key,
    mode: meta.mode,
    attempt: meta.attempt,
    expectFailure: meta.expectFailure,
    findingsFile,
  });
  const shared = join(recordsDir, `batch-${meta.batch}.jsonl`);
  const present = salvage(existsSync(shared) ? readFileSync(shared, 'utf8') : '').lines.filter((line) => line.tempId === meta.id);
  if (!present.some((line) => line.type !== 'run')) appendLines(shared, lines.filter((line) => line.type !== 'run').map((line) => enrich(line, null)));

  let clean = problem === null && isScorable(closing);
  let findingsFile = null;
  if (clean && meta.mode === 'find') {
    try {
      mkdirSync(join(recordsDir, FINDINGS_DIR), { recursive: true });
      writeFileSync(join(recordsDir, meta.findingsFile), scrub(readFileSync(findingsPath, 'utf8')));
      findingsFile = meta.findingsFile;
    } catch (error) {
      problem = `findings copy failed: ${error.message}`;
      clean = false;
    }
  }
  if (!present.some((line) => line.type === 'run') && (closing !== undefined || !meta.expectFailure)) {
    const base = closing ?? { type: 'run', runId: lines[0]?.runId ?? meta.id, batch: meta.batch, label: meta.label, provider: meta.route, pr: meta.pr, draw: meta.draw };
    const line = problem === null ? base : { ...base, exit: code ?? 1, error: problem === ORPHAN || closing === undefined || closing.error === null ? problem : closing.error };
    appendLines(shared, [enrich(line, findingsFile)]);
  }
  return { clean };
}

/** Absorbs every run whose temp record was never absorbed: the funnel died, or something threw, after the child paid. */
function adoptOrphans({ recordsDir, tmpDir, scrub, out }) {
  if (!existsSync(tmpDir)) return;
  for (const name of readdirSync(tmpDir).filter((n) => n.endsWith(META_SUFFIX)).sort()) {
    const id = name.slice(0, -META_SUFFIX.length);
    if (existsSync(join(tmpDir, `${id}.absorbed`))) continue;
    let meta;
    try {
      meta = { ...JSON.parse(readFileSync(join(tmpDir, name), 'utf8')), id };
    } catch {
      out(`skip ${name}: unreadable, so no child was started from it`);
      continue;
    }
    absorb({ meta, recordPath: join(tmpDir, `${id}.jsonl`), findingsPath: join(tmpDir, `${id}-findings.json`), childCode: null, recordsDir, scrub });
    writeFileSync(join(tmpDir, `${id}.absorbed`), '');
    out(`adopted the record of ${meta.key} left in ${tmpDir}`);
  }
}

/** Runs one child. Its record goes to a file of its own, is checked for keys, and only then joins the shared record. */
async function execute({ run, attempt, keys, base, repo, recordsDir, tmpDir, spawnRun, out, verifyFrom }) {
  const id = randomUUID();
  const recordPath = join(tmpDir, `${id}.jsonl`);
  const findingsPath = join(tmpDir, `${id}-findings.json`);
  const { scrub, leaked } = scrubber(keys);
  const meta = {
    id,
    key: runKey(run),
    mode: run.mode,
    attempt,
    batch: run.batch,
    label: run.label,
    pr: run.pr,
    draw: run.draw,
    route: run.route,
    models: { find: run.findModel, verify: run.verifyModel },
    expectFailure: run.expectFailure,
    findingsFile: `${FINDINGS_DIR}/${findingsName(run, attempt)}`,
  };
  mkdirSync(tmpDir, { recursive: true });
  // The sidecar says what the temp record means, so a run the funnel did not live to absorb can be absorbed later.
  writeFileSync(join(tmpDir, `${id}${META_SUFFIX}`), JSON.stringify(meta));

  const child = await spawnRun(childArgs(run, { record: recordPath, findings: findingsPath, verifyFrom }), childEnv(run, keys, base), repo);
  for (const text of [child.stdout, child.stderr]) {
    for (const line of scrub(text).split('\n')) if (line !== '') out(line);
  }
  const { clean } = absorb({ meta, recordPath, findingsPath, childCode: child.code, recordsDir, scrub });
  writeFileSync(join(tmpDir, `${id}.absorbed`), '');
  return { clean, leaked: leaked() };
}

/**
 * Runs the planned runs in order, each only if it and one more like it fit under the ceiling.
 * `code`: 0 all done, 2 refused before spending, 3 stopped at the ceiling, 4 a key was found in a line, 5 a run failed.
 */
export async function runBatch({ runs, catalog, keys, ceilingUsd, reserveUsd = 0, recordsDir, tmpDir, spawnRun, out, repo, base = process.env }) {
  const result = { code: 0, spentUsd: 0, done: 0, failed: 0, left: 0, notApplicable: 0 };
  let warnedUnpriced = 0;
  const spend = (lines) => {
    const { usd, unpriced } = totalSpend(lines, catalog);
    if (unpriced > 0 && unpriced !== warnedUnpriced) out(`warning: ${unpriced} call line(s) have no usage or no price; they count as 0 against the ceiling`);
    warnedUnpriced = unpriced;
    return usd;
  };
  const pending = (from) => runs.slice(from).filter((run) => nextAction(run, readShared(recordsDir)).action === 'run').length;

  const adoption = scrubber(keys);
  try {
    const torn = tornShared(recordsDir);
    if (torn !== null) throw new Error(`${torn}: the last line is torn; remove it by hand, then run the batch again`);
    adoptOrphans({ recordsDir, tmpDir, scrub: adoption.scrub, out });
    result.spentUsd = spend(readShared(recordsDir));
  } catch (error) {
    out(error.message);
    return { ...result, code: EXIT.usage, left: runs.length };
  }
  if (adoption.leaked()) {
    out('a key was found in an orphaned record; it is scrubbed, the spend is kept, the batch stops');
    return { ...result, code: EXIT.leaked, left: pending(0) };
  }

  const missing = [...new Set(runs.filter((run) => nextAction(run, readShared(recordsDir)).action === 'run').map((run) => KEY_ENV[run.route]))].filter(
    (name) => !keys[name],
  );
  if (missing.length > 0) {
    out(`batch ${runs[0].batch} needs ${missing.join(', ')} in the keys file`);
    return { ...result, code: EXIT.usage, left: pending(0) };
  }

  let at = 0;
  try {
    for (const [i, run] of runs.entries()) {
      at = i;
      const lines = readShared(recordsDir);
      const action = nextAction(run, lines);
      if (action.action === 'skip') {
        result.done += 1;
        continue;
      }

      let verifyFrom = null;
      if (run.from !== null) {
        const find = `${run.from.label}/${run.from.pr}/${run.from.draw}`;
        const file = savedFindings(lines).get(find);
        if (file === undefined && !startedFinds(lines).has(find)) {
          out(`skip ${runKey(run)}: the find of ${find} never ran`);
          result.notApplicable += 1;
          continue;
        }
        if (file === undefined) {
          out(`fail ${runKey(run)}: the find of ${find} left no findings`);
          result.failed += 1;
          continue;
        }
        verifyFrom = join(recordsDir, file);
      }

      result.spentUsd = spend(lines);
      if (!admit({ spentUsd: result.spentUsd, estimateUsd: run.estimateUsd, ceilingUsd: ceilingUsd - reserveUsd })) {
        const held = reserveUsd === 0 ? '' : `, ${reserveUsd} of it held back`;
        out(`stop at the ceiling: spent ${result.spentUsd.toFixed(2)} of ${ceilingUsd}${held}, ${pending(i)} run(s) left`);
        return { ...result, code: EXIT.ceiling, left: pending(i) };
      }

      out(`run ${runKey(run)} attempt ${action.attempt}`);
      let outcome;
      try {
        outcome = await execute({ run, attempt: action.attempt, keys, base, repo, recordsDir, tmpDir, spawnRun, out, verifyFrom });
      } catch (error) {
        // The child's temp record is still in tmpDir with its sidecar; the next invocation adopts it before it admits anything.
        out(`${runKey(run)}: ${error.message}; its record stays in ${tmpDir} and is adopted on the next invocation`);
        result.failed += 1;
        return { ...result, code: EXIT.failed, left: pending(i + 1) };
      }
      result.spentUsd = spend(readShared(recordsDir));
      if (outcome.clean || run.expectFailure) result.done += 1;
      else result.failed += 1;
      if (outcome.leaked) {
        out('a key was found in the output of a run; it is scrubbed, the spend is kept, the batch stops');
        return { ...result, code: EXIT.leaked, left: pending(i + 1) };
      }
    }
    return { ...result, code: result.failed > 0 ? EXIT.failed : 0 };
  } catch (error) {
    // Something unreadable after a child may have paid; its record is in tmpDir and the next invocation adopts it.
    out(error.message);
    result.failed += 1;
    return { ...result, code: EXIT.failed, left: runs.length - at - 1 };
  }
}

/** What `--context-only` said about one PR: `ok`, a `drop` (the spec's rule), or a `failed` check that says nothing. */
function classify(child, scrub) {
  if (child.code !== 0) {
    const stderr = tail(scrub(child.stderr));
    return { kind: 'failed', reason: `context check exited ${child.code}${stderr === '' ? '' : `: ${stderr}`}` };
  }
  if (child.stdout.includes('no reviewable files')) return { kind: 'drop', reason: 'no reviewable files' };
  const budget = SOURCE_BUDGET.exec(child.stdout);
  if (budget === null) return { kind: 'failed', reason: 'context check printed no budget line' };
  const sources = (budget[1] ?? '').split(', ').filter((file) => file !== '' && !TEST_FILE.test(file));
  if (sources.length === 0) return { kind: 'ok' };
  return { kind: 'drop', reason: `source file${sources.length === 1 ? '' : 's'} sent as diff only: ${sources.join(', ')}` };
}

/**
 * Decides before any spend which PRs the measurement keeps: a source file sent as a diff only drops its PR.
 * Code 5 when a check itself failed (nothing is decided then), else 2 when #418 drops or fewer than three corpus PRs remain.
 */
export async function runPreflight({ catalog, spawnRun, repo, base = process.env, keys = {} }) {
  const env = Object.fromEntries(BASE_ENV.filter((name) => base[name] !== undefined).map((name) => [name, base[name]]));
  const { scrub } = scrubber(keys);
  const reasons = {};
  const failures = {};
  const check = async (pr) => {
    const head = catalog.prs[pr].head === null ? [] : ['--head', catalog.prs[pr].head];
    const verdict = classify(await spawnRun(['pr-review', '--replay', pr, ...head, '--context-only'], env, repo), scrub);
    if (verdict.kind === 'drop') reasons[pr] = verdict.reason;
    if (verdict.kind === 'failed') failures[pr] = verdict.reason;
    return verdict.kind === 'ok';
  };
  const keeps418 = await check('418');
  const corpus = [];
  for (const pr of catalog.corpus) if (await check(pr)) corpus.push(pr);
  const recall930 = await check('930');
  const decided = keeps418 && corpus.length >= MIN_CORPUS ? 0 : EXIT.usage;
  const code = Object.keys(failures).length > 0 ? EXIT.failed : decided;
  return { code, preflight: { corpus, recall930, reasons }, failures };
}
