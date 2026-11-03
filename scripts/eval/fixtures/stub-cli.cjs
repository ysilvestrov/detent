// Stands in for `dist/cli.js` in funnel.test.mjs: `detent pr-review --replay` with the same record and findings
// formats, no network. `control.json` beside it says what to do differently:
//   fail: ['label|pr|draw']                          the find ends in an empty answer, exit 5
//   verdicts: {'label|judge': ['confirmed', ...]}    the results of a verify or whole run; an `error` verdict sets the run's error
//   unparseable: ['label|pr|draw']                   the answer has content and `stop`, and the run still ends in exit 5
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const pr = argv[2];
const env = process.env;
const controlFile = join(__dirname, 'control.json');
const control = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};

if (argv.includes('--context-only')) {
  process.stdout.write(`${(control.budget ?? {})[pr] ?? 'Context budget: 0 file(s) sent as diff only.'}\n`);
  process.exit(0);
}

const provider = flag('--provider');
if (!env[KEY_ENV[provider]]) {
  process.stderr.write('no key\n');
  process.exit(2);
}
const strangers = Object.keys(env).filter((name) => name.endsWith('_API_KEY') && name !== KEY_ENV[provider]);
if (strangers.length > 0) {
  process.stderr.write(`keys of other routes: ${strangers.join(', ')}\n`);
  process.exit(2);
}

const meta = JSON.parse(env.AI_REVIEW_RECORD_META);
const runId = randomUUID();
const head = flag('--head') ?? 'abc123';
const write = (line) => appendFileSync(flag('--record'), `${JSON.stringify(line)}\n`);
const host = provider === 'openrouter' ? 'StubHost' : null;
const call = (stage, model, over = {}) =>
  write({
    type: 'call',
    runId,
    stage,
    id: 'gen',
    model,
    provider: host,
    finishReason: 'stop',
    contentLength: 400,
    usage: {
      prompt_tokens: stage === 'find' ? 10000 : 3000,
      completion_tokens: stage === 'find' ? 1000 : 300,
      prompt_tokens_details: { cached_tokens: pr === '688' ? 600 : 0, cache_write_tokens: pr === '688' ? 1000 : 0 },
    },
    ...over,
  });
const closeRun = ({ findModel = env.AI_REVIEW_MODEL ?? null, exit, error, results = [] }) =>
  write({
    type: 'run',
    runId,
    ...meta,
    provider,
    findModel,
    verifyModel: env.AI_REVIEW_VERIFY_MODEL ?? null,
    only: { find: env.AI_REVIEW_OPENROUTER_ONLY?.split(',') ?? null, verify: env.AI_REVIEW_VERIFY_OPENROUTER_ONLY?.split(',') ?? null },
    cacheMode: env.AI_REVIEW_CACHE ?? 'default',
    pr,
    head,
    base: 'def',
    startedAt: 't',
    diffOnly: [],
    raised: 1,
    gated: 1,
    dropped: [],
    results,
    exit,
    error,
  });

const where = `${meta.label}|${pr}|${meta.draw}`;
const finding = { file: 'a.ts', quote: 'q', claim: 'c', severity: 'P1', confidence: 'high' };
const kept = { ...finding, start_line: 1, end_line: 2, why_it_breaks: 'w', matchedLine: 1, matchedEndLine: 2 };

function results() {
  const verdicts = (control.verdicts ?? {})[`${meta.label}|${env.AI_REVIEW_VERIFY_MODEL}`] ?? ['confirmed'];
  return verdicts.map((verdict) => ({ ...finding, line: 1, whyItBreaks: 'w', verdict, evidence: 'e' }));
}
const errorOf = (list) => (list.some((r) => r.verdict === 'error') ? `${list.filter((r) => r.verdict === 'error').length} of ${list.length} findings not verified` : null);

if (argv.includes('--find-only')) {
  if ((control.fail ?? []).includes(where)) {
    call('find', env.AI_REVIEW_MODEL, { contentLength: 0, finishReason: 'length' });
    closeRun({ exit: 5, error: 'returned an empty completion' });
    process.exit(5);
  }
  call('find', env.AI_REVIEW_MODEL);
  if ((control.unparseable ?? []).includes(where)) {
    closeRun({ exit: 5, error: 'the answer did not parse' });
    process.exit(5);
  }
  writeFileSync(flag('--save-findings'), JSON.stringify({ v: 1, pr, head, base: 'def', findModel: env.AI_REVIEW_MODEL, scope: 's', raised: [kept], kept: [kept], dropped: [] }));
  closeRun({ exit: 0, error: null });
  process.exit(0);
}

if (flag('--verify-from') !== undefined) {
  const saved = JSON.parse(readFileSync(flag('--verify-from'), 'utf8'));
  if (saved.pr !== pr) {
    process.stderr.write('the findings are of another PR\n');
    process.exit(2);
  }
  call('verify', env.AI_REVIEW_VERIFY_MODEL);
  const list = results();
  closeRun({ findModel: saved.findModel, exit: 0, error: errorOf(list), results: list });
  process.exit(0);
}

call('find', env.AI_REVIEW_MODEL);
call('verify', env.AI_REVIEW_VERIFY_MODEL);
const list = results();
closeRun({ exit: 0, error: errorOf(list), results: list });
