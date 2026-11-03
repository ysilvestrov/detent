#!/usr/bin/env node
// The report of the big test: a table per pair, the profile candidates, the items of stage 2, the cache field and its
// threshold, whether the executor is visible, the Anthropic thinking check and the recorded spend.
// Makes no paid call; reads docs/eval/2026-11/ and candidates.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.mjs';
import { admitted, pickProfiles, proposeFinalists } from './lib/profiles.mjs';
import { parseRecords } from './lib/records.mjs';
import { anthropicCalls, anthropicThinking, baselineRowOf, cacheFields, executorVisibility, paidByRoute, prOf, readsPerWrite, stage2Items, summarize } from './lib/summary.mjs';

const USAGE = 'Usage: node scripts/eval/summary.mjs --batch-from <n> [--cache-rule on|off] [--detent <dir>] [--out-root <dir>]';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, '..', '..');
const ROUTES = ['openai', 'anthropic', 'openrouter'];
/** Below this many tokens read per token written the 25% surcharge does not pay for itself (spec line 66). */
const CACHE_THRESHOLD = 0.28;
const THRESHOLD_PR = '688';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!['--batch-from', '--cache-rule', '--detent', '--out-root'].includes(name)) throw new Error(`unrecognised option: ${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    values[name] = value;
  }
  const batchFrom = Number(values['--batch-from']);
  if (values['--batch-from'] === undefined || !Number.isInteger(batchFrom)) throw new Error('--batch-from needs a number');
  const rule = values['--cache-rule'] ?? 'off';
  if (!['on', 'off'].includes(rule)) throw new Error('--cache-rule needs on or off');
  return {
    batchFrom,
    cacheRuleApplies: rule === 'on',
    candidatesFile: join(values['--detent'] ?? DEFAULT_ROOT, 'scripts', 'eval', 'candidates.json'),
    evalDir: join(values['--out-root'] ?? DEFAULT_ROOT, 'docs', 'eval', '2026-11'),
  };
}

/** `batch-<n>.<ext>` files of a directory with n at least `from`, sorted by n. */
function batchFiles(dir, ext, from) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, n: Number(new RegExp(`^batch-(\\d+)\\.${ext}$`).exec(name)?.[1]) }))
    .filter((f) => Number.isInteger(f.n) && f.n >= from)
    .sort((a, b) => a.n - b.n);
}

function readLines(evalDir, from) {
  const dir = join(evalDir, 'records');
  const lines = batchFiles(dir, 'jsonl', from).flatMap((f) => parseRecords(readFileSync(join(dir, f.name), 'utf8')));
  const manual = join(dir, 'manual.jsonl');
  return existsSync(manual) ? [...lines, ...parseRecords(readFileSync(manual, 'utf8'))] : lines;
}

function readScores(evalDir, from) {
  const dir = join(evalDir, 'scores');
  const batches = {};
  for (const f of batchFiles(dir, 'json', from)) batches[f.n] = JSON.parse(readFileSync(join(dir, f.name), 'utf8'));
  const judgesFile = join(dir, 'judges.json');
  return { batches, judges: existsSync(judgesFile) ? JSON.parse(readFileSync(judgesFile, 'utf8')) : {} };
}

const usd = (v) => (v === null ? '-' : `$${v.toFixed(2)}`);
const production = (r) => (r.costUnknown ? 'unknown' : usd(r.productionUsd));
const num = (v) => (v === null ? '-' : String(v));
const pct = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`);
/** `null` when nothing is scored yet; an empty list when nothing is missing. */
const ids = (list) => {
  if (list === null) return '-';
  return list.length === 0 ? 'none' : list.join(', ');
};

function configTable(rows) {
  const out = [
    '| label | route | pair | draws | per draw | median | union | missed (find) | published | published union | missed (published) | #930 | refuted | errors | paid | production | flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const flags = [r.composite ? 'composite' : '', r.unstable ? 'unstable' : '', r.dropped ? 'dropped' : ''].filter(Boolean).join(', ');
    const publishedUnion = r.missedPublished === null ? null : r.publishedDefects;
    out.push(
      `| ${r.label} | ${r.route} | ${r.pair} | ${r.draws} | ${r.perDraw.join('/')} | ${num(r.medianKnown)} | ${r.union} | ${ids(r.missedFind)} | ${num(r.medianPublished)} | ${ids(publishedUnion)} | ${ids(r.missedPublished)} | ${num(r.medianRecall930)} | ${num(r.refutedMean)} | ${pct(r.errorShare)} | ${usd(r.paidUsd)} | ${production(r)} | ${flags} |`,
    );
  }
  return out;
}

function profileTables(picks) {
  const cell = (c) => (c.row === null ? `(none) ${c.note}` : `${c.row.pair}${c.row.generic ? ' (generic prompts)' : ''}${c.preliminary ? ' (preliminary)' : ''}${c.note === '' ? '' : ` - ${c.note}`}`);
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

function stage2Table(items) {
  const total = items.reduce((sum, item) => sum + item.usd, 0);
  return ['| # | item | estimate |', '|---|---|---|', ...items.map((item) => `| ${item.item} | ${item.what} | ${usd(item.usd)} |`), '', `Total: ${usd(total)}.`];
}

function cacheLine(name, { reads, writes, ratio }) {
  if (ratio === null) return `- ${name}: ${reads} read, nothing written`;
  const verdict = ratio < CACHE_THRESHOLD ? 'below it, so the cache rule applies: pass --cache-rule on' : 'the write pays for itself';
  return `- ${name}: ${reads} read, ${writes} written: ${ratio.toFixed(2)}, ${verdict}`;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const { evalDir } = args;
  const catalog = loadCatalog(readFileSync(args.candidatesFile, 'utf8'));
  const lines = readLines(evalDir, args.batchFrom);
  const scores = readScores(evalDir, args.batchFrom);
  const rows = summarize({ lines, catalog, scores, cacheRuleApplies: args.cacheRuleApplies });
  const baselineRow = baselineRowOf(rows, catalog);
  const picks = baselineRow === undefined ? null : pickProfiles(rows, baselineRow);
  const calls = lines.filter((l) => l.type === 'call');
  const thinkingCalls = anthropicCalls(calls, catalog);
  const spend = paidByRoute(lines, catalog);
  const executors = executorVisibility(calls);
  const preflightFile = join(evalDir, 'preflight.json');
  const corpus = existsSync(preflightFile) ? JSON.parse(readFileSync(preflightFile, 'utf8')).corpus : catalog.corpus;
  const finalists = picks === null ? [] : proposeFinalists(picks, catalog.baseline.label);
  const pairs = picks === null ? [] : [picks.best.anthropic.row?.label, picks.best.openai.row?.label].filter((label) => label !== undefined && label !== catalog.baseline.label);

  const out = [];
  out.push(`# Selection report, batches from ${args.batchFrom}`, '', `Cache rule applies: ${args.cacheRuleApplies ? 'yes' : 'no'}`, '', '## Configs', '');
  out.push(...configTable(rows));
  out.push('', 'The judge cost of composite rows is not included: it needs the tokens of gpt-5.5 on verify-corpus, which are in the verify-corpus output, not in the records. A row with no judge is ranked with the baseline judge cost added; the table does not add it.');
  out.push('', '## Profile candidates');
  out.push(...(picks === null ? ['', 'No baseline row yet, so no candidates.'] : profileTables(picks)));
  out.push('', '## Admission', '');
  for (const r of rows) out.push(`- ${r.pair}${r.generic ? ' (generic prompts)' : ''}: ${admitted(r).ok ? 'admitted' : admitted(r).reasons.join('; ')}`);
  out.push('', '## Stage 2, with what the plan estimates', '');
  out.push(...stage2Table(stage2Items({ catalog, corpus, finalists, pairs })));
  out.push('', '## Cache counters seen in prompt_tokens_details', '');
  const fields = Object.entries(cacheFields(calls));
  out.push(...(fields.length === 0 ? ['none'] : fields.map(([name, max]) => `- ${name}: largest value ${max}`)));
  out.push('', `## Reads per written token, against the threshold of ${CACHE_THRESHOLD}`, '');
  out.push(cacheLine('all calls', readsPerWrite(calls)));
  out.push(cacheLine(`#${THRESHOLD_PR}`, readsPerWrite(calls.filter((c) => prOf(c) === THRESHOLD_PR))));
  out.push('', '## Is the executor visible', '');
  out.push(`call.provider names the host on ${executors.visible} of ${executors.calls} calls${executors.hosts.length === 0 ? '' : `: ${executors.hosts.join(', ')}`}`);
  out.push('', '## Anthropic thinking', '');
  out.push(thinkingCalls.length === 0 ? 'no Anthropic calls recorded' : `thinking looks ${anthropicThinking(thinkingCalls) ? 'on' : 'off'} (${thinkingCalls.length} calls)`);
  out.push('', '## Recorded spend, to check against the consoles', '');
  for (const [route, total] of Object.entries(spend.byRoute)) out.push(`- ${route}: ${usd(total)}`);
  out.push(`- manual: ${usd(spend.manualUsd)}`);
  out.push(`- total: ${usd(Object.values(spend.byRoute).reduce((a, b) => a + b, 0) + spend.manualUsd)}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
