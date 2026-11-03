#!/usr/bin/env node
// The funnel of the big test: runs a batch of `detent pr-review --replay` against the spend ceiling.
// Run in WSL from the detent clone. Keys are read only from the --keys file, and a child gets only its route's key.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { planBatch } from './lib/batches.mjs';
import { loadCatalog } from './lib/catalog.mjs';
import { chooseExecutor } from './lib/executors.mjs';
import { parseKeys } from './lib/records.mjs';
import { runBatch, runPreflight } from './lib/runner.mjs';
import { checkLabels } from './lib/selection.mjs';

const USAGE = `Usage: node scripts/eval/funnel.mjs --keys <file> --batch <n> --ceiling <usd> [--labels a,b] [--verify-model <id> --verify-route <id>] [--judges m:route,...] [--repo <dir>] [--allow-dirty]
       node scripts/eval/funnel.mjs --preflight [--repo <dir>]
       node scripts/eval/funnel.mjs --endpoints [--labels a,b]
       node scripts/eval/funnel.mjs --note-spend <usd> --reason <text>`;

const here = dirname(fileURLToPath(import.meta.url));
const detent = join(here, '..', '..');
const cli = join(detent, 'dist', 'cli.js');
const candidatesFile = join(here, 'candidates.json');
const evalDir = join(detent, 'docs', 'eval', '2026-11');
const recordsDir = join(evalDir, 'records');
const tmpDir = join(detent, 'tmp', 'eval');
const preflightFile = join(evalDir, 'preflight.json');
/** The maker of a model, where its OpenRouter host is named otherwise than the model id. */
const VENDOR = { qwen: 'alibaba' };
const SCORED_BATCHES = [2, 3, 4, 5, 6];

const say = (line) => process.stdout.write(`${line}\n`);

/** Runs `node cli.js ...args` in `cwd` with exactly `env`; resolves with what it printed. */
function spawnRun(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const readCatalog = () => loadCatalog(readFileSync(candidatesFile, 'utf8'));

function readScores() {
  const scoresByBatch = {};
  for (const n of SCORED_BATCHES) {
    const file = join(evalDir, 'scores', `batch-${n}.json`);
    if (existsSync(file)) scoresByBatch[n] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return scoresByBatch;
}

function readPreflight() {
  return existsSync(preflightFile) ? JSON.parse(readFileSync(preflightFile, 'utf8')) : undefined;
}

/** Everything that can still refuse the batch before it spends; an Error here is exit 2. */
function prepareBatch(args) {
  if (!existsSync(cli)) throw new Error(`${cli} is missing: run npm run build first`);
  if (!existsSync(args.keys)) throw new Error(`the keys file ${args.keys} does not exist`);
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: args.repo, encoding: 'utf8' }).trim();
  if (dirty !== '' && !args.allowDirty) throw new Error(`${args.repo} has uncommitted changes; commit them or pass --allow-dirty (batch 105 needs it)`);

  const catalog = readCatalog();
  const refusal = checkLabels({ batch: args.batch, labels: args.labels ?? [], scoresByBatch: readScores() });
  if (refusal !== null) throw new Error(refusal);
  const runs = planBatch({
    batch: args.batch,
    catalog,
    labels: args.labels,
    verifyModel: args.verifyModel,
    verifyRoute: args.verifyRoute,
    judges: args.judges,
    preflight: readPreflight(),
  });
  return { runs, catalog, keys: parseKeys(readFileSync(args.keys, 'utf8')) };
}

async function batchCommand(args, prepared) {
  const result = await runBatch({ ...prepared, ceilingUsd: args.ceilingUsd, recordsDir, tmpDir, spawnRun, out: say, repo: args.repo });
  say(`batch ${args.batch}: done ${result.done}, failed ${result.failed}, left ${result.left}, not applicable ${result.notApplicable}, spent ${result.spentUsd.toFixed(2)} of ${args.ceilingUsd}`);
  return result.code;
}

async function preflightCommand(args) {
  const { code, preflight, failures } = await runPreflight({ catalog: readCatalog(), spawnRun, repo: args.repo });
  say(JSON.stringify({ ...preflight, failures }, null, 2));
  // Only a decided preflight is kept: a refusal or a failed check leaves no file for the later batches to accept.
  if (code === 0) {
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(preflightFile, `${JSON.stringify(preflight, null, 2)}\n`);
  }
  if (code !== 0 && existsSync(preflightFile)) say(`${preflightFile} from an earlier preflight still stands, and later batches will use it`);
  return code;
}

async function endpointsCommand(args) {
  const catalog = JSON.parse(readFileSync(candidatesFile, 'utf8'));
  const unfit = [];
  for (const cand of catalog.candidates) {
    if (cand.route !== 'openrouter' || (args.labels !== undefined && !args.labels.includes(cand.label))) continue;
    const response = await fetch(`https://openrouter.ai/api/v1/models/${cand.model}/endpoints`);
    if (!response.ok) throw new Error(`${cand.model}: /endpoints answered ${response.status}`);
    const { data } = await response.json();
    for (const e of data.endpoints) {
      say(`${cand.model}  ${e.tag}  ${e.provider_name}  ${e.quantization}  uptime30m ${e.uptime_last_30m}  structured_outputs ${(e.supported_parameters ?? []).includes('structured_outputs')}`);
    }
    const [maker] = cand.model.split('/');
    const chosen = chooseExecutor(VENDOR[maker] ?? maker, data.endpoints);
    if (chosen === null) {
      unfit.push(cand.model);
      continue;
    }
    say(`${cand.label}: ${chosen.tag} ${JSON.stringify(chosen.price)}`);
    cand.only = [chosen.tag];
    cand.price = chosen.price;
  }
  writeFileSync(candidatesFile, `${JSON.stringify(catalog, null, 2)}\n`);
  if (unfit.length === 0) return 0;
  process.stderr.write(`no host fits the rule for ${unfit.join(', ')}; their pins in candidates.json are unchanged\n`);
  return 2;
}

function noteSpendCommand(args) {
  mkdirSync(recordsDir, { recursive: true });
  appendFileSync(join(recordsDir, 'manual.jsonl'), `${JSON.stringify({ type: 'manual', usd: args.usd, reason: args.reason, at: new Date().toISOString() })}\n`);
  say(`noted ${args.usd} USD: ${args.reason}`);
  return 0;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, homedir());
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  // A refusal is exit 2; what goes wrong inside a run is not caught here, so it does not look like a refusal.
  let prepared;
  try {
    if (args.command === 'batch') prepared = prepareBatch(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (args.command === 'preflight') return preflightCommand(args);
  if (args.command === 'endpoints') return endpointsCommand(args);
  if (args.command === 'note-spend') return noteSpendCommand(args);
  return batchCommand(args, prepared);
}

process.exitCode = await main(process.argv.slice(2));
