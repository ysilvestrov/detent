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

describe('anonymize.mjs', () => {
  const clean = { defects: ['D1'], findings: 1 };

  /** Batch 1 run and anonymized; `scores` gives every item the same score. */
  function anonymized() {
    const s = setup();
    expect(s.preflight().code).toBe(0);
    expect(s.batch(1, 11).code).toBe(0);
    const items = join(s.dir, 'items.json');
    expect(s.anonymize('--batch', '1', '--out', items).code).toBe(0);
    const ids = JSON.parse(readFileSync(items, 'utf8')).map((item) => item.id);
    const scores = join(s.dir, 'scores.json');
    const write = (value) => writeFileSync(scores, JSON.stringify(value));
    write(Object.fromEntries(ids.map((id) => [id, clean])));
    return { ...s, ids, scores, write, items };
  }

  it('refuses a second anonymize against the same key, and names --key', () => {
    const s = anonymized();
    const result = s.anonymize('--batch', '1', '--out', s.items);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pass another --key');
  });

  it('writes another key when given --key', () => {
    const s = anonymized();
    expect(s.anonymize('--batch', '1', '--out', s.items, '--key', join(s.dir, 'second.json')).code).toBe(0);
  });

  it('applies, and then refuses to overwrite the scores unless --force', () => {
    const s = anonymized();
    expect(s.anonymize('--apply', s.scores, '--batch', '1').code).toBe(0);
    writeFileSync(s.scoresFile(1), '{"owner":"corrected"}');
    const refused = s.anonymize('--apply', s.scores, '--batch', '1');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--force');
    expect(readFileSync(s.scoresFile(1), 'utf8')).toBe('{"owner":"corrected"}');
    expect(s.anonymize('--apply', s.scores, '--batch', '1', '--force').code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(s.scoresFile(1), 'utf8'))).sort()).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol@gpt-5.5']);
  });

  it('refuses a key of another batch', () => {
    const s = anonymized();
    const result = s.anonymize('--apply', s.scores, '--batch', '2', '--key', s.keyFile(1));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('the key is of batch 1, not batch 2');
  });

  it('refuses scores that skip an item, naming it', () => {
    const s = anonymized();
    s.write(Object.fromEntries(s.ids.slice(1).map((id) => [id, clean])));
    const result = s.anonymize('--apply', s.scores, '--batch', '1');
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`anonymize: no score for ${s.ids[0]}\n`);
  });

  it('refuses a malformed item, naming it', () => {
    const s = anonymized();
    s.write(Object.fromEntries(s.ids.map((id) => [id, { defects: 'D1', findings: 1 }])));
    const result = s.anonymize('--apply', s.scores, '--batch', '1');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^anonymize: item [0-9a-f-]+: defects must be a list of strings\n$/);
  });
});

describe('the owner sequence, batch 0 to the report', () => {
  const s = setup();
  const STEP_MS = 60000;
  const defects = (...ids) => ({ defects: ids, findings: 3 });
  const counts = (real) => ({ real, false: 0, unfalsifiable: 0, published: real });
  const selection = ['--labels'];
  const toOpenai = ['--verify-model', 'gpt-5.5', '--verify-route', 'openai'];

  /** The blind grader, with `score(entry)` looking the answer up in the key; what the real one never sees. */
  function grade(n, score) {
    const items = join(s.dir, `items-${n}.json`);
    expect(s.anonymize('--batch', String(n), '--out', items).code).toBe(0);
    const key = JSON.parse(readFileSync(s.keyFile(n), 'utf8'));
    const graded = Object.fromEntries(JSON.parse(readFileSync(items, 'utf8')).map((item) => [item.id, score(key[item.id])]));
    const file = join(s.dir, `graded-${n}.json`);
    writeFileSync(file, JSON.stringify(graded));
    expect(s.anonymize('--apply', file, '--batch', String(n)).code).toBe(0);
  }
  const byLabel = (table) => (entry) => table[entry.label];
  const byPr = (table) => (entry) => table[entry.pr];
  const runLines = (n) => s.records(n).filter((line) => line.type === 'run');

  it('pins the hosts', () => {
    expect(s.endpoints().code).toBe(0);
    expect(row(s.catalog(), 'qwen3.8-flash').only).toEqual(['alibaba']);
  }, STEP_MS);

  it('batch 0: a model that answers empty fails the batch', () => {
    s.control({ fail: ['qwen3.8-flash|895|1'] });
    expect(s.batch(0, 11).code).toBe(5);
  }, STEP_MS);

  it('batch 0: the retry runs it on another host, as attempt 2, and nothing else', () => {
    s.control({ unparseable: ['grok-build-0.1|418|2'], verdicts: { 'qwen3.8-flash|gpt-5.5': ['confirmed', 'refuted'], 'claude-opus-5-5|gpt-5.5': ['refuted', 'refuted', 'confirmed'], 'gpt-6-astra|gpt-5.5': ['confirmed', 'error'] } });
    expect(s.endpoints('--labels', 'qwen3.8-flash', '--exclude-host', 'alibaba').code).toBe(0);
    expect(s.batch(0, 11).code).toBe(0);
    expect(runLines(0).filter((line) => line.label === 'qwen3.8-flash').map((line) => [line.attempt, line.exit, line.only.find])).toEqual([
      [1, 5, ['alibaba']],
      [2, 0, ['other']],
    ]);
    expect(runLines(0).filter((line) => line.mode === 'verify').map((line) => [line.pr, line.expectFailure])).toEqual([['688', true]]);
  }, STEP_MS);

  it('batch 1 waits for the preflight', () => {
    expect(s.batch(1, 11).code).toBe(2);
    expect(s.preflight().code).toBe(0);
    expect(s.batch(1, 11).code).toBe(0);
    grade(1, byLabel({ 'gpt-5.6-sol': defects('D1', 'D2', 'D3'), 'gpt-5.6-sol@gpt-5.5': defects('D1', 'D2') }));
  }, STEP_MS);

  it('batch 2: a broken answer fails its run', () => {
    expect(s.batch(2, 11).code).toBe(5);
    grade(2, byLabel({ 'claude-haiku-5-5': defects('D1', 'D2', 'D3'), 'qwen3.8-flash': defects('D1', 'D2', 'D3'), 'grok-build-0.1': defects('D1') }));
  }, STEP_MS);

  it('batch 4 needs the scores of batch 3', () => {
    expect(s.batch(4, 11, ...selection, 'gpt-6.1-sol').code).toBe(2);
    expect(s.batch(3, 11).code).toBe(0);
    grade(3, byLabel({ 'gpt-6.1-terra': defects('D1'), 'gpt-6.1-sol': defects('D1', 'D2'), 'claude-sonnet-5-5': defects('D1', 'D2') }));
  }, STEP_MS);

  it('batch 4 takes only those who survived batch 3', () => {
    const refused = s.batch(4, 11, ...selection, 'gpt-6.1-terra');
    expect([refused.code, refused.stderr]).toEqual([2, 'batch 4: gpt-6.1-terra did not survive batch 3\n']);
    expect(s.batch(4, 11, ...selection, 'gpt-6.1-sol,claude-sonnet-5-5').code).toBe(0);
    grade(4, byLabel({ 'gpt-6.1-sol': defects('D1', 'D2', 'D3'), 'claude-sonnet-5-5': defects('D1', 'D2', 'D3') }));
  }, STEP_MS);

  it('batch 5 and batch 6: the unstable one gets no third draw', () => {
    expect(s.batch(5, 11).code).toBe(0);
    const scores = { 'claude-opus-5-5': { 1: defects('D1', 'D2'), 2: defects('D1', 'D2') }, 'gpt-6-astra': { 1: defects('D1', 'D2'), 2: defects('D1', 'D2', 'D3', 'D4') } };
    grade(5, (entry) => scores[entry.label][entry.draw]);
    const refused = s.batch(6, 11, ...selection, 'gpt-6-astra');
    expect([refused.code, refused.stderr]).toEqual([2, 'batch 6: gpt-6-astra did not survive batch 5\n']);
    expect(s.batch(6, 11, ...selection, 'claude-opus-5-5').code).toBe(0);
    grade(6, byLabel({ 'claude-opus-5-5': defects('D1', 'D2', 'D3', 'D4') }));
  }, STEP_MS);

  it('batch 7 goes round by round, and a verify with an error verdict fails its run', () => {
    const result = s.batch(7, 11, ...selection, 'gpt-6.1-sol,qwen3.8-flash,claude-sonnet-5-5,claude-opus-5-5,gpt-6-astra');
    expect(result.code).toBe(5);
    expect(result.stdout).toContain('skip 7|verify|gpt-6-astra|418|3|gpt-5.5: the find of gpt-6-astra/418/3 never ran');
    expect(result.stdout).toContain('batch 7: done 12, failed 2, left 0, not applicable 1');
    expect(runLines(7).map((line) => line.draw)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3]);
    grade(7, byLabel({ 'gpt-6.1-sol': defects('D1', 'D2'), 'qwen3.8-flash': defects('D1', 'D2'), 'claude-sonnet-5-5': defects('D1', 'D2'), 'claude-opus-5-5': defects('D1', 'D2') }));
  }, STEP_MS);

  it('batch 101: an OpenRouter finalist runs with the gpt-5.5 judge on the judge host', () => {
    const refused = s.batch(101, 16, ...selection, 'qwen3.8-flash,gpt-6.1-sol', ...toOpenai);
    expect(refused.code).toBe(2);
    expect(s.batch(101, 16, ...selection, 'qwen3.8-flash', '--verify-model', 'openai/gpt-5.5', '--verify-route', 'openrouter').code).toBe(0);
    expect(s.batch(101, 16, ...selection, 'gpt-6.1-sol', ...toOpenai).code).toBe(0);
    expect(runLines(101).filter((line) => line.label === 'qwen3.8-flash' && line.draw === 1).map((line) => line.only)).toEqual([{ find: ['other'], verify: ['openai'] }]);
    grade(101, byLabel({ 'gpt-5.6-sol': defects('D1'), 'qwen3.8-flash': defects('D1'), 'gpt-6.1-sol': defects('D1', 'D2') }));
  }, STEP_MS);

  it('batches 102 and 103: the corpus', () => {
    expect(s.batch(102, 16).code).toBe(0);
    grade(102, () => counts(1));
    expect(s.batch(103, 16, ...selection, 'gpt-6.1-sol', ...toOpenai).code).toBe(0);
    expect(s.batch(103, 16, ...selection, 'claude-sonnet-5-5', '--verify-model', 'claude-sonnet-5-5', '--verify-route', 'anthropic').code).toBe(0);
    grade(103, byLabel({ 'gpt-6.1-sol': counts(2), 'claude-sonnet-5-5': counts(1) }));
  }, STEP_MS);

  it('batch 104: the judges on the same inputs', () => {
    expect(s.batch(104, 16, '--judges', 'claude-sonnet-5-5:anthropic,gpt-6.1-sol:openai', ...selection, 'gpt-6.1-sol').code).toBe(0);
    grade(104, byLabel({
      'gpt-5.6-sol@claude-sonnet-5-5': defects('D1'),
      'gpt-5.6-sol@gpt-6.1-sol': defects('D1'),
      'gpt-6.1-sol@claude-sonnet-5-5': defects('D1'),
      'gpt-6.1-sol@gpt-6.1-sol': defects('D1'),
    }));
  }, STEP_MS);

  it('batch 105 needs the dirty tree allowed', () => {
    writeFileSync(join(s.repo, 'untracked.txt'), 'x');
    expect(s.batch(105, 16).code).toBe(2);
    expect(s.batch(105, 16, '--allow-dirty').code).toBe(0);
    grade(105, byPr({ 418: defects('D1'), 344: counts(1), 348: counts(1), 352: counts(1) }));
    unlinkSync(join(s.repo, 'untracked.txt'));
  }, STEP_MS);

  it('batch 106: two pairs of one finder both run', () => {
    expect(s.batch(106, 16, ...selection, 'claude-sonnet-5-5', '--verify-model', 'claude-haiku-5-5', '--verify-route', 'anthropic').code).toBe(0);
    expect(s.batch(106, 16, ...selection, 'claude-sonnet-5-5', '--verify-model', 'claude-sonnet-5-5', '--verify-route', 'anthropic').code).toBe(0);
    expect(runLines(106).length).toBe(6);
    grade(106, byLabel({ 'claude-sonnet-5-5@claude-haiku-5-5': defects('D1', 'D2', 'D3', 'D4', 'D5'), 'claude-sonnet-5-5@claude-sonnet-5-5': defects('D1', 'D2', 'D3', 'D4') }));
  }, STEP_MS);

  describe('the report', () => {
    let lines;
    let rows;
    const pairOf = (pair) => rows.find((r) => r.pair === pair);

    beforeAll(() => {
      expect(s.funnel('--note-spend', '0.5', '--reason', 'verify-corpus').code).toBe(0);
      const scoresDir = dirname(s.scoresFile(1));
      const judges = { 'gpt-5.5': 15, 'claude-haiku-5-5': 15, 'claude-sonnet-5-5': 14, 'gpt-6.1-sol': 13 };
      writeFileSync(join(scoresDir, 'judges.json'), JSON.stringify(judges));
      const catalog = s.catalog();
      row(catalog, 'gpt-6.1-terra').dropped = 'one defect of five';
      s.writeCatalog(catalog);
      const result = s.report();
      expect([result.code, result.stderr]).toEqual([0, '']);
      lines = result.stdout.split('\n');
      const recordsDir = join(s.out, 'docs', 'eval', '2026-11', 'records');
      const byNumber = (a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10);
      const records = readdirSync(recordsDir).filter((name) => name.startsWith('batch-')).sort(byNumber).flatMap((name) => parseRecords(readFileSync(join(recordsDir, name), 'utf8')));
      const batches = Object.fromEntries(readdirSync(scoresDir).filter((name) => name.startsWith('batch-')).map((name) => [name.slice(6, -5), JSON.parse(readFileSync(join(scoresDir, name), 'utf8'))]));
      rows = summarize({ lines: records, catalog: s.catalog(), scores: { batches, judges }, cacheRuleApplies: false });
    }, STEP_MS);

    it('prints the rows of one finder with each of its judges', () => {
      expect(lines).toContain('| claude-sonnet-5-5 | anthropic | claude-sonnet-5-5 + gpt-5.5 | 3 | 2/3/3 | 3 | 3 | D4, D5 | 2 | D1, D2 | D3, D4, D5 | - | 0 | 0% | $0.46 | $0.05 |  |');
      expect(lines).toContain('| claude-sonnet-5-5 | anthropic | claude-sonnet-5-5 + claude-haiku-5-5 | 3 | 2/3/3 | 3 | 3 | D4, D5 | 5 | D1, D2, D3, D4, D5 | none | - | 0 | 0% | $0.39 | $0.03 |  |');
      expect(lines).toContain('| qwen3.8-flash | openrouter | qwen/qwen3.8-flash + gpt-5.5 | 3 | 3/3/3 | 3 | 3 | D4, D5 | 2 | D1, D2 | D3, D4, D5 | - | 1 | 0% | $0.10 | $0.03 |  |');
      expect(lines).toContain('| qwen3.8-flash | openrouter | qwen/qwen3.8-flash + openai/gpt-5.5 | 3 | 3/3/3 | 3 | 3 | D4, D5 | - | - | - | 1 | 0 | 0% | $0.10 | $0.00 |  |');
    });

    it('keeps batch 105 its own row', () => {
      expect(lines).toContain('| gpt-5.6-sol (generic prompts) | openai | gpt-5.6-sol + gpt-5.5 | 0 |  | - | 0 | - | 1 | D1 | D2, D3, D4, D5 | - | 0 | 0% | $0.50 | $0.09 |  |');
    });

    it('gives every row exactly the pairs that were run', () => {
      expect(rows.map((r) => r.pair)).toEqual([
        'gpt-5.6-sol + gpt-5.5',
        'gpt-5.6-sol + claude-sonnet-5-5',
        'gpt-5.6-sol + gpt-6.1-sol',
        'claude-haiku-5-5 (no judge yet)',
        'qwen/qwen3.8-flash + gpt-5.5',
        'qwen/qwen3.8-flash + openai/gpt-5.5',
        'x-ai/grok-build-0.1 (no judge yet)',
        'gpt-6.1-terra (no judge yet)',
        'gpt-6.1-sol + gpt-5.5',
        'gpt-6.1-sol + claude-sonnet-5-5',
        'gpt-6.1-sol + gpt-6.1-sol',
        'claude-sonnet-5-5 + gpt-5.5',
        'claude-sonnet-5-5 + claude-sonnet-5-5',
        'claude-sonnet-5-5 + claude-haiku-5-5',
        'claude-opus-5-5 + gpt-5.5',
        'gpt-6-astra + gpt-5.5',
        'gpt-5.6-sol + gpt-5.5',
      ]);
    });

    it('fills every field of the baseline pair', () => {
      const r = pairOf('gpt-5.6-sol + gpt-5.5');
      expect({ ...r, paidUsd: Number(r.paidUsd.toFixed(4)), productionUsd: Number(r.productionUsd.toFixed(4)) }).toEqual({
        label: 'gpt-5.6-sol',
        generic: false,
        route: 'openai',
        tier: null,
        dropped: false,
        judge: 'gpt-5.5',
        pair: 'gpt-5.6-sol + gpt-5.5',
        draws: 3,
        perDraw: [3, 3, 3],
        medianKnown: 3,
        union: 3,
        findDefects: ['D1', 'D2', 'D3'],
        missedFind: ['D4', 'D5'],
        unstable: false,
        medianPublished: 2,
        publishedDefects: ['D1', 'D2'],
        missedPublished: ['D3', 'D4', 'D5'],
        refutedMean: 0,
        errorShare: 0,
        paidUsd: 0.9925,
        productionUsd: 0.094,
        judgeUsd: 0.024,
        composite: false,
        corpus: { real: 3, false: 0, unfalsifiable: 0, published: 3, prs: 3 },
        corpusFrom: null,
        judgeConsensus: 15,
        brokenCalls: 0,
        medianRecall930: 1,
      });
    });

    it('counts a broken call and a broken answer', () => {
      expect([pairOf('qwen/qwen3.8-flash + gpt-5.5').brokenCalls, pairOf('x-ai/grok-build-0.1 (no judge yet)').brokenCalls]).toEqual([1, 1]);
    });

    it('marks the failed verifies of a pair', () => {
      const r = pairOf('gpt-6-astra + gpt-5.5');
      expect([r.errorShare, r.composite, r.brokenCalls, r.medianPublished, r.unstable, r.tier]).toEqual([0.5, true, 2, null, true, 'expensive']);
    });

    it('takes the batch 104 pair with its consensus', () => {
      const r = pairOf('gpt-6.1-sol + gpt-6.1-sol');
      expect([r.medianPublished, r.composite, r.judgeConsensus]).toEqual([1, false, 13]);
    });

    it('counts the corpus of the pair that ran it, and lends it to the other pairs of the finder', () => {
      const own = { real: 6, false: 0, unfalsifiable: 0, published: 6, prs: 3 };
      const ran = pairOf('gpt-6.1-sol + gpt-5.5');
      const heir = pairOf('gpt-6.1-sol + gpt-6.1-sol');
      expect([ran.corpus, ran.corpusFrom, heir.corpus, heir.corpusFrom]).toEqual([own, null, own, 'gpt-5.5']);
    });

    it('admits sonnet + haiku at 5/5 on the corpus sonnet ran under another judge, with the consensus of haiku', () => {
      const r = pairOf('claude-sonnet-5-5 + claude-haiku-5-5');
      expect([r.medianPublished, r.judgeConsensus, r.corpusFrom, r.composite]).toEqual([5, 15, 'claude-sonnet-5-5', false]);
      expect(lines).toContain('- claude-sonnet-5-5 + claude-haiku-5-5: admitted');
    });

    it('leads anthropic with a note on the inherited corpus, preliminary only for #930', () => {
      expect(lines).toContain("| best of the best | claude-sonnet-5-5 + claude-haiku-5-5 (preliminary) - no #930 yet; corpus counts from the finder's run with claude-sonnet-5-5 |");
    });

    it('leaves the expensive tier and the refuted out of the profiles', () => {
      const anthropic = lines.slice(lines.indexOf('### anthropic'), lines.indexOf('### openrouter'));
      expect(anthropic.filter((line) => line.startsWith('| best') || line.startsWith('| balanced')).join('\n')).not.toContain('claude-opus-5-5');
    });

    it('flags a dropped candidate, whose earlier calls stay priced', () => {
      expect(lines).toContain('| gpt-6.1-terra | openai | gpt-6.1-terra (no judge yet) | 1 | 1 | 1 | 1 | D2, D3, D4, D5 | - | - | - | - | - | - | $0.03 | $0.01 | composite, dropped |');
    });

    it('prints the manual spend', () => {
      expect(lines).toContain('- manual: $0.50');
    });
  });
});

describe('the paths', () => {
  it('keeps every file of a run under --out-root', () => {
    const s = setup();
    expect(s.funnel('--note-spend', '0.5', '--reason', 'by hand').code).toBe(0);
    expect(readdirSync(join(s.out, 'docs', 'eval', '2026-11', 'records'))).toEqual(['manual.jsonl']);
  });
});
