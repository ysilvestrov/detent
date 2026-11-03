// Runs a batch of the big test: one child process per run, under the spend ceiling, into the shared records.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, nextAction, runKey, savedFindings, startedFinds } from './batches.mjs';
import { isScorable, parseRecords, scrubKeys, totalSpend } from './records.mjs';

const KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const BASE_ENV = ['PATH', 'HOME', 'GH_TOKEN'];
const FINDINGS_DIR = 'findings';
const MIN_CORPUS = 3;
const SOURCE_BUDGET = /^Context budget: \d+ file\(s\) sent as diff only(?:: (.+)|\.)$/m;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\//;
const EXIT = { usage: 2, ceiling: 3, leaked: 4, failed: 5 };

/** The arguments after `node cli.js` for one run. `paths` holds the record, the findings to write, the findings to verify. */
export function childArgs(run, paths) {
  const head = run.head === null ? [] : ['--head', run.head];
  const common = ['pr-review', '--replay', run.pr];
  const route = ['--provider', run.route, '--record', paths.record];
  if (run.mode === 'verify') return [...common, ...route, '--verify-from', paths.verifyFrom];
  if (run.mode === 'find') return [...common, ...head, ...route, '--find-only', '--save-findings', paths.findings];
  return [...common, ...head, ...route];
}

/** The environment of the child: three variables of the base, the key of the route, and the settings of the run. */
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

/** Every line of every shared record file, in file order. */
function readShared(recordsDir) {
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => parseRecords(readFileSync(join(recordsDir, name), 'utf8')));
}

const findingsName = (run, attempt) => `b${run.batch}-${run.label}-pr${run.pr}-d${run.draw}-a${attempt}-${run.mode}.json`;
const stageModel = (run, stage) => (stage === 'verify' ? run.verifyModel : run.findModel);

/**
 * Runs one child. Its record goes to a file of its own, is checked for keys, and only then joins the shared record,
 * a killed or failed run included, so its paid calls count.
 */
async function execute({ run, attempt, keys, base, repo, recordsDir, tmpDir, spawnRun, out, verifyFrom }) {
  const id = randomUUID();
  const record = join(tmpDir, `${id}.jsonl`);
  const findings = join(tmpDir, `${id}-findings.json`);
  const key = runKey(run);
  mkdirSync(tmpDir, { recursive: true });
  const child = await spawnRun(childArgs(run, { record, findings, verifyFrom }), childEnv(run, keys, base), repo);

  let leaked = false;
  const scrub = (text) => {
    const scrubbed = scrubKeys(text, keys);
    leaked ||= scrubbed.leaked;
    return scrubbed.text;
  };
  for (const text of [child.stdout, child.stderr]) {
    for (const line of scrub(text).split('\n')) if (line !== '') out(line);
  }

  const lines = existsSync(record) ? parseRecords(scrub(readFileSync(record, 'utf8'))) : [];
  const closing = lines.find((line) => line.type === 'run');
  const clean = child.code === 0 && closing !== undefined && isScorable(closing);
  let findingsFile = null;
  if (run.mode === 'find' && clean && existsSync(findings)) {
    findingsFile = `${FINDINGS_DIR}/${findingsName(run, attempt)}`;
    mkdirSync(join(recordsDir, FINDINGS_DIR), { recursive: true });
    writeFileSync(join(recordsDir, findingsFile), scrub(readFileSync(findings, 'utf8')));
  }

  mkdirSync(recordsDir, { recursive: true });
  const enriched = lines.map((line) => ({
    ...line,
    requestedModel: stageModel(run, line.type === 'call' ? line.stage : run.mode === 'verify' ? 'verify' : 'find'),
    key,
    mode: run.mode,
    attempt,
    findingsFile: line.type === 'run' ? findingsFile : null,
  }));
  appendFileSync(join(recordsDir, `batch-${run.batch}.jsonl`), enriched.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return { clean, leaked };
}

/**
 * Runs the planned runs in order, each only if it and one more like it fit under the ceiling.
 * `code`: 0 all done, 2 refused before spending, 3 stopped at the ceiling, 4 a key was found in a line, 5 a run failed.
 */
export async function runBatch({ runs, catalog, keys, ceilingUsd, recordsDir, tmpDir, spawnRun, out, repo, base = process.env }) {
  const spend = () => totalSpend(readShared(recordsDir), catalog).usd;
  const result = { code: 0, spentUsd: spend(), done: 0, failed: 0, left: 0, notApplicable: 0 };
  const pending = (from) => runs.slice(from).filter((run) => nextAction(run, readShared(recordsDir)).action === 'run').length;

  const missing = [...new Set(runs.filter((run) => nextAction(run, readShared(recordsDir)).action === 'run').map((run) => KEY_ENV[run.route]))]
    .filter((name) => !keys[name]);
  if (missing.length > 0) {
    out(`batch ${runs[0].batch} needs ${missing.join(', ')} in the keys file`);
    return { ...result, code: EXIT.usage, left: pending(0) };
  }

  for (const [i, run] of runs.entries()) {
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

    result.spentUsd = totalSpend(lines, catalog).usd;
    if (!admit({ spentUsd: result.spentUsd, estimateUsd: run.estimateUsd, ceilingUsd })) {
      out(`stop at the ceiling: spent ${result.spentUsd.toFixed(2)} of ${ceilingUsd}, ${pending(i)} run(s) left`);
      return { ...result, code: EXIT.ceiling, left: pending(i) };
    }

    out(`run ${runKey(run)} attempt ${action.attempt}`);
    const { clean, leaked } = await execute({ run, attempt: action.attempt, keys, base, repo, recordsDir, tmpDir, spawnRun, out, verifyFrom });
    result.spentUsd = spend();
    if (clean || run.expectFailure) result.done += 1;
    else result.failed += 1;
    if (leaked) {
      out('a key was found in the output of a run; it is scrubbed, the spend is kept, the batch stops');
      return { ...result, code: EXIT.leaked, left: pending(i + 1) };
    }
  }
  return { ...result, code: result.failed > 0 ? EXIT.failed : 0 };
}

/** What `--context-only` said about one PR: a reason it must be dropped, or null. */
function dropReason(run) {
  if (run.code !== 0) return `context check exited ${run.code}`;
  if (run.stdout.includes('no reviewable files')) return 'no reviewable files';
  const budget = SOURCE_BUDGET.exec(run.stdout);
  if (budget === null) return 'context check printed no budget line';
  const sources = (budget[1] ?? '').split(', ').filter((file) => file !== '' && !TEST_FILE.test(file));
  return sources.length === 0 ? null : `source file${sources.length === 1 ? '' : 's'} sent as diff only: ${sources.join(', ')}`;
}

/**
 * Decides before any spend which PRs the measurement keeps: a source file sent as a diff only drops its PR.
 * Code 2 when #418 drops or fewer than three corpus PRs remain.
 */
export async function runPreflight({ catalog, spawnRun, repo, base = process.env }) {
  const env = Object.fromEntries(BASE_ENV.filter((name) => base[name] !== undefined).map((name) => [name, base[name]]));
  const reasons = {};
  const check = async (pr) => {
    const head = catalog.prs[pr].head === null ? [] : ['--head', catalog.prs[pr].head];
    const reason = dropReason(await spawnRun(['pr-review', '--replay', pr, ...head, '--context-only'], env, repo));
    if (reason !== null) reasons[pr] = reason;
    return reason === null;
  };
  const keeps418 = await check('418');
  const corpus = [];
  for (const pr of catalog.corpus) if (await check(pr)) corpus.push(pr);
  const recall930 = await check('930');
  const code = keeps418 && corpus.length >= MIN_CORPUS ? 0 : EXIT.usage;
  return { code, preflight: { corpus, recall930, reasons } };
}
