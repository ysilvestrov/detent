import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, prReview, type PrReviewIo } from './pr-review.js';

const KEY = 'sk-test-secret-key';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  return r.stdout.trim();
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// A repository with `main` as origin/main and a feature branch one commit ahead, which changes src/a.ts.
function makeRepo(config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'detent-pr-review-'));
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'src/a.ts', 'export const a = 1;\n');
  put(dir, 'detent.json', JSON.stringify(config ?? {}));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put(dir, 'src/a.ts', 'export const a = 2;\nexport const b = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

function writeEvent(overrides: Record<string, unknown> = {}): string {
  const event = {
    pull_request: {
      number: 7,
      title: 'A change',
      body: 'Does a thing',
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      head: { sha: 'unused', repo: { full_name: 'o/r' } },
      ...overrides,
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'detent-pr-review-event-'));
  put(dir, 'event.json', JSON.stringify(event));
  return join(dir, 'event.json');
}

interface Call {
  method: string;
  url: string;
  body: string;
}

const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const noFindings = { choices: [{ message: { content: JSON.stringify({ findings: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };

// GitHub answers with empty lists and accepts writes; the model answers with `model`.
function stub(model: () => Response): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const routes: Array<{ test: RegExp; respond: () => Response }> = [
    { test: /^GET .*\/pulls\/7\/reviews/, respond: () => ok([]) },
    { test: /^GET .*\/issues\/7\/comments/, respond: () => ok([]) },
    { test: /^POST .*\/issues\/7\/comments/, respond: () => ok({ id: 1 }, 201) },
    { test: /^POST .*\/pulls\/7\/reviews/, respond: () => ok({ id: 2 }) },
    { test: /^POST .*\/chat\/completions/, respond: model },
  ];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: String(init?.body ?? '') };
    calls.push(call);
    return routes.find((r) => r.test.test(`${call.method} ${call.url}`))!.respond();
  }) as typeof fetch;
  return { fetchFn, calls };
}

function harness(opts: { config?: object; event?: Record<string, unknown>; env?: Record<string, string>; model?: () => Response } = {}) {
  const dir = makeRepo(opts.config);
  const net = stub(opts.model ?? (() => ok(noFindings)));
  const out: string[] = [];
  const err: string[] = [];
  const io: PrReviewIo = {
    cwd: dir,
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: writeEvent(opts.event),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 'ghs-token',
      OPENAI_API_KEY: KEY,
      ...opts.env,
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetchFn: net.fetchFn,
  };
  return { io, dir, out, err, calls: net.calls };
}

const modelCalls = (calls: Call[]): Call[] => calls.filter((c) => c.url.endsWith('/chat/completions'));
const failureComments = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issues/7/comments'));
const modelOf = (call: Call): string => (JSON.parse(call.body) as { model: string }).model;

describe('pr-review in CI', () => {
  it('refuses an event that is not a pull_request', async () => {
    const h = harness({ env: { GITHUB_EVENT_NAME: 'push' } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('pull_request');
    expect(h.calls).toEqual([]);
  });

  it('needs the event file', async () => {
    const h = harness({ env: { GITHUB_EVENT_PATH: '' } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('GITHUB_EVENT_PATH');
  });

  it('needs the token', async () => {
    const h = harness({ env: { GITHUB_TOKEN: '' } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('GITHUB_TOKEN');
  });

  it('rejects an argument it does not know', async () => {
    const h = harness();
    expect(await prReview(['--nope'], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('Usage:');
  });

  it('exits 2 and names the ref when origin/<base> is not in the checkout', async () => {
    const h = harness({ event: { base: { ref: 'release/9', repo: { full_name: 'o/r' } } } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('origin/release/9');
    expect(h.calls).toEqual([]);
  });

  it('skips a fork without a key: exit 0, no network', async () => {
    const h = harness({ env: { OPENAI_API_KEY: '' }, event: { head: { sha: 'x', repo: { full_name: 'someone/r' } } } });
    expect(await prReview([], h.io)).toBe(EXIT.ok);
    expect(h.err.join('\n')).toContain('fork');
    expect(h.calls).toEqual([]);
  });

  it('treats a deleted fork (head.repo null) as a fork', async () => {
    const h = harness({ env: { OPENAI_API_KEY: '' }, event: { head: { sha: 'x', repo: null } } });
    expect(await prReview([], h.io)).toBe(EXIT.ok);
    expect(h.calls).toEqual([]);
  });

  it('fails a same-repository PR that has no key, and says so in a comment', async () => {
    const h = harness({ env: { OPENAI_API_KEY: '' } });
    expect(await prReview([], h.io)).toBe(EXIT.failed);
    const comments = failureComments(h.calls);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('ai-pr-review-failure');
    expect(comments[0]!.body).toContain('OPENAI_API_KEY');
  });

  it('asks for "provider" when two keys are set, naming both and not the values', async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: 'sk-ant-other' } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    const text = h.err.join('\n');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('sk-ant-other');
    expect(h.calls).toEqual([]);
  });

  it('exits 2 when the provider has no default model and the base names none', async () => {
    const h = harness({ config: { prReview: { provider: 'anthropic' } }, env: { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: '' } });
    expect(await prReview([], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('prReview.findModel');
    expect(h.calls).toEqual([]);
  });

  it('reviews a PR with an empty description: body null reaches the model as "(no description)"', async () => {
    const h = harness({ event: { body: null } });
    expect(await prReview([], h.io)).toBe(EXIT.ok);
    const calls = modelCalls(h.calls);
    expect(calls).toHaveLength(1);
    const messages = (JSON.parse(calls[0]!.body) as { messages: Array<{ content: string }> }).messages;
    expect(messages[1]!.content).toContain('(no description)');
    expect(messages[1]!.content).not.toContain('null');
    expect(h.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pulls/7/reviews'))).toHaveLength(1);
  });

  it('exits 5 with a failure comment when the model answers 500, and the key stays out of everything', async () => {
    const h = harness({ model: () => new Response(`overloaded, your key ${KEY}`, { status: 500 }) });
    expect(await prReview([], h.io)).toBe(EXIT.failed);
    const comments = failureComments(h.calls);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('ai-pr-review-failure');
    expect([comments[0]!.body, ...h.out, ...h.err].join('\n')).not.toContain(KEY);
  });

  it('ignores AI_REVIEW_MODEL in CI: the model comes from the base', async () => {
    const h = harness({ env: { AI_REVIEW_MODEL: 'evil', AI_REVIEW_VERIFY_MODEL: 'evil' } });
    expect(await prReview([], h.io)).toBe(EXIT.ok);
    expect(modelOf(modelCalls(h.calls)[0]!)).toBe('gpt-5.6-sol');
  });
});

describe('pr-review --replay', () => {
  function replay(extraEnv: Record<string, string> = {}) {
    const h = harness({ env: { GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '', GITHUB_TOKEN: '', ...extraEnv } });
    const head = git(h.dir, 'rev-parse', 'HEAD');
    h.io.gh = () => JSON.stringify({ title: 'A change', body: null, headRefOid: head, baseRefName: 'main' });
    return h;
  }

  it('lets AI_REVIEW_MODEL pick the model, posts nothing and prints the summary with the cost line', async () => {
    const h = replay({ AI_REVIEW_MODEL: 'candidate-x' });
    expect(await prReview(['--replay', '7'], h.io)).toBe(EXIT.ok);
    expect(modelOf(modelCalls(h.calls)[0]!)).toBe('candidate-x');
    expect(h.calls.filter((c) => c.url.includes('api.github.com'))).toEqual([]);
    expect(h.out.join('\n')).toContain('raised 0');
    expect(h.out.join('\n')).toContain('PR total');
  });

  it('reads the settings from the working tree, not from the base', async () => {
    const h = replay();
    put(h.dir, 'detent.json', JSON.stringify({ prReview: { findModel: 'from-worktree' } }));
    expect(await prReview(['--replay', '7'], h.io)).toBe(EXIT.ok);
    expect(modelOf(modelCalls(h.calls)[0]!)).toBe('from-worktree');
  });

  it('exits 2 for an unknown --provider, listing the providers', async () => {
    const h = replay();
    expect(await prReview(['--replay', '7', '--provider', 'x'], h.io)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('openai|anthropic|openrouter');
  });

  it('exits 2 without a key: a replay has no fork to excuse it', async () => {
    const h = replay({ OPENAI_API_KEY: '' });
    expect(await prReview(['--replay', '7'], h.io)).toBe(EXIT.usage);
    expect(h.calls).toEqual([]);
  });
});
