#!/usr/bin/env node
// The report of the big test: a table per config, the profile candidates, the cache field, the Anthropic thinking
// check and the recorded spend. Makes no paid call; reads docs/eval/2026-11/ and candidates.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.mjs';
import { admitted, pickProfiles } from './lib/profiles.mjs';
import { parseRecords } from './lib/records.mjs';
import { anthropicThinking, cacheFields, paidByRoute, summarize } from './lib/summary.mjs';

const USAGE = 'Usage: node scripts/eval/summary.mjs --batch-from <n> [--cache-rule on|off]';

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, '..', '..', 'docs', 'eval', '2026-11');
const ROUTES = ['openai', 'anthropic', 'openrouter'];

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!['--batch-from', '--cache-rule'].includes(name)) throw new Error(`unrecognised option: ${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    values[name] = value;
  }
  const batchFrom = Number(values['--batch-from']);
  if (values['--batch-from'] === undefined || !Number.isInteger(batchFrom)) throw new Error('--batch-from needs a number');
  const rule = values['--cache-rule'] ?? 'off';
  if (!['on', 'off'].includes(rule)) throw new Error('--cache-rule needs on or off');
  return { batchFrom, cacheRuleApplies: rule === 'on' };
}

/** `batch-<n>.<ext>` files of a directory with n at least `from`, sorted by n. */
function batchFiles(dir, ext, from) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, n: Number(new RegExp(`^batch-(\\d+)\\.${ext}$`).exec(name)?.[1]) }))
    .filter((f) => Number.isInteger(f.n) && f.n >= from)
    .sort((a, b) => a.n - b.n);
}

function readLines(from) {
  const dir = join(evalDir, 'records');
  const lines = batchFiles(dir, 'jsonl', from).flatMap((f) => parseRecords(readFileSync(join(dir, f.name), 'utf8')));
  const manual = join(dir, 'manual.jsonl');
  return existsSync(manual) ? [...lines, ...parseRecords(readFileSync(manual, 'utf8'))] : lines;
}

function readScores(from) {
  const dir = join(evalDir, 'scores');
  const batches = {};
  for (const f of batchFiles(dir, 'json', from)) batches[f.n] = JSON.parse(readFileSync(join(dir, f.name), 'utf8'));
  const judgesFile = join(dir, 'judges.json');
  return { batches, judges: existsSync(judgesFile) ? JSON.parse(readFileSync(judgesFile, 'utf8')) : {} };
}

const usd = (v) => (v === null ? '-' : `$${v.toFixed(2)}`);
const num = (v) => (v === null ? '-' : String(v));
const pct = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`);

function configTable(rows) {
  const out = [
    '| label | route | pair | draws | per draw | median | union | published | #930 | refuted | errors | paid | production | flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const flags = [r.composite ? 'composite' : '', r.unstable ? 'unstable' : ''].filter(Boolean).join(', ');
    out.push(
      `| ${r.label} | ${r.route} | ${r.pair} | ${r.draws} | ${r.perDraw.join('/')} | ${num(r.medianKnown)} | ${r.union} | ${num(r.medianPublished)} | ${num(r.medianRecall930)} | ${num(r.refutedMean)} | ${pct(r.errorShare)} | ${usd(r.paidUsd)} | ${usd(r.productionUsd)} | ${flags} |`,
    );
  }
  return out;
}

function profileTables(rows, baselineRow) {
  const picks = pickProfiles(rows, baselineRow);
  const cell = (c) => (c.row === null ? `(none) ${c.note}` : `${c.row.label}${c.preliminary ? ' (preliminary)' : ''}${c.note === '' ? '' : ` - ${c.note}`}`);
  return ROUTES.flatMap((route) => [
    '',
    `### ${route}`,
    '',
    '| profile | candidate |',
    '|---|---|',
    `| best of the best | ${cell(picks.best[route])} |`,
    `| balanced | ${cell(picks.balanced[route])} |`,
    `| best value | ${cell(picks.value[route])} |`,
  ]);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const catalog = loadCatalog(readFileSync(join(here, 'candidates.json'), 'utf8'));
  const lines = readLines(args.batchFrom);
  const scores = readScores(args.batchFrom);
  const rows = summarize({ lines, catalog, scores, cacheRuleApplies: args.cacheRuleApplies });
  const baselineRow = rows.find((r) => r.label === catalog.baseline.label);
  const calls = lines.filter((l) => l.type === 'call');
  const labelRoute = new Map(catalog.candidates.map((c) => [c.label, c.route]));
  const anthropicCalls = calls.filter((c) => labelRoute.get(c.key?.split('|')[2]) === 'anthropic');
  const spend = paidByRoute(lines, catalog);

  const out = [];
  out.push(`# Selection report, batches from ${args.batchFrom}`, '', `Cache rule applies: ${args.cacheRuleApplies ? 'yes' : 'no'}`, '', '## Configs', '');
  out.push(...configTable(rows));
  out.push('', 'The judge cost of composite rows is not included: it needs the tokens of gpt-5.5 on verify-corpus, which are in the verify-corpus output, not in the records.');
  out.push('', '## Profile candidates');
  out.push(...(baselineRow === undefined ? ['', 'No baseline row yet, so no candidates.'] : profileTables(rows, baselineRow)));
  out.push('', '## Admission', '');
  for (const r of rows) out.push(`- ${r.label}: ${admitted(r).ok ? 'admitted' : admitted(r).reasons.join('; ')}`);
  out.push('', '## Cache counters seen in prompt_tokens_details', '');
  const fields = Object.entries(cacheFields(calls));
  out.push(...(fields.length === 0 ? ['none'] : fields.map(([name, max]) => `- ${name}: largest value ${max}`)));
  out.push('', '## Anthropic thinking', '');
  out.push(anthropicCalls.length === 0 ? 'no Anthropic calls recorded' : `thinking looks ${anthropicThinking(anthropicCalls) ? 'on' : 'off'} (${anthropicCalls.length} calls)`);
  out.push('', '## Recorded spend, to check against the consoles', '');
  for (const [route, total] of Object.entries(spend.byRoute)) out.push(`- ${route}: ${usd(total)}`);
  out.push(`- manual: ${usd(spend.manualUsd)}`);
  out.push(`- total: ${usd(Object.values(spend.byRoute).reduce((a, b) => a + b, 0) + spend.manualUsd)}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
