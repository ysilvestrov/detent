// The real scripts, spawned in temp dirs against a stub of `dist/cli.js` and a stub of `fetch`: no network, fake keys.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseRecords } from './lib/records.mjs';
import { summarize } from './lib/summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_KEYS = 'OPENAI_API_KEY=fake-openai-key-0123456789\nANTHROPIC_API_KEY=fake-anthropic-key-0123456789\nOPENROUTER_API_KEY=fake-openrouter-key-0123456789\n';

const size = (head) => ({ head, input: 41400, output: 4600 });
const candidate = (label, model, route, tier, price) => ({ label, model, route, only: null, tier, price });
const seedCatalog = () => ({
  baseline: { label: 'gpt-5.6-sol', findModel: 'gpt-5.6-sol', verifyModel: 'gpt-5.5', route: 'openai' },
  candidates: [
    candidate('claude-haiku-5-5', 'claude-haiku-5-5', 'anthropic', 'cheap', { input: 0.1, output: 0.5 }),
    candidate('qwen3.8-flash', 'qwen/qwen3.8-flash', 'openrouter', 'cheap', { input: 0.15, output: 0.47 }),
    candidate('grok-build-0.1', 'x-ai/grok-build-0.1', 'openrouter', 'cheap', { input: 1, output: 2 }),
    candidate('gpt-6.1-terra', 'gpt-6.1-terra', 'openai', 'mid', { input: 1, output: 5 }),
    candidate('gpt-6.1-sol', 'gpt-6.1-sol', 'openai', 'mid', { input: 2, cacheWrite: 2.5, output: 10 }),
    candidate('claude-sonnet-5-5', 'claude-sonnet-5-5', 'anthropic', 'mid', { input: 2, output: 10 }),
    candidate('claude-opus-5-5', 'claude-opus-5-5', 'anthropic', 'expensive', { input: 4, output: 20 }),
    candidate('gpt-6-astra', 'gpt-6-astra', 'openai', 'expensive', { input: 10, output: 50 }),
  ],
  judges: [{ model: 'openai/gpt-5.5', only: null, price: { input: 5, output: 30 } }],
  prices: { 'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }, 'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 } },
  prs: {
    344: size(null),
    348: size(null),
    352: size(null),
    418: size('584aa661'),
    688: { head: null, input: 30000, output: 3500 },
    895: { head: null, input: 10000, output: 1500 },
    930: size('a5926a74'),
  },
  corpus: ['344', '348', '352'],
  recallPrs: ['418', '930'],
});

const endpoint = (tag, providerName, prompt, completion) => ({
  tag,
  provider_name: providerName,
  quantization: 'fp8',
  uptime_last_30m: 100,
  supported_parameters: ['structured_outputs'],
  pricing: { prompt, completion },
});
const seedEndpoints = () => ({
  'qwen/qwen3.8-flash': { status: 200, endpoints: [endpoint('alibaba', 'Alibaba', '0.0000002', '0.0000005'), endpoint('other', 'Other', '0.0000003', '0.0000006')] },
  'x-ai/grok-build-0.1': { status: 200, endpoints: [endpoint('xai', 'xAI', '0.000001', '0.000002')] },
  'openai/gpt-5.5': { status: 200, endpoints: [endpoint('openai', 'OpenAI', '0.000005', '0.00003')] },
});

/** A clone of detent and a bot repo in a new temp dir, the stub in place of the build. */
function setup({ catalog = seedCatalog(), endpoints = seedEndpoints() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-'));
  const detent = join(dir, 'det');
  const catalogFile = join(detent, 'scripts', 'eval', 'candidates.json');
  mkdirSync(join(detent, 'dist'), { recursive: true });
  mkdirSync(dirname(catalogFile), { recursive: true });
  copyFileSync(join(here, 'fixtures', 'stub-cli.cjs'), join(detent, 'dist', 'cli.js'));
  writeFileSync(join(detent, 'dist', 'package.json'), '{"type":"commonjs"}');
  writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  const repo = join(dir, 'bot');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const keys = join(dir, 'keys.env');
  writeFileSync(keys, FAKE_KEYS);
  const endpointsFile = join(dir, 'endpoints.json');
  writeFileSync(endpointsFile, JSON.stringify(endpoints));
  const fetchLog = join(dir, 'fetch.log');
  writeFileSync(fetchLog, '');
  const out = join(dir, 'out');
  const fetchEnv = {
    NODE_OPTIONS: `--import ${pathToFileURL(join(here, 'fixtures', 'stub-fetch.mjs')).href}`,
    STUB_ENDPOINTS: endpointsFile,
    STUB_ENDPOINTS_LOG: fetchLog,
  };
  const spawn = (script, args, env = {}) => {
    const result = spawnSync(process.execPath, [join(here, script), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const roots = ['--detent', detent, '--out-root', out];
  return {
    dir,
    repo,
    out,
    funnel: (...args) => spawn('funnel.mjs', [...args, ...roots]),
    endpoints: (...args) => spawn('funnel.mjs', ['--endpoints', ...args, ...roots], fetchEnv),
    batch: (n, ceiling, ...args) => spawn('funnel.mjs', ['--keys', keys, '--repo', repo, '--batch', String(n), '--ceiling', String(ceiling), ...args, ...roots]),
    preflight: () => spawn('funnel.mjs', ['--preflight', '--repo', repo, ...roots]),
    control: (value) => writeFileSync(join(detent, 'dist', 'control.json'), JSON.stringify(value)),
    catalog: () => JSON.parse(readFileSync(catalogFile, 'utf8')),
    writeCatalog: (value) => writeFileSync(catalogFile, JSON.stringify(value, null, 2)),
    records: (n) => readFileSync(join(out, 'docs', 'eval', '2026-11', 'records', `batch-${n}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    fetched: () => readFileSync(fetchLog, 'utf8').trim().split('\n'),
    report: (...args) => spawn('summary.mjs', ['--batch-from', '0', ...args, ...roots]),
    anonymize: (...args) => spawn('anonymize.mjs', [...args, '--out-root', out]),
    keyFile: (n) => join(out, 'tmp', 'eval', `anon-key-batch-${n}.json`),
    scoresFile: (n) => join(out, 'docs', 'eval', '2026-11', 'scores', `batch-${n}.json`),
    writeScores: (n, value) => {
      const scoresDir = join(out, 'docs', 'eval', '2026-11', 'scores');
      mkdirSync(scoresDir, { recursive: true });
      writeFileSync(join(scoresDir, `batch-${n}.json`), JSON.stringify(value));
    },
  };
}

const row = (catalog, label) => catalog.candidates.find((c) => c.label === label);

describe('--endpoints', () => {
  it('pins every openrouter candidate and the judges, by the rule, and prints the chosen tags', () => {
    const s = setup();
    const result = s.endpoints();
    const catalog = s.catalog();
    expect(result.code).toBe(0);
    expect(row(catalog, 'qwen3.8-flash')).toMatchObject({ only: ['alibaba'], price: { input: 0.2, output: 0.5 } });
    expect(row(catalog, 'grok-build-0.1').only).toEqual(['xai']);
    expect(catalog.judges).toEqual([{ model: 'openai/gpt-5.5', only: ['openai'], price: { input: 5, output: 30 } }]);
    expect(result.stdout).toContain('chosen qwen3.8-flash: alibaba');
    expect(result.stdout).toContain('chosen grok-build-0.1: xai');
    expect(result.stdout).toContain('chosen openai/gpt-5.5: openai');
  });

  it('rewrites only the labels it is given', () => {
    const s = setup();
    const result = s.endpoints('--labels', 'qwen3.8-flash');
    const catalog = s.catalog();
    expect(result.code).toBe(0);
    expect(s.fetched()).toEqual(['qwen/qwen3.8-flash']);
    expect(row(catalog, 'grok-build-0.1').only).toBe(null);
    expect(catalog.judges[0].only).toBe(null);
  });

  it('takes a judge by its model in --labels', () => {
    const s = setup();
    s.endpoints('--labels', 'openai/gpt-5.5');
    expect(s.fetched()).toEqual(['openai/gpt-5.5']);
    expect(s.catalog().judges[0].only).toEqual(['openai']);
  });

  it('moves a pin to another host with its price when the first host is excluded', () => {
    const s = setup();
    s.endpoints();
    const result = s.endpoints('--labels', 'qwen3.8-flash', '--exclude-host', 'alibaba');
    const catalog = s.catalog();
    expect(result.code).toBe(0);
    expect(row(catalog, 'qwen3.8-flash')).toMatchObject({ only: ['other'], price: { input: 0.3, output: 0.6 } });
    expect(row(catalog, 'grok-build-0.1').only).toEqual(['xai']);
  });

  it('reports a non-2xx answer for its model, writes the others, and exits 5', () => {
    const endpoints = { ...seedEndpoints(), 'qwen/qwen3.8-flash': { status: 503, endpoints: [] } };
    const s = setup({ endpoints });
    const result = s.endpoints();
    const catalog = s.catalog();
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('qwen/qwen3.8-flash: /endpoints answered 503');
    expect(row(catalog, 'qwen3.8-flash').only).toBe(null);
    expect(row(catalog, 'grok-build-0.1').only).toEqual(['xai']);
    expect(catalog.judges[0].only).toEqual(['openai']);
  });

  it('exits 2 when no host fits, and writes the others', () => {
    const endpoints = { ...seedEndpoints(), 'x-ai/grok-build-0.1': { status: 200, endpoints: [] } };
    const s = setup({ endpoints });
    const result = s.endpoints();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no host fits the rule for x-ai/grok-build-0.1');
    expect(row(s.catalog(), 'qwen3.8-flash').only).toEqual(['alibaba']);
  });

  it('skips a dropped candidate', () => {
    const catalog = seedCatalog();
    row(catalog, 'grok-build-0.1').dropped = 'empty answer twice';
    const s = setup({ catalog });
    s.endpoints();
    expect(s.fetched()).toEqual(['qwen/qwen3.8-flash', 'openai/gpt-5.5']);
  });

  it('refuses a label nobody has', () => {
    const s = setup();
    const result = s.endpoints('--labels', 'nobody');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown label nobody');
  });
});

describe('the refusals of a batch', () => {
  it('refuses batch 1 with no preflight file, with exit 2', () => {
    const s = setup();
    const result = s.batch(1, 11);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('plan: batch 1 needs the preflight\n');
  });

  it('writes no preflight when #418 drops, so batch 1 stays refused', () => {
    const s = setup();
    s.control({ budget: { 418: 'Context budget: 1 file(s) sent as diff only: src/a.ts' } });
    expect(s.preflight().code).toBe(2);
    expect(s.batch(1, 11).code).toBe(2);
  });

  it('refuses --labels on batch 2 with exit 2', () => {
    const s = setup();
    const result = s.batch(2, 11, '--labels', 'qwen3.8-flash');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('batch 2 ignores --labels');
  });
});

describe('batch 6 leaves batch 7 standing', () => {
  /** One run of gpt-6-astra is estimated at $0.644, so admitting it takes $1.288 under what the ceiling leaves. */
  function afterBatch5() {
    const s = setup();
    s.endpoints();
    expect(s.preflight().code).toBe(0);
    const score = { defects: ['D1', 'D2'], findings: 3, pr: '418' };
    s.writeScores(5, { 'gpt-6-astra': { 1: score, 2: score } });
    return s;
  }

  it('stops at the ceiling less the $2.9 of batch 7', () => {
    const result = afterBatch5().batch(6, 4, '--labels', 'gpt-6-astra');
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('stop at the ceiling: spent 0.00 of 4, 2.9 of it held back, 1 run(s) left');
  });

  it('runs when the run fits beside that reserve', () => {
    expect(afterBatch5().batch(6, 4.3, '--labels', 'gpt-6-astra').code).toBe(0);
  });
});

describe('the report', () => {
  const draws = (defects) => ({ 1: { defects, findings: 3, pr: '418' }, 2: { defects, findings: 3, pr: '418' }, 3: { defects, findings: 3, pr: '418' } });

  function afterBatch1() {
    const s = setup();
    s.endpoints();
    expect(s.batch(0, 11).code).toBe(0);
    expect(s.preflight().code).toBe(0);
    expect(s.batch(1, 11).code).toBe(0);
    s.writeScores(1, { 'gpt-5.6-sol': draws(['D1', 'D2', 'D3']), 'gpt-5.6-sol@gpt-5.5': draws(['D1', 'D2']) });
    return s;
  }
  let report;
  let lines;
  beforeAll(() => {
    report = afterBatch1().report();
    lines = report.stdout.split('\n');
  }, 60000);

  it('exits 0', () => {
    expect([report.code, report.stderr]).toEqual([0, '']);
  });

  it('prints the row of the pair, with the concrete misses and the published union', () => {
    expect(lines.slice(6, 8)).toEqual([
      '| label | route | pair | draws | per draw | median | union | missed (find) | published | published union | missed (published) | #930 | refuted | errors | paid | production | flags |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ]);
    expect(lines[8]).toBe('| gpt-5.6-sol | openai | gpt-5.6-sol + gpt-5.5 | 3 | 3/3/3 | 3 | 3 | D4, D5 | 2 | D1, D2 | D3, D4, D5 | - | 0 | 0% | $0.49 | $0.09 |  |');
  });

  it('prints a finder with no judge as such', () => {
    expect(lines).toContain('| grok-build-0.1 | openrouter | x-ai/grok-build-0.1 (no judge yet) | 0 |  | - | 0 | - | - | - | - | - | - | - | $0.01 | - | composite |');
  });

  it('names the pair in the admission', () => {
    expect(lines).toContain('- gpt-5.6-sol + gpt-5.5: corpus has 0 PRs, needs 3; 0 published findings on the corpus, needs 3; judge consensus unknown of 15, needs 14');
  });

  it('lists the items of stage 2 with their estimates', () => {
    expect(lines).toContain('## Stage 2, with what the plan estimates');
    expect(lines).toContain('| 2 | corpus: the baseline | $1.34 |');
    expect(lines).toContain('| 5 | generic prompts: the baseline on #418 and the corpus | $2.69 |');
  });

  it('says whether the executor is visible', () => {
    expect(lines).toContain('## Is the executor visible');
    expect(lines).toContain('call.provider names the host on 2 of 19 calls: StubHost');
  });

  it('gives the reads per written token against the threshold', () => {
    expect(lines).toContain('## Reads per written token, against the threshold of 0.28');
    expect(lines).toContain('- all calls: 2400 read, 4000 written: 0.60, the write pays for itself');
    expect(lines).toContain('- #688: 2400 read, 4000 written: 0.60, the write pays for itself');
  });

  it('counts the thinking check on the Anthropic models only', () => {
    expect(lines).toContain('thinking looks on (3 calls)');
  });
});

describe('the paths', () => {
  it('keeps every file of a run under --out-root', () => {
    const s = setup();
    expect(s.funnel('--note-spend', '0.5', '--reason', 'by hand').code).toBe(0);
    expect(readdirSync(join(s.out, 'docs', 'eval', '2026-11', 'records'))).toEqual(['manual.jsonl']);
  });
});
