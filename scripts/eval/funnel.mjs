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
import { chooseExecutor, withoutHost } from './lib/executors.mjs';
import { parseKeys } from './lib/records.mjs';
import { proxyRefusal, runBatch, runPreflight } from './lib/runner.mjs';
import { checkLabels } from './lib/selection.mjs';

const USAGE = `Usage: node scripts/eval/funnel.mjs --keys <file> --batch <n> --ceiling <usd> [--labels a,b] [--verify-model <id> --verify-route <id>] [--judges m:route,...] [--repo <dir>] [--allow-dirty]
       node scripts/eval/funnel.mjs --preflight [--repo <dir>]
       node scripts/eval/funnel.mjs --endpoints [--labels a,b] [--exclude-host <host>]
       node scripts/eval/funnel.mjs --note-spend <usd> --reason <text>
Every command also takes --detent <dir> (the clone with dist/cli.js and scripts/eval/candidates.json) and --out-root <dir> (where docs/eval and tmp/eval go).`;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', '..');
/** The spec's estimate of batch 7: batch 6 leaves it standing, because the ceiling cuts batch 6 first. */
const BATCH_7_ESTIMATE_USD = 2.9;
/** The maker of a model, where its OpenRouter host is named otherwise than the model id. */
const VENDOR = { qwen: 'alibaba' };
const SCORED_BATCHES = [2, 3, 4, 5, 6];

const say = (line) => process.stdout.write(`${line}\n`);

/** Where a command reads and writes, from `--detent` and `--out-root`. */
function pathsOf(args) {
  const detent = args.detent ?? DEFAULT_ROOT;
  const outRoot = args.outRoot ?? DEFAULT_ROOT;
  const evalDir = join(outRoot, 'docs', 'eval', '2026-11');
  return {
    cli: join(detent, 'dist', 'cli.js'),
    candidatesFile: join(detent, 'scripts', 'eval', 'candidates.json'),
    evalDir,
    recordsDir: join(evalDir, 'records'),
    tmpDir: join(outRoot, 'tmp', 'eval'),
    preflightFile: join(evalDir, 'preflight.json'),
  };
}

/** A `spawnRun`: runs `node cli.js ...args` in `cwd` with exactly `env`; resolves with what it printed. */
const spawnerOf = (cli) => (args, env, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const readCatalog = ({ candidatesFile }) => loadCatalog(readFileSync(candidatesFile, 'utf8'));

function readScores({ evalDir }) {
  const scoresByBatch = {};
  for (const n of SCORED_BATCHES) {
    const file = join(evalDir, 'scores', `batch-${n}.json`);
    if (existsSync(file)) scoresByBatch[n] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return scoresByBatch;
}

function readPreflight({ preflightFile }) {
  return existsSync(preflightFile) ? JSON.parse(readFileSync(preflightFile, 'utf8')) : undefined;
}

/** Everything that can still refuse the batch before it spends; an Error here is exit 2. */
function prepareBatch(args, paths) {
  if (!existsSync(paths.cli)) throw new Error(`${paths.cli} is missing: run npm run build first`);
  if (!existsSync(args.keys)) throw new Error(`the keys file ${args.keys} does not exist`);
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: args.repo, encoding: 'utf8' }).trim();
  if (dirty !== '' && !args.allowDirty) throw new Error(`${args.repo} has uncommitted changes; commit them or pass --allow-dirty (batch 105 needs it)`);

  const catalog = readCatalog(paths);
  const refusal = checkLabels({ batch: args.batch, labels: args.labels ?? [], scoresByBatch: readScores(paths) });
  if (refusal !== null) throw new Error(refusal);
  const runs = planBatch({
    batch: args.batch,
    catalog,
    labels: args.labels,
    verifyModel: args.verifyModel,
    verifyRoute: args.verifyRoute,
    judges: args.judges,
    preflight: readPreflight(paths),
  });
  return { runs, catalog, keys: parseKeys(readFileSync(args.keys, 'utf8')) };
}

async function batchCommand(args, prepared, { cli, recordsDir, tmpDir }) {
  const reserveUsd = args.batch === 6 ? BATCH_7_ESTIMATE_USD : 0;
  const result = await runBatch({ ...prepared, ceilingUsd: args.ceilingUsd, reserveUsd, recordsDir, tmpDir, spawnRun: spawnerOf(cli), out: say, repo: args.repo });
  say(`batch ${args.batch}: done ${result.done}, failed ${result.failed}, left ${result.left}, not applicable ${result.notApplicable}, spent ${result.spentUsd.toFixed(2)} of ${args.ceilingUsd}`);
  return result.code;
}

async function preflightCommand(args, paths) {
  const { evalDir, preflightFile } = paths;
  const { code, preflight, failures } = await runPreflight({ catalog: readCatalog(paths), spawnRun: spawnerOf(paths.cli), repo: args.repo });
  say(JSON.stringify({ ...preflight, failures }, null, 2));
  // Only a decided preflight is kept: a refusal or a failed check leaves no file for the later batches to accept.
  if (code === 0) {
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(preflightFile, `${JSON.stringify(preflight, null, 2)}\n`);
  }
  if (code !== 0 && existsSync(preflightFile)) say(`${preflightFile} from an earlier preflight still stands, and later batches will use it`);
  return code;
}

/** Pins each row by the host rule. Every model is answered for by itself: one that fails loses no other pin. */
async function endpointsCommand(args, { candidatesFile }) {
  const catalog = JSON.parse(readFileSync(candidatesFile, 'utf8'));
  const rows = [
    ...catalog.candidates.filter((cand) => cand.route === 'openrouter' && cand.dropped === undefined).map((cand) => ({ name: cand.label, entry: cand })),
    ...catalog.judges.map((judge) => ({ name: judge.model, entry: judge })),
  ];
  const unknown = (args.labels ?? []).filter((label) => !rows.some((row) => row.name === label));
  if (unknown.length > 0) {
    process.stderr.write(`unknown label ${unknown.join(', ')}: --labels takes an openrouter candidate that is not dropped, or a judge's model\n`);
    return 2;
  }
  const unfit = [];
  const failed = [];
  for (const { name, entry } of rows.filter((row) => args.labels === undefined || args.labels.includes(row.name))) {
    let endpoints;
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/models/${entry.model}/endpoints`);
      if (!response.ok) throw new Error(`/endpoints answered ${response.status}`);
      endpoints = (await response.json()).data?.endpoints;
      if (!Array.isArray(endpoints)) throw new Error(`/endpoints answered ${response.status} with no endpoints`);
    } catch (error) {
      failed.push(`${entry.model}: ${error.message}`);
      continue;
    }
    for (const e of endpoints) {
      say(`${entry.model}  ${e.tag}  ${e.provider_name}  ${e.quantization}  uptime30m ${e.uptime_last_30m}  structured_outputs ${(e.supported_parameters ?? []).includes('structured_outputs')}`);
    }
    const [maker] = entry.model.split('/');
    const chosen = chooseExecutor(VENDOR[maker] ?? maker, withoutHost(endpoints, args.excludeHost));
    if (chosen === null) {
      unfit.push(entry.model);
      continue;
    }
    say(`chosen ${name}: ${chosen.tag} ${JSON.stringify(chosen.price)}`);
    entry.only = [chosen.tag];
    entry.price = chosen.price;
  }
  writeFileSync(candidatesFile, `${JSON.stringify(catalog, null, 2)}\n`);
  if (unfit.length > 0) process.stderr.write(`no host fits the rule for ${unfit.join(', ')}; their pins in candidates.json are unchanged\n`);
  for (const line of failed) process.stderr.write(`${line}; its pin in candidates.json is unchanged\n`);
  if (failed.length > 0) return 5;
  return unfit.length > 0 ? 2 : 0;
}

function noteSpendCommand(args, { recordsDir }) {
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
  const paths = pathsOf(args);
  if (args.command === 'note-spend') return noteSpendCommand(args, paths);
  const refusal = proxyRefusal(process.env);
  if (refusal !== null) {
    process.stderr.write(`${refusal}\n`);
    return 2;
  }
  // A refusal is exit 2; what goes wrong inside a run is not caught here, so it does not look like a refusal.
  let prepared;
  try {
    if (args.command === 'batch') prepared = prepareBatch(args, paths);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (args.command === 'preflight') return preflightCommand(args, paths);
  if (args.command === 'endpoints') return endpointsCommand(args, paths);
  return batchCommand(args, prepared, paths);
}

process.exitCode = await main(process.argv.slice(2));
