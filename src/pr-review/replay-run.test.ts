// `runReplay` end to end: a real git repository, a stubbed `gh` and a stubbed `fetch`. No model call leaves the machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReplay, type ReplayArgs, type ReplayIo } from './replay.js';
import { readFindings } from './saved-findings.js';
import { loadSettings } from './settings.js';

const KEY = 'sk-test-key-0123456789';

// The folders are left behind on purpose: nothing in this repository deletes recursively.
export function makeRepo(): { cwd: string; head: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'detent-replay-'));
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 0;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 0;\nconst x = 1;\n');
  git('commit', '-q', '-am', 'second');
  return { cwd, head: git('rev-parse', 'HEAD') };
}

export function stubGh(head: string): (args: string[]) => string {
  return () => JSON.stringify({ title: 't', body: '', headRefOid: head, baseRefName: 'main' });
}

type Stage = 'review_findings' | 'review_verdicts';

const completion = (content: string): Response =>
  new Response(
    JSON.stringify({
      id: 'gen-1',
      model: 'm',
      provider: 'p',
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );

const FINDING = {
  file: 'a.ts',
  start_line: 2,
  end_line: 2,
  quote: 'const x = 1;',
  claim: 'x is a constant',
  why_it_breaks: 'it never changes',
  severity: 'P1',
  confidence: 'high',
};

/** Answers each stage with one finding quoting `const x = 1;` and a `confirmed` verdict. `override` replaces a stage's reply. */
export function makeFetch(override: Partial<Record<Stage, () => Response>> = {}): {
  fetchFn: typeof fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const stage = (JSON.parse(body) as { response_format: { json_schema: { name: Stage } } }).response_format.json_schema.name;
    const custom = override[stage];
    if (custom) return custom();
    return completion(
      JSON.stringify(
        stage === 'review_findings'
          ? { findings: [FINDING] }
          : { verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'the line is there' }] },
      ),
    );
  }) as typeof fetch;
  return { fetchFn, bodies };
}

/** One `runReplay` over a fresh repository; everything the command printed comes back with its exit code. */
export async function replay(
  args: Omit<ReplayArgs, 'pr'>,
  p: { env?: ReplayIo['env']; fetchFn: typeof fetch },
): Promise<{ code: number; out: string[]; err: string[] }> {
  const { cwd, head } = makeRepo();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReplay(
    { pr: '1', ...args },
    { cwd, env: p.env ?? { OPENAI_API_KEY: KEY }, out: (l) => out.push(l), err: (l) => err.push(l), fetchFn: p.fetchFn, gh: stubGh(head) },
  );
  return { code, out, err };
}

export const recordPath = (name = 'r.jsonl'): string => join(mkdtempSync(join(tmpdir(), 'detent-record-')), name);

export function readRecord(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

describe('replay --record', () => {
  it('writes one call line per response and one run line, all with one runId', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch();
    const { code } = await replay({ record: path }, { fetchFn });

    const lines = readRecord(path);
    expect(code).toBe(0);
    expect(lines.map((l) => l.type)).toEqual(['call', 'call', 'run']);
    expect(lines.filter((l) => l.type === 'call').map((l) => l.stage)).toEqual(['find', 'verify']);
    expect(new Set(lines.map((l) => l.runId)).size).toBe(1);
    expect(lines[0]).toMatchObject({ id: 'gen-1', model: 'm', provider: 'p', finishReason: 'stop', usage: { prompt_tokens: 10 } });
    const run = lines[2]!;
    expect(run).toMatchObject({ exit: 0, error: null, raised: 1, gated: 1, pr: '1', provider: 'openai', only: { find: null, verify: null }, cacheMode: 'default' });
    expect(run.results[0]).toMatchObject({ file: 'a.ts', line: 2, quote: 'const x = 1;', verdict: 'confirmed', evidence: 'the line is there' });
  });

  it('merges AI_REVIEW_RECORD_META into the run line', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch();
    await replay(
      { record: path },
      { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_RECORD_META: '{"batch":2,"label":"x","draw":3}' } },
    );

    const run = readRecord(path).at(-1)!;
    expect(run).toMatchObject({ batch: 2, label: 'x', draw: 3 });
  });

  it('leaves batch, label and draw null without AI_REVIEW_RECORD_META', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch();
    await replay({ record: path }, { fetchFn });

    expect(readRecord(path).at(-1)).toMatchObject({ batch: null, label: null, draw: null });
  });

  it('returns 2 before any model call when AI_REVIEW_RECORD_META is not a JSON object', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code } = await replay(
      { record: recordPath() },
      { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_RECORD_META: '[1]' } },
    );

    expect(code).toBe(2);
    expect(bodies).toEqual([]);
  });

  it('keeps the billed call line when the completion is empty, and records exit 5', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch({ review_findings: () => completion('') });

    await expect(replay({ record: path }, { fetchFn })).rejects.toThrow('OpenAI returned an empty completion');

    const lines = readRecord(path);
    expect(lines.map((l) => l.type)).toEqual(['call', 'run']);
    expect(lines[1]).toMatchObject({ exit: 5, error: 'OpenAI returned an empty completion', head: expect.any(String) });
  });

  it('replaces the key in the recorded error', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch({ review_findings: () => new Response(`bad key ${KEY}`, { status: 400 }) });

    await expect(replay({ record: path }, { fetchFn })).rejects.toThrow('OpenAI HTTP 400');

    const run = readRecord(path).at(-1)!;
    expect(run.error).toBe('OpenAI HTTP 400: bad key ***');
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
  });

  it('creates the folder of the record file', async () => {
    const path = join(recordPath('x'), '..', 'a', 'b', 'r.jsonl');
    const { fetchFn } = makeFetch();
    await replay({ record: path }, { fetchFn });

    expect(readRecord(path).at(-1)).toMatchObject({ type: 'run', exit: 0 });
  });

  it('returns 2 before any model call when the record file cannot be opened', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'detent-record-'));
    const { fetchFn, bodies } = makeFetch();
    const { code } = await replay({ record: folder }, { fetchFn });

    expect(code).toBe(2);
    expect(bodies).toEqual([]);
  });
});

describe('replay context budget', () => {
  it('prints the context budget line', async () => {
    const { fetchFn } = makeFetch();
    const { out } = await replay({}, { fetchFn });

    expect(out).toContain('Context budget: 0 file(s) sent as diff only.');
  });

  it('context-only prints the budget and calls no model, with no key at all', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, out } = await replay({ contextOnly: true }, { fetchFn, env: {} });

    expect(code).toBe(0);
    expect(out).toEqual(['Context budget: 0 file(s) sent as diff only.']);
    expect(bodies).toEqual([]);
  });
});

describe('replay executor pinning', () => {
  const bodyOf = (raw: string): Record<string, any> => JSON.parse(raw) as Record<string, any>;

  it('pins each stage to its own executor', async () => {
    const path = recordPath();
    const { fetchFn, bodies } = makeFetch();
    const env = {
      OPENROUTER_API_KEY: KEY,
      AI_REVIEW_MODEL: 'f/model',
      AI_REVIEW_VERIFY_MODEL: 'v/model',
      AI_REVIEW_OPENROUTER_ONLY: 'moonshotai',
      AI_REVIEW_VERIFY_OPENROUTER_ONLY: 'openai, azure',
      AI_REVIEW_CACHE: 'off',
    };
    const { code } = await replay({ record: path }, { fetchFn, env });

    expect(code).toBe(0);
    expect(bodyOf(bodies[0]!).provider).toEqual({ only: ['moonshotai'], allow_fallbacks: false, require_parameters: true });
    expect(bodyOf(bodies[1]!).provider).toEqual({ only: ['openai', 'azure'], allow_fallbacks: false, require_parameters: true });
    expect(readRecord(path).at(-1)).toMatchObject({ only: { find: ['moonshotai'], verify: ['openai', 'azure'] }, cacheMode: 'off' });
  });

  it('refuses a pin outside openrouter with code 2 and no model call', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_OPENROUTER_ONLY: 'x' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_OPENROUTER_ONLY');
    expect(bodies).toEqual([]);
  });

  it('refuses a verify pin outside openrouter and names its variable', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_VERIFY_OPENROUTER_ONLY: 'x' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_VERIFY_OPENROUTER_ONLY');
    expect(bodies).toEqual([]);
  });

  it('leaves the body alone without these variables', async () => {
    const { fetchFn, bodies } = makeFetch();
    await replay({}, { fetchFn });

    expect(Object.keys(bodyOf(bodies[0]!))).toEqual(['model', 'max_completion_tokens', 'response_format', 'messages']);
  });
});

describe('replay find and verify as separate steps', () => {
  const OPENROUTER = { OPENROUTER_API_KEY: KEY, AI_REVIEW_MODEL: 'f/model', AI_REVIEW_VERIFY_MODEL: 'v/model' };
  const bodyOf = (raw: string): Record<string, any> => JSON.parse(raw) as Record<string, any>;
  const tempFile = (name = 'f.json'): string => join(mkdtempSync(join(tmpdir(), 'detent-findings-')), name);
  const scopeOf = (cwd: string): string =>
    loadSettings((path) => {
      try {
        return readFileSync(join(cwd, path), 'utf8');
      } catch {
        return null;
      }
    }).scope;
  type Result = { code: number; out: string[]; err: string[] };
  type Run = (args: Omit<ReplayArgs, 'pr'> & { pr?: string }, p: { env?: ReplayIo['env']; fetchFn: typeof fetch }) => Promise<Result>;

  /** Several runs over one repository: the head must be the same for a find and the verify that follows it. */
  function inRepo(): { cwd: string; head: string; run: Run } {
    const { cwd, head } = makeRepo();
    const run: Run = async (args, p) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runReplay(
        { pr: '418', ...args },
        { cwd, env: p.env ?? { OPENAI_API_KEY: KEY }, out: (l) => out.push(l), err: (l) => err.push(l), fetchFn: p.fetchFn, gh: stubGh(head) },
      );
      return { code, out, err };
    };
    return { cwd, head, run };
  }

  it('find-only makes one call and saves what passed the gate', async () => {
    const repo = inRepo();
    const path = tempFile();
    const { fetchFn, bodies } = makeFetch();
    const { code, out } = await repo.run({ findOnly: true, saveFindings: path }, { fetchFn });

    const saved = readFindings(path);
    expect(code).toBe(0);
    expect(bodies.map((b) => bodyOf(b).response_format.json_schema.name)).toEqual(['review_findings']);
    expect(out).toContain('raised 1 → gated 1');
    expect(saved).toMatchObject({ v: 1, pr: '418', head: repo.head, scope: scopeOf(repo.cwd) });
    expect(saved.kept).toEqual([{ ...saved.raised[0]!, matchedLine: 2, matchedEndLine: 2 }]);
    expect(saved.dropped).toEqual([]);
  });

  it('find-only works for a provider with no default verify model', async () => {
    const path = tempFile();
    const { fetchFn, bodies } = makeFetch();
    const { code } = await replay(
      { findOnly: true, saveFindings: path },
      { fetchFn, env: { ANTHROPIC_API_KEY: KEY, AI_REVIEW_MODEL: 'claude-x' } },
    );

    expect(code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(readFindings(path).findModel).toBe('claude-x');
  });

  it('find-only leaves the stand-in verify model out of the record and the output', async () => {
    const record = recordPath();
    const { fetchFn } = makeFetch();
    const { out } = await replay({ findOnly: true, saveFindings: tempFile(), record }, { fetchFn, env: OPENROUTER });

    const lines = readRecord(record);
    expect(lines.map((l) => (l.type === 'call' ? `call:${l.stage}` : l.type))).toEqual(['call:find', 'run']);
    expect(lines[1]).toMatchObject({ findModel: 'f/model', verifyModel: null, results: [], raised: 1, gated: 1 });
    expect(out.join('\n')).not.toContain('v/model');
  });

  it('find-only returns 2 before any model call when the findings file cannot be opened', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'detent-findings-'));
    const { fetchFn, bodies } = makeFetch();
    const { code } = await replay({ findOnly: true, saveFindings: folder }, { fetchFn });

    expect(code).toBe(2);
    expect(bodies).toEqual([]);
  });

  it('verify-from sends the same verify request as a whole run', async () => {
    const repo = inRepo();
    const whole = makeFetch();
    await repo.run({}, { fetchFn: whole.fetchFn, env: OPENROUTER });
    const path = tempFile();
    await repo.run({ findOnly: true, saveFindings: path }, { fetchFn: makeFetch().fetchFn, env: OPENROUTER });
    const split = makeFetch();
    const { code } = await repo.run({ verifyFrom: path }, { fetchFn: split.fetchFn, env: OPENROUTER });

    expect(code).toBe(0);
    expect(split.bodies).toHaveLength(1);
    expect(bodyOf(split.bodies[0]!)).toEqual(bodyOf(whole.bodies[1]!));
  });

  it('verify-from counts on another provider than the find', async () => {
    const repo = inRepo();
    const path = tempFile();
    await repo.run({ findOnly: true, saveFindings: path }, { fetchFn: makeFetch().fetchFn, env: OPENROUTER });
    const urls: string[] = [];
    const inner = makeFetch().fetchFn;
    const spy = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      return inner(url as string, init);
    }) as typeof fetch;
    const { code } = await repo.run({ verifyFrom: path, provider: 'openai' }, { fetchFn: spy, env: { OPENAI_API_KEY: KEY } });

    expect(code).toBe(0);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).host).toBe('api.openai.com');
  });

  it('verify-from refuses another PR with code 2 and no model call', async () => {
    const repo = inRepo();
    const path = tempFile();
    await repo.run({ findOnly: true, saveFindings: path }, { fetchFn: makeFetch().fetchFn });
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await repo.run({ verifyFrom: path, pr: '419' }, { fetchFn });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('PR #418');
    expect(bodies).toEqual([]);
  });

  it('verify-from refuses another scope with code 2 and no model call', async () => {
    const repo = inRepo();
    const path = tempFile();
    await repo.run({ findOnly: true, saveFindings: path }, { fetchFn: makeFetch().fetchFn });
    mkdirSync(join(repo.cwd, '.detent', 'prompts'), { recursive: true });
    writeFileSync(join(repo.cwd, '.detent', 'prompts', 'pr-review-verify.md'), 'Judge differently.\n');
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await repo.run({ verifyFrom: path }, { fetchFn });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('prompts or settings');
    expect(bodies).toEqual([]);
  });

  it('verify-from refuses a broken file with code 2 and no model call', async () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ v: 1, pr: '418' }));
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({ verifyFrom: path }, { fetchFn });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('field "head"');
    expect(bodies).toEqual([]);
  });

  it('verify-from records verify calls and a run line with raised and gated from the file', async () => {
    const repo = inRepo();
    const path = tempFile();
    await repo.run({ findOnly: true, saveFindings: path }, { fetchFn: makeFetch().fetchFn, env: OPENROUTER });
    const record = recordPath();
    const { code } = await repo.run({ verifyFrom: path, record }, { fetchFn: makeFetch().fetchFn, env: OPENROUTER });

    const lines = readRecord(record);
    const saved = readFindings(path);
    expect(code).toBe(0);
    expect(lines.map((l) => (l.type === 'call' ? `call:${l.stage}` : l.type))).toEqual(['call:verify', 'run']);
    expect(lines[1]).toMatchObject({
      exit: 0,
      findModel: 'f/model',
      verifyModel: 'v/model',
      pr: '418',
      head: saved.head,
      base: saved.base,
      raised: 1,
      gated: 1,
      dropped: [],
      diffOnly: [],
    });
    expect(lines[1]!.results[0]).toMatchObject({ file: 'a.ts', line: 2, verdict: 'confirmed' });
  });
});
