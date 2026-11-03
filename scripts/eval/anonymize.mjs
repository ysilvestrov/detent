#!/usr/bin/env node
// Between batches: writes what the blind grader gets (`--out`) and keeps the key (`--key`) outside its task,
// then maps the grader's scores back into docs/eval/2026-11/scores/batch-<n>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymize, applyKey } from './lib/anon.mjs';
import { parseRecords } from './lib/records.mjs';

const USAGE = `Usage: node scripts/eval/anonymize.mjs --batch <n> --out <file> [--key <file>]
       node scripts/eval/anonymize.mjs --apply <anon-scores> --batch <n> [--key <file>]`;

const here = dirname(fileURLToPath(import.meta.url));
const detent = join(here, '..', '..');
const evalDir = join(detent, 'docs', 'eval', '2026-11');
const recordsDir = join(evalDir, 'records');

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!['--batch', '--out', '--key', '--apply'].includes(name)) throw new Error(`unrecognised option: ${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    values[name] = value;
  }
  const batch = Number(values['--batch']);
  if (values['--batch'] === undefined || !Number.isInteger(batch)) throw new Error('--batch needs a number');
  const key = values['--key'] ?? join(detent, 'tmp', 'eval', `anon-key-batch-${batch}.json`);
  if (values['--apply'] !== undefined) return { command: 'apply', batch, key, scores: values['--apply'] };
  if (values['--out'] === undefined) throw new Error('--out is required');
  return { command: 'anonymize', batch, key, out: values['--out'] };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
    if (args.command === 'apply') {
      const scores = applyKey(JSON.parse(readFileSync(args.scores, 'utf8')), JSON.parse(readFileSync(args.key, 'utf8')));
      const target = join(evalDir, 'scores', `batch-${args.batch}.json`);
      writeJson(target, scores);
      process.stdout.write(`wrote ${target}\n`);
      return 0;
    }
    const shared = join(recordsDir, `batch-${args.batch}.jsonl`);
    if (!existsSync(shared)) throw new Error(`${shared} does not exist`);
    const runs = parseRecords(readFileSync(shared, 'utf8')).filter((line) => line.type === 'run');
    const { items, key } = anonymize({ runs, read: (name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')) });
    writeJson(args.out, items);
    writeJson(args.key, key);
    process.stdout.write(`${items.length} runs anonymized into ${args.out}; the key is in ${args.key}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
