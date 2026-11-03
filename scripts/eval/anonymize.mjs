#!/usr/bin/env node
// Between batches: writes what the blind grader gets (`--out`) and keeps the key (`--key`) outside its task,
// then maps the grader's scores back into docs/eval/2026-11/scores/batch-<n>.json. The grader works by grader-brief.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymize, applyKey } from './lib/anon.mjs';
import { parseRecords } from './lib/records.mjs';

const USAGE = `Usage: node scripts/eval/anonymize.mjs --batch <n> --out <file> [--key <file>] [--out-root <dir>]
       node scripts/eval/anonymize.mjs --apply <anon-scores> --batch <n> [--key <file>] [--force] [--out-root <dir>]`;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', '..');

function parseArgs(argv) {
  const values = {};
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--force') {
      force = true;
      continue;
    }
    const value = argv[++i];
    if (!['--batch', '--out', '--key', '--apply', '--out-root'].includes(name)) throw new Error(`unrecognised option: ${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    values[name] = value;
  }
  const batch = Number(values['--batch']);
  if (values['--batch'] === undefined || !Number.isInteger(batch)) throw new Error('--batch needs a number');
  const outRoot = values['--out-root'] ?? DEFAULT_ROOT;
  const evalDir = join(outRoot, 'docs', 'eval', '2026-11');
  const key = values['--key'] ?? join(outRoot, 'tmp', 'eval', `anon-key-batch-${batch}.json`);
  if (values['--apply'] !== undefined) return { command: 'apply', batch, key, evalDir, force, scores: values['--apply'] };
  if (values['--out'] === undefined) throw new Error('--out is required');
  return { command: 'anonymize', batch, key, evalDir, out: values['--out'] };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function applyCommand(args) {
  const key = JSON.parse(readFileSync(args.key, 'utf8'));
  const others = [...new Set(Object.values(key).map((entry) => entry.batch))].filter((batch) => batch !== args.batch);
  if (others.length > 0) throw new Error(`the key is of batch ${others.join(', ')}, not batch ${args.batch}`);
  const scores = applyKey(JSON.parse(readFileSync(args.scores, 'utf8')), key);
  const target = join(args.evalDir, 'scores', `batch-${args.batch}.json`);
  // The owner's corrections live in that file (spec line 289).
  if (existsSync(target) && !args.force) throw new Error(`${target} exists and may hold the owner's corrections; pass --force to overwrite it`);
  writeJson(target, scores);
  process.stdout.write(`wrote ${target}\n`);
}

function anonymizeCommand(args) {
  const recordsDir = join(args.evalDir, 'records');
  const shared = join(recordsDir, `batch-${args.batch}.jsonl`);
  if (!existsSync(shared)) throw new Error(`${shared} does not exist`);
  const runs = parseRecords(readFileSync(shared, 'utf8')).filter((line) => line.type === 'run');
  if (existsSync(args.key)) throw new Error(`the key file ${args.key} exists; rerunning would orphan the scores being made against it; to anonymize again, pass another --key`);
  const { items, key, suspects } = anonymize({ runs, read: (name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')) });
  writeJson(args.out, items);
  writeJson(args.key, key);
  if (suspects.length > 0) process.stdout.write(`items naming their own model, for the owner to check: ${suspects.join(', ')}\n`);
  process.stdout.write(`${items.length} runs anonymized into ${args.out}; the key is in ${args.key}\n`);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    if (args.command === 'apply') applyCommand(args);
    else anonymizeCommand(args);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
