import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRecords } from './records.mjs';
import { childArgs, childEnv, proxyRefusal, runBatch, runPreflight } from './runner.mjs';

const KEY = 'sk-or-abcdefghijklmnopqrstuvwxyz0123456789';
const keys = { OPENROUTER_API_KEY: KEY, OPENAI_API_KEY: 'sk-openai-0123456789abcdefghij', ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdefghij' };
const base = { PATH: '/bin', HOME: '/home/u', GH_TOKEN: 'gh-token', NODE_OPTIONS: '--require /evil.js', OPENAI_API_KEY: 'from-base' };
const catalog = { baseline: {}, candidates: [], prices: {}, prs: {}, corpus: [], recallPrs: [] };

const run = (over = {}) => ({
  batch: 3,
  label: 'a',
  draw: 1,
  pr: '418',
  head: '584aa661',
  mode: 'find',
  findModel: 'm-find',
  verifyModel: null,
  route: 'openrouter',
  only: { find: ['alibaba'], verify: null },
  cacheOffModels: null,
  from: null,
  expectFailure: false,
  estimateUsd: 0.2,
  ...over,
});
const verifyOfA = (over = {}) =>
  run({ mode: 'verify', route: 'openai', verifyModel: 'gpt-5.5', only: { find: null, verify: null }, from: { label: 'a', pr: '418', draw: 1 }, ...over });

const callLine = (cost, stage = 'find', over = {}) => ({
  type: 'call',
  runId: 'r1',
  stage,
  id: 'g1',
  model: 'm-find-20260101',
  provider: 'Alibaba',
  finishReason: 'stop',
  contentLength: 10,
  usage: { cost },
  ...over,
});
const runLine = (over = {}) => ({ type: 'run', runId: 'r1', batch: 3, label: 'a', provider: 'openrouter', pr: '418', draw: 1, exit: 0, error: null, ...over });
const jsonl = (...lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');
const ok = (cost = 0.1, { record = jsonl(callLine(cost), runLine()), writes = [['--save-findings', '{"v":1}']], ...over } = {}) => ({
  code: 0,
  stdout: 'done\n',
  stderr: '',
  ...over,
  writes: [['--record', record], ...writes],
});
const failedAnswer = () => ok(0.1, { code: 5, record: jsonl(callLine(0.1), runLine({ exit: 5, error: 'boom' })) });

/** A spawnRun that answers from a list, writing what each answer says into the paths of the arguments. */
function stub(answers) {
  const calls = [];
  const spawnRun = async (args, env, cwd) => {
    const answer = answers[calls.length];
    calls.push({ args, env, cwd });
    for (const [flag, text] of answer.writes) writeFileSync(args[args.indexOf(flag) + 1], text);
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr };
  };
  return { spawnRun, calls };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const out = [];
  const common = { catalog, keys, ceilingUsd: 100, recordsDir: join(dir, 'records'), tmpDir: join(dir, 'tmp'), repo: '/repo', base, out: (line) => out.push(line) };
  return { dir, out, common, shared: (n) => join(dir, 'records', `batch-${n}.jsonl`) };
}

describe('childArgs', () => {
  const paths = { record: '/t/r.jsonl', findings: '/t/f.json', verifyFrom: '/t/v.json' };

  it('builds a find', () => {
    expect(childArgs(run(), paths)).toEqual([
      'pr-review', '--replay', '418', '--head', '584aa661', '--provider', 'openrouter', '--record', '/t/r.jsonl', '--find-only', '--save-findings', '/t/f.json',
    ]);
  });

  it('builds a verify that takes head and base from the file', () => {
    expect(childArgs(run({ mode: 'verify', route: 'openai' }), paths)).toEqual([
      'pr-review', '--replay', '418', '--provider', 'openai', '--record', '/t/r.jsonl', '--verify-from', '/t/v.json',
    ]);
  });

  it('builds a whole run', () => {
    expect(childArgs(run({ mode: 'whole', route: 'openai' }), paths)).toEqual([
      'pr-review', '--replay', '418', '--head', '584aa661', '--provider', 'openai', '--record', '/t/r.jsonl',
    ]);
  });

  it('leaves out --head when the PR has none pinned', () => {
    expect(childArgs(run({ head: null, mode: 'whole' }), paths)).toEqual(['pr-review', '--replay', '418', '--provider', 'openrouter', '--record', '/t/r.jsonl']);
  });
});

const REFUSAL = 'a proxy is set, and fetch ignores it without NODE_USE_ENV_PROXY=1: start with NODE_USE_ENV_PROXY=1 node scripts/eval/funnel.mjs ...';

describe('proxyRefusal', () => {
  it('passes with no proxy', () => {
    expect(proxyRefusal({ PATH: '/bin' })).toBe(null);
  });

  it('refuses an upper-case proxy without the setting', () => {
    expect(proxyRefusal({ HTTPS_PROXY: 'http://p:1' })).toBe(REFUSAL);
  });

  it('refuses a lower-case proxy without the setting', () => {
    expect(proxyRefusal({ https_proxy: 'http://p:1' })).toBe(REFUSAL);
  });

  it('refuses an upper-case http proxy without the setting', () => {
    expect(proxyRefusal({ HTTP_PROXY: 'http://p:1' })).toBe(REFUSAL);
  });

  it('refuses a lower-case http proxy without the setting', () => {
    expect(proxyRefusal({ http_proxy: 'http://p:1' })).toBe(REFUSAL);
  });

  it('refuses a setting other than 1', () => {
    expect(proxyRefusal({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '0' })).toBe(REFUSAL);
  });

  it('passes a proxy with the setting', () => {
    expect(proxyRefusal({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' })).toBe(null);
  });
});

describe('childEnv', () => {
  it('hands the proxy to the child, and still no other route key', () => {
    const proxied = {
      ...base,
      HTTP_PROXY: 'http://p:1',
      HTTPS_PROXY: 'http://p:2',
      NO_PROXY: 'localhost',
      http_proxy: 'http://p:3',
      https_proxy: 'http://p:4',
      no_proxy: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      ALL_OTHER: 'not passed',
      OPENAI_API_KEY: 'sk-from-the-shell',
    };
    expect(childEnv(run(), keys, proxied)).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GH_TOKEN: 'gh-token',
      HTTP_PROXY: 'http://p:1',
      HTTPS_PROXY: 'http://p:2',
      NO_PROXY: 'localhost',
      http_proxy: 'http://p:3',
      https_proxy: 'http://p:4',
      no_proxy: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      OPENROUTER_API_KEY: KEY,
      AI_REVIEW_MODEL: 'm-find',
      AI_REVIEW_OPENROUTER_ONLY: 'alibaba',
      AI_REVIEW_RECORD_META: '{"batch":3,"label":"a","draw":1}',
    });
  });

  it('is exact for a pinned openrouter find', () => {
    expect(childEnv(run(), keys, base)).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GH_TOKEN: 'gh-token',
      OPENROUTER_API_KEY: KEY,
      AI_REVIEW_MODEL: 'm-find',
      AI_REVIEW_OPENROUTER_ONLY: 'alibaba',
      AI_REVIEW_RECORD_META: '{"batch":3,"label":"a","draw":1}',
    });
  });

  it('is exact for a whole run with both pins and the cache switch', () => {
    const whole = run({ mode: 'whole', verifyModel: 'm-verify', only: { find: ['a', 'b'], verify: ['c'] }, cacheOffModels: ['m-find', 'm-verify'] });
    expect(childEnv(whole, keys, base)).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GH_TOKEN: 'gh-token',
      OPENROUTER_API_KEY: KEY,
      AI_REVIEW_MODEL: 'm-find',
      AI_REVIEW_VERIFY_MODEL: 'm-verify',
      AI_REVIEW_OPENROUTER_ONLY: 'a,b',
      AI_REVIEW_VERIFY_OPENROUTER_ONLY: 'c',
      AI_REVIEW_CACHE: 'off',
      AI_REVIEW_CACHE_OFF_MODELS: 'm-find,m-verify',
      AI_REVIEW_RECORD_META: '{"batch":3,"label":"a","draw":1}',
    });
  });

  it('gives a verify only the verify model and its own key', () => {
    expect(childEnv(verifyOfA(), keys, base)).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GH_TOKEN: 'gh-token',
      OPENAI_API_KEY: 'sk-openai-0123456789abcdefghij',
      AI_REVIEW_VERIFY_MODEL: 'gpt-5.5',
      AI_REVIEW_RECORD_META: '{"batch":3,"label":"a","draw":1}',
    });
  });
});

describe('runBatch', () => {
  it('stops at the ceiling and says what is left', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok(0.25), ok(0.25)]);
    const result = await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 1 }), run({ draw: 2 })], spawnRun });
    expect(result).toEqual({ code: 3, spentUsd: 0.25, done: 1, failed: 0, left: 1, notApplicable: 0 });
    expect(calls).toHaveLength(1);
  });

  it('holds the reserve back from the ceiling', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([]);
    const result = await runBatch({ ...s.common, ceilingUsd: 3, reserveUsd: 2.9, runs: [run()], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 3, spentUsd: 0, done: 0, failed: 0, left: 1, notApplicable: 0 });
    expect(s.out).toEqual(['stop at the ceiling: spent 0.00 of 3, 2.9 of it held back, 1 run(s) left']);
  });

  it('runs what fits under the ceiling less the reserve', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok(0.1)]);
    await runBatch({ ...s.common, ceilingUsd: 3.5, reserveUsd: 2.9, runs: [run()], spawnRun });
    expect(calls).toHaveLength(1);
  });

  it('keeps the order of the plan', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok(), ok(), ok()]);
    await runBatch({ ...s.common, runs: [run({ label: 'x' }), run({ label: 'y' }), run({ label: 'z' })], spawnRun });
    expect(calls.map((c) => JSON.parse(c.env.AI_REVIEW_RECORD_META).label)).toEqual(['x', 'y', 'z']);
  });

  it('runs the child in the repo', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok()]);
    await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(calls[0].cwd).toBe('/repo');
  });

  it('verifies the file its find just saved', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok(0.25), ok(0.5, { writes: [] })]);
    const result = await runBatch({ ...s.common, runs: [run(), verifyOfA()], spawnRun });
    const saved = join(s.dir, 'records', 'findings', 'b3-a-pr418-d1-a1-find.json');
    expect(calls[1].args[calls[1].args.indexOf('--verify-from') + 1]).toBe(saved);
    expect(readFileSync(saved, 'utf8')).toBe('{"v":1}');
    expect(result).toEqual({ code: 0, spentUsd: 0.75, done: 2, failed: 0, left: 0, notApplicable: 0 });
  });

  it('does not verify after a failed find', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([failedAnswer()]);
    const result = await runBatch({ ...s.common, runs: [run(), verifyOfA()], spawnRun });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ code: 5, spentUsd: 0.1, done: 0, failed: 2, left: 0, notApplicable: 0 });
  });

  it('prints a verify whose find never ran and neither counts it failed nor spends', async () => {
    const s = setup();
    const verify = verifyOfA({ from: { label: 'b', pr: '418', draw: 3 } });
    const { spawnRun, calls } = stub([]);
    const result = await runBatch({ ...s.common, runs: [verify], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 0, spentUsd: 0, done: 0, failed: 0, left: 0, notApplicable: 1 });
    expect(s.out).toEqual(['skip 3|verify|a|418|1|gpt-5.5: the find of b/418/3 never ran']);
  });

  it('counts the calls of a killed child, with a torn last line', async () => {
    const s = setup();
    const killed = { code: 137, stdout: '', stderr: '', writes: [['--record', `${jsonl(callLine(0.1))}{"type":"run","runId":"r1","ba`]] };
    const { spawnRun } = stub([killed]);
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(result).toEqual({ code: 5, spentUsd: 0.1, done: 0, failed: 1, left: 0, notApplicable: 0 });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines[0]).toEqual({ ...callLine(0.1), tempId: expect.any(String), requestedModel: 'm-find', key: '3|find|a|418|1', mode: 'find', attempt: 1, expectFailure: false, findingsFile: null });
    expect(lines[1]).toMatchObject({ type: 'run', exit: 137, error: 'the child ended with exit 137 and wrote no run line', attempt: 1, findingsFile: null });
    expect(lines).toHaveLength(2);
  });

  it('writes the run line with its key, mode, attempt and findings file', async () => {
    const s = setup();
    const { spawnRun } = stub([ok(0.1)]);
    await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8'))).toEqual([
      { ...callLine(0.1), tempId: expect.any(String), requestedModel: 'm-find', key: '3|find|a|418|1', mode: 'find', attempt: 1, expectFailure: false, findingsFile: null },
      { ...runLine(), tempId: expect.any(String), requestedModel: 'm-find', key: '3|find|a|418|1', mode: 'find', attempt: 1, expectFailure: false, findingsFile: 'findings/b3-a-pr418-d1-a1-find.json' },
    ]);
  });

  it('puts the verify model on the calls of the verify stage', async () => {
    const s = setup();
    const whole = run({ mode: 'whole', verifyModel: 'm-verify' });
    const record = jsonl(callLine(0.1, 'find'), callLine(0.2, 'verify', { model: 'm-verify-1' }), runLine());
    const { spawnRun } = stub([ok(0.1, { record, writes: [] })]);
    await runBatch({ ...s.common, runs: [whole], spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines.map((l) => l.requestedModel)).toEqual(['m-find', 'm-verify', 'm-find']);
  });

  it('skips what is done on a second invocation', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok()]).spawnRun });
    const second = stub([]);
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: second.spawnRun });
    expect(second.calls).toHaveLength(0);
    expect(result).toEqual({ code: 0, spentUsd: 0.1, done: 1, failed: 0, left: 0, notApplicable: 0 });
  });

  it('reruns a failed run with a new attempt and a new file', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([failedAnswer()]).spawnRun });
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines.map((l) => [l.type, l.attempt, l.findingsFile])).toEqual([
      ['call', 1, null],
      ['run', 1, null],
      ['call', 2, null],
      ['run', 2, 'findings/b3-a-pr418-d1-a2-find.json'],
    ]);
    expect(readFileSync(join(s.dir, 'records', 'findings', 'b3-a-pr418-d1-a2-find.json'), 'utf8')).toBe('{"v":1}');
    expect(result).toEqual({ code: 0, spentUsd: 0.2, done: 1, failed: 0, left: 0, notApplicable: 0 });
  });

  it('scrubs a leaked key, keeps the spend, stops with 4', async () => {
    const s = setup();
    const leaky = ok(0.1, {
      stdout: `printed ${KEY}\n`,
      record: jsonl(callLine(0.1), runLine({ results: [{ claim: KEY }] })),
      writes: [['--save-findings', `{"claim":"${KEY}"}`]],
    });
    const { spawnRun, calls } = stub([leaky, ok()]);
    const result = await runBatch({ ...s.common, runs: [run({ draw: 1 }), run({ draw: 2 })], spawnRun });
    const text = readFileSync(s.shared(3), 'utf8');
    expect(text.includes(KEY)).toBe(false);
    const lines = parseRecords(text);
    expect(lines[0].usage.cost).toBe(0.1);
    expect(lines[1].results).toEqual([{ claim: '***' }]);
    expect(readFileSync(join(s.dir, 'records', 'findings', 'b3-a-pr418-d1-a1-find.json'), 'utf8')).toBe('{"claim":"***"}');
    expect(s.out.join('\n').includes(KEY)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ code: 4, spentUsd: 0.1, done: 1, failed: 0, left: 1, notApplicable: 0 });
  });

  it('scrubs the start of a key that a cut line left behind', async () => {
    const s = setup();
    const cut = ok(0.1, { record: jsonl(callLine(0.1), runLine({ results: [{ claim: KEY.slice(0, 16) }] })) });
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([cut]).spawnRun });
    expect(readFileSync(s.shared(3), 'utf8').includes(KEY.slice(0, 16))).toBe(false);
    expect(result.code).toBe(4);
  });

  it('passes only the key of the route', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([ok()]);
    await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(Object.keys(calls[0].env).sort()).toEqual([
      'AI_REVIEW_MODEL', 'AI_REVIEW_OPENROUTER_ONLY', 'AI_REVIEW_RECORD_META', 'GH_TOKEN', 'HOME', 'OPENROUTER_API_KEY', 'PATH',
    ]);
  });

  it('refuses a missing key with 2 before any run', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([]);
    const runs = [run({ route: 'openai', only: { find: null, verify: null }, draw: 1 }), run({ draw: 2 })];
    const result = await runBatch({ ...s.common, keys: { OPENAI_API_KEY: 'x' }, runs, spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 2, spentUsd: 0, done: 0, failed: 0, left: 2, notApplicable: 0 });
    expect(s.out).toEqual(['batch 3 needs OPENROUTER_API_KEY in the keys file']);
  });

  it('returns 5 when a run failed', async () => {
    const s = setup();
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([failedAnswer()]).spawnRun });
    expect(result).toEqual({ code: 5, spentUsd: 0.1, done: 0, failed: 1, left: 0, notApplicable: 0 });
  });

  it('writes expectFailure on the run line', async () => {
    const s = setup();
    const record = jsonl(callLine(0.1, 'verify'), runLine({ exit: 0, error: '1 of 1 findings not verified' }));
    const verify = verifyOfA({ from: null, expectFailure: true });
    await runBatch({ ...s.common, runs: [verify], spawnRun: stub([ok(0.1, { record, writes: [] })]).spawnRun });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((l) => [l.type, l.expectFailure])).toEqual([['call', true], ['run', true]]);
  });

  it('writes false on the lines of an ordinary run', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((l) => l.expectFailure)).toEqual([false, false]);
  });

  it('returns 0 when an expected failure failed', async () => {
    const s = setup();
    const record = jsonl(callLine(0.1, 'verify'), runLine({ exit: 0, error: '1 of 1 findings not verified' }));
    const verify = verifyOfA({ from: null, expectFailure: true });
    const result = await runBatch({ ...s.common, runs: [verify], spawnRun: stub([ok(0.1, { record, writes: [] })]).spawnRun });
    expect(result).toEqual({ code: 0, spentUsd: 0.1, done: 1, failed: 0, left: 0, notApplicable: 0 });
  });

  it('counts the spend of every batch against the ceiling', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    writeFileSync(s.shared(1), jsonl(callLine(0.5, 'find', { key: '1|find|z|418|1', attempt: 1 })));
    const { spawnRun, calls } = stub([]);
    const result = await runBatch({ ...s.common, ceilingUsd: 0.8, runs: [run()], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 3, spentUsd: 0.5, done: 0, failed: 0, left: 1, notApplicable: 0 });
  });
});

describe('runPreflight', () => {
  const pcatalog = {
    corpus: ['344', '348', '352'],
    prs: { 344: { head: null }, 348: { head: null }, 352: { head: null }, 356: { head: null }, 418: { head: '584aa661' }, 930: { head: 'a5926a74' } },
  };
  const bigger = { ...pcatalog, corpus: ['344', '348', '352', '356'] };
  const fine = 'Context budget: 0 file(s) sent as diff only.\n';
  const all = { 344: fine, 348: fine, 352: fine, 356: fine, 418: fine, 930: fine };
  /** Answers by PR number, which is the third argument. */
  const answering = (byPr) => {
    const calls = [];
    const spawnRun = async (args, env, cwd) => {
      calls.push({ args, env, cwd });
      return { code: 0, stdout: byPr[args[2]], stderr: '' };
    };
    return { spawnRun, calls };
  };

  it('asks for context only, on the pinned head, with no key', async () => {
    const { spawnRun, calls } = answering(all);
    await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base });
    expect(calls.map((c) => c.args)).toEqual([
      ['pr-review', '--replay', '418', '--head', '584aa661', '--context-only'],
      ['pr-review', '--replay', '344', '--context-only'],
      ['pr-review', '--replay', '348', '--context-only'],
      ['pr-review', '--replay', '352', '--context-only'],
      ['pr-review', '--replay', '930', '--head', 'a5926a74', '--context-only'],
    ]);
    expect(calls[0].env).toEqual({ PATH: '/bin', HOME: '/home/u', GH_TOKEN: 'gh-token' });
    expect(calls[0].cwd).toBe('/repo');
  });

  it('keeps everything when nothing is sent as diff only', async () => {
    const { spawnRun } = answering(all);
    expect(await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base })).toEqual({
      code: 0,
      preflight: { corpus: ['344', '348', '352'], recall930: true, reasons: {} },
      failures: {},
    });
  });

  it('drops a corpus PR whose source file goes as a diff only, and says why', async () => {
    const { spawnRun } = answering({ ...all, 344: 'Context budget: 1 file(s) sent as diff only: src/a.ts\n' });
    expect(await runPreflight({ catalog: bigger, spawnRun, repo: '/repo', base })).toEqual({
      code: 0,
      preflight: { corpus: ['348', '352', '356'], recall930: true, reasons: { 344: 'source file sent as diff only: src/a.ts' } },
      failures: {},
    });
  });

  it('keeps a PR whose only diff-only file is a test', async () => {
    const { spawnRun } = answering({ ...all, 344: 'Context budget: 1 file(s) sent as diff only: src/a.test.ts\n' });
    const result = await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base });
    expect(result.preflight.corpus).toEqual(['344', '348', '352']);
  });

  it('stops with 2 when #418 has a source file as a diff only', async () => {
    const { spawnRun } = answering({ ...all, 418: 'Context budget: 1 file(s) sent as diff only: src/a.ts\n' });
    const result = await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base });
    expect(result.code).toBe(2);
    expect(result.preflight.reasons).toEqual({ 418: 'source file sent as diff only: src/a.ts' });
  });

  it('stops with 2 when fewer than three corpus PRs remain', async () => {
    const { spawnRun } = answering({ ...all, 352: 'no reviewable files\n' });
    const result = await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base });
    expect(result.code).toBe(2);
    expect(result.preflight.corpus).toEqual(['344', '348']);
  });

  it('gives no reviewable files its own reason', async () => {
    const { spawnRun } = answering({ ...all, 344: 'no reviewable files\n' });
    const result = await runPreflight({ catalog: bigger, spawnRun, repo: '/repo', base });
    expect(result.preflight.reasons).toEqual({ 344: 'no reviewable files' });
  });

  it('says recall930 is false when #930 dropped', async () => {
    const { spawnRun } = answering({ ...all, 930: 'Context budget: 2 file(s) sent as diff only: src/a.test.ts, src/b.ts\n' });
    expect(await runPreflight({ catalog: pcatalog, spawnRun, repo: '/repo', base })).toEqual({
      code: 0,
      preflight: { corpus: ['344', '348', '352'], recall930: false, reasons: { 930: 'source file sent as diff only: src/b.ts' } },
      failures: {},
    });
  });
});

describe('runBatch after a failure', () => {
  const noRecord = () => ({ code: 2, stdout: '', stderr: 'usage: no key', writes: [] });

  it('writes a failed run line for a child that left no record, so its verify counts as failed', async () => {
    const s = setup();
    const { spawnRun, calls } = stub([noRecord()]);
    const result = await runBatch({ ...s.common, runs: [run(), verifyOfA()], spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'run', key: '3|find|a|418|1', attempt: 1, exit: 2, error: 'the child ended with exit 2 and wrote no run line', findingsFile: null });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ code: 5, spentUsd: 0, done: 0, failed: 2, left: 0, notApplicable: 0 });
  });

  it('counts a verify of such a find as failed on a later invocation, and reruns the find as attempt 2', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([noRecord()]).spawnRun });
    const later = await runBatch({ ...s.common, runs: [verifyOfA()], spawnRun: stub([]).spawnRun });
    expect(later).toEqual({ code: 5, spentUsd: 0, done: 0, failed: 1, left: 0, notApplicable: 0 });
    const rerun = stub([ok(0.1)]);
    await runBatch({ ...s.common, runs: [run()], spawnRun: rerun.spawnRun });
    const attempts = parseRecords(readFileSync(s.shared(3), 'utf8')).map((l) => [l.type, l.attempt]);
    expect(attempts).toEqual([['run', 1], ['call', 2], ['run', 2]]);
  });

  it('fails a child that exited otherwise than its run line says, and does not keep its findings', async () => {
    const s = setup();
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1, { code: 137 })]).spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines[1]).toMatchObject({ type: 'run', exit: 137, error: 'the child exited 137 after writing a run line with exit 0', findingsFile: null });
    expect(result).toEqual({ code: 5, spentUsd: 0.1, done: 0, failed: 1, left: 0, notApplicable: 0 });
  });

  it('keeps the paid calls around a broken middle line, fails the run and goes on', async () => {
    const s = setup();
    const broken = ok(0.1, { record: `${jsonl(callLine(0.1))}not json\n${jsonl(runLine())}`, writes: [] });
    const { spawnRun, calls } = stub([broken, ok(0.1)]);
    const result = await runBatch({ ...s.common, runs: [run({ draw: 1 }), run({ draw: 2 })], spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines.map((l) => [l.type, l.attempt, l.error])).toEqual([
      ['call', 1, undefined],
      ['run', 1, 'the record had an unreadable line'],
      ['call', 1, undefined],
      ['run', 1, null],
    ]);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ code: 5, spentUsd: 0.2, done: 1, failed: 1, left: 0, notApplicable: 0 });
  });

  it('appends the paid lines before the findings copy, and a failed copy is a failed run', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'records', 'findings', 'b3-a-pr418-d1-a1-find.json'), { recursive: true });
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines[0].usage.cost).toBe(0.1);
    expect(lines[1].exit).toBe(0);
    expect(lines[1].error).toMatch(/^findings copy failed: /);
    expect(lines[1].findingsFile).toBe(null);
    expect(result).toEqual({ code: 5, spentUsd: 0.1, done: 0, failed: 1, left: 0, notApplicable: 0 });
  });

  it('starts an append on a new line when the shared file does not end in one', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    writeFileSync(s.shared(3), '{"type":"manual","usd":0.05}');
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((l) => l.type)).toEqual(['manual', 'call', 'run']);
    expect(result.spentUsd).toBe(0.15000000000000002);
  });
});

describe('runBatch with an orphaned temp record', () => {
  const meta = {
    key: '3|find|a|418|1',
    mode: 'find',
    attempt: 1,
    batch: 3,
    label: 'a',
    pr: '418',
    draw: 1,
    route: 'openrouter',
    models: { find: 'm-find', verify: null },
    expectFailure: false,
  };

  function orphan(s) {
    mkdirSync(s.common.tmpDir, { recursive: true });
    writeFileSync(join(s.common.tmpDir, 'dead.meta.json'), JSON.stringify(meta));
    writeFileSync(join(s.common.tmpDir, 'dead.jsonl'), jsonl(callLine(0.3)));
  }

  it('adopts it before the first admit, so its spend counts', async () => {
    const s = setup();
    orphan(s);
    const { spawnRun, calls } = stub([]);
    const result = await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 3, spentUsd: 0.3, done: 0, failed: 0, left: 1, notApplicable: 0 });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8'))).toMatchObject([
      { type: 'call', key: '3|find|a|418|1', attempt: 1, requestedModel: 'm-find', findingsFile: null },
      { type: 'run', key: '3|find|a|418|1', attempt: 1, exit: 1, error: 'the funnel stopped before this run was absorbed', findingsFile: null },
    ]);
  });

  it('counts it once, however many invocations follow', async () => {
    const s = setup();
    orphan(s);
    await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun: stub([]).spawnRun });
    const again = await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun: stub([]).spawnRun });
    expect(again.spentUsd).toBe(0.3);
    expect(readdirSync(s.common.tmpDir).filter((name) => name.endsWith('.absorbed'))).toEqual(['dead.absorbed']);
  });

  it('puts the id of the temp record on every line', async () => {
    const s = setup();
    orphan(s);
    await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun: stub([]).spawnRun });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((line) => line.tempId)).toEqual(['dead', 'dead']);
  });

  it('counts a run once after a crash between its append and its marker', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    const [marker] = readdirSync(s.common.tmpDir).filter((name) => name.endsWith('.absorbed'));
    renameSync(join(s.common.tmpDir, marker), join(s.common.tmpDir, 'never-written'));
    const next = stub([]);
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun: next.spawnRun });
    expect(next.calls).toHaveLength(0);
    expect(result).toEqual({ code: 0, spentUsd: 0.1, done: 1, failed: 0, left: 0, notApplicable: 0 });
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((line) => line.type)).toEqual(['call', 'run']);
  });

  it('adds only the run line after a crash between the calls and the run line', async () => {
    const s = setup();
    orphan(s);
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    writeFileSync(s.shared(3), jsonl({ ...callLine(0.3), tempId: 'dead', key: '3|find|a|418|1', attempt: 1 }));
    const result = await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun: stub([]).spawnRun });
    expect(result.spentUsd).toBe(0.3);
    expect(parseRecords(readFileSync(s.shared(3), 'utf8')).map((line) => [line.type, line.tempId])).toEqual([['call', 'dead'], ['run', 'dead']]);
  });

  it('does not take a line of another temp record for its own', async () => {
    const s = setup();
    orphan(s);
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    writeFileSync(s.shared(3), jsonl({ ...callLine(0.1), tempId: 'other', key: '3|find|a|418|1', attempt: 1 }));
    const result = await runBatch({ ...s.common, ceilingUsd: 0.6, runs: [run({ draw: 2 })], spawnRun: stub([]).spawnRun });
    expect(result.spentUsd).toBe(0.4);
  });

  it('leaves the files of an absorbed run alone', async () => {
    const s = setup();
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    const files = readdirSync(s.common.tmpDir);
    expect(files.filter((name) => name.endsWith('.absorbed'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.meta.json'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
  });
});

describe('runBatch checks and warnings', () => {
  it('scrubs only the provider keys, so another value in the keys file corrupts nothing', async () => {
    const s = setup();
    const result = await runBatch({ ...s.common, keys: { ...keys, FOO: '1' }, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    expect(result.code).toBe(0);
    expect(parseRecords(readFileSync(s.shared(3), 'utf8'))[0].contentLength).toBe(10);
  });

  it('warns about a paid response with no usage', async () => {
    const s = setup();
    const record = jsonl(callLine(0.1, 'find', { usage: undefined }), runLine());
    await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1, { record })]).spawnRun });
    expect(s.out).toContain('warning: 1 call line(s) have no usage or no price; they count as 0 against the ceiling');
  });

  it('refuses with 2, naming the file and the line, when a shared record is broken', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    writeFileSync(s.shared(1), '{"type":"manual","usd":1}\nnot json\n{"type":"manual","usd":1}\n');
    const { spawnRun, calls } = stub([]);
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 2, spentUsd: 0, done: 0, failed: 0, left: 1, notApplicable: 0 });
    expect(s.out).toHaveLength(1);
    expect(s.out[0]).toMatch(/^batch-1\.jsonl: records: line 2 is not JSON/);
  });
});

describe('runPreflight when a check fails', () => {
  const pcatalog = {
    corpus: ['344', '348', '352'],
    prs: { 344: { head: null }, 348: { head: null }, 352: { head: null }, 418: { head: '584aa661' }, 930: { head: 'a5926a74' } },
  };
  const fine = 'Context budget: 0 file(s) sent as diff only.\n';
  const answer = (code, stdout, stderr = '') => ({ code, stdout, stderr });
  const byPr = (answers) => async (args) => answers[args[2]];

  it('returns 5 and names the PR when a corpus PR crashed, without dropping it as a drop', async () => {
    const answers = { 418: answer(0, fine), 344: answer(0, fine), 348: answer(1, '', 'x\ngh: network down\n'), 352: answer(0, fine), 930: answer(0, fine) };
    expect(await runPreflight({ catalog: pcatalog, spawnRun: byPr(answers), repo: '/repo', base })).toEqual({
      code: 5,
      preflight: { corpus: ['344', '352'], recall930: true, reasons: {} },
      failures: { 348: 'context check exited 1: x | gh: network down' },
    });
  });

  it('returns 5 when a check printed no budget line', async () => {
    const answers = { 418: answer(0, fine), 344: answer(0, fine), 348: answer(0, fine), 352: answer(0, fine), 930: answer(0, 'something else\n') };
    const result = await runPreflight({ catalog: pcatalog, spawnRun: byPr(answers), repo: '/repo', base });
    expect(result.code).toBe(5);
    expect(result.failures).toEqual({ 930: 'context check printed no budget line' });
  });

  it('scrubs a key out of the stderr it passes on', async () => {
    const answers = { 418: answer(1, '', `bad ${KEY}`), 344: answer(0, fine), 348: answer(0, fine), 352: answer(0, fine), 930: answer(0, fine) };
    const result = await runPreflight({ catalog: pcatalog, spawnRun: byPr(answers), repo: '/repo', base, keys });
    expect(result.failures).toEqual({ 418: 'context check exited 1: bad ***' });
  });
});

describe('runBatch with a torn or breaking shared record', () => {
  it('refuses with 2 before any spawn when a shared file ends in a torn line, and leaves the file alone', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'records'), { recursive: true });
    const torn = `${jsonl(callLine(0.1))}{"type":"call","runId":"r0","us`;
    writeFileSync(s.shared(3), torn);
    const { spawnRun, calls } = stub([ok()]);
    const result = await runBatch({ ...s.common, runs: [run()], spawnRun });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ code: 2, spentUsd: 0, done: 0, failed: 0, left: 1, notApplicable: 0 });
    expect(s.out).toEqual(['batch-3.jsonl: the last line is torn; remove it by hand, then run the batch again']);
    expect(readFileSync(s.shared(3), 'utf8')).toBe(torn);
  });

  it('ends in 5, not a throw, when a shared file breaks after the first run', async () => {
    const s = setup();
    const corrupting = async (args, env, cwd) => {
      mkdirSync(join(s.dir, 'records'), { recursive: true });
      writeFileSync(s.shared(3), 'junk\n{"type":"manual","usd":0}\n');
      return stub([ok()]).spawnRun(args, env, cwd);
    };
    const result = await runBatch({ ...s.common, runs: [run({ draw: 1 }), run({ draw: 2 })], spawnRun: corrupting });
    expect(result).toEqual({ code: 5, spentUsd: 0, done: 0, failed: 1, left: 1, notApplicable: 0 });
    expect(s.out.at(-1)).toMatch(/^batch-3\.jsonl: records: line 1 is not JSON/);
  });

  it('ends in 5 when spawnRun rejects, and the next invocation adopts the run and retries it as attempt 2', async () => {
    const s = setup();
    const rejecting = async () => {
      throw new Error('spawn node ENOENT');
    };
    const first = await runBatch({ ...s.common, runs: [run()], spawnRun: rejecting });
    expect(first).toEqual({ code: 5, spentUsd: 0, done: 0, failed: 1, left: 0, notApplicable: 0 });
    const second = await runBatch({ ...s.common, runs: [run()], spawnRun: stub([ok(0.1)]).spawnRun });
    expect(second).toEqual({ code: 0, spentUsd: 0.1, done: 1, failed: 0, left: 0, notApplicable: 0 });
    const lines = parseRecords(readFileSync(s.shared(3), 'utf8'));
    expect(lines.map((l) => [l.type, l.attempt, l.exit])).toEqual([['run', 1, 1], ['call', 2, undefined], ['run', 2, 0]]);
  });
});
