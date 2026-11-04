// `runReplay` end to end: a real git repository, a stubbed `gh` and a stubbed `fetch`. No model call leaves the machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CallInfo } from './openai.js';
import { runReplay, type ReplayArgs, type ReplayIo } from './replay.js';
import { readFindings } from './saved-findings.js';
import { loadSettings } from './settings.js';

const KEY = 'sk-test-key-0123456789';

// A switch the tests flip to make the record file refuse a stage's call line, the way a full disk would.
const faults = vi.hoisted(() => ({ failWritesOf: null as string | null }));
vi.mock('./record.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./record.js')>();
  return {
    ...real,
    openRecord: (path: string, runId: string) => {
      const writer = real.openRecord(path, runId);
      return {
        ...writer,
        call: (stage: 'find' | 'verify', info: CallInfo) => {
          if (stage === faults.failWritesOf) throw new Error('disk full');
          writer.call(stage, info);
        },
      };
    },
  };
});

// The folders are left behind on purpose: nothing in this repository deletes recursively.
function makeRepo(): { cwd: string; head: string } {
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

function stubGh(head: string): (args: string[]) => string {
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
function makeFetch(override: Partial<Record<Stage, () => Response>> = {}): {
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
async function replay(
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

const recordPath = (name = 'r.jsonl'): string => join(mkdtempSync(join(tmpdir(), 'detent-record-')), name);

function readRecord(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

type Result = { code: number; out: string[]; err: string[] };
type Run = (args: Omit<ReplayArgs, 'pr'> & { pr?: string }, p: { env?: ReplayIo['env']; fetchFn: typeof fetch }) => Promise<Result>;

/** A repository whose first commit holds a.ts and whose second commit writes the files of `change`. */
function repoWith(change: Record<string, string>): { cwd: string; head: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'detent-replay-'));
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 0;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (const [path, content] of Object.entries(change)) writeFileSync(join(cwd, path), content);
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  return { cwd, head: git('rev-parse', 'HEAD') };
}

/** Several runs over one repository: the head must be the same for a find and the verify that follows it. */
function inRepo(change: Record<string, string> = { 'a.ts': 'export const a = 0;\nconst x = 1;\n' }): { cwd: string; head: string; run: Run } {
  const { cwd, head } = repoWith(change);
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

    const repo = inRepo();
    await expect(repo.run({ record: path }, { fetchFn })).rejects.toThrow('OpenAI returned an empty completion');

    const lines = readRecord(path);
    expect(lines.map((l) => l.type)).toEqual(['call', 'run']);
    expect(lines[1]).toMatchObject({ exit: 5, error: 'OpenAI returned an empty completion', head: repo.head });
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
      AI_REVIEW_CACHE_OFF_MODELS: 'f/model,v/model',
    };
    const { code } = await replay({ record: path }, { fetchFn, env });

    expect(code).toBe(0);
    expect(bodyOf(bodies[0]!).provider).toEqual({ only: ['moonshotai'], allow_fallbacks: false, require_parameters: true });
    expect(bodyOf(bodies[1]!).provider).toEqual({ only: ['openai', 'azure'], allow_fallbacks: false, require_parameters: true });
    expect(readRecord(path).at(-1)).toMatchObject({ only: { find: ['moonshotai'], verify: ['openai', 'azure'] }, cacheMode: 'off' });
  });

  it('gives the find alone the limit and the reasoning effort it was asked for', async () => {
    const { fetchFn, bodies } = makeFetch();
    const env = {
      OPENROUTER_API_KEY: KEY,
      AI_REVIEW_MODEL: 'f/model',
      AI_REVIEW_VERIFY_MODEL: 'v/model',
      AI_REVIEW_FIND_MAX_TOKENS: '32000',
      AI_REVIEW_FIND_REASONING: 'low',
    };
    const { code } = await replay({}, { fetchFn, env });

    expect(code).toBe(0);
    expect([bodyOf(bodies[0]!).max_completion_tokens, bodyOf(bodies[0]!).reasoning]).toEqual([32000, { effort: 'low' }]);
    expect([bodyOf(bodies[1]!).max_completion_tokens, bodyOf(bodies[1]!).reasoning]).toEqual([8000, undefined]);
  });

  it('sends neither setting and the usual limit when none was asked for', async () => {
    const { fetchFn, bodies } = makeFetch();
    const env = { OPENROUTER_API_KEY: KEY, AI_REVIEW_MODEL: 'f/model', AI_REVIEW_VERIFY_MODEL: 'v/model' };
    await replay({}, { fetchFn, env });

    expect([bodyOf(bodies[0]!).max_completion_tokens, bodyOf(bodies[0]!).reasoning]).toEqual([8000, undefined]);
  });

  it('refuses a reasoning effort outside openrouter with code 2 and no model call', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_FIND_REASONING: 'low' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_FIND_REASONING works only with the openrouter provider, not openai');
    expect(bodies).toEqual([]);
  });

  it('refuses a limit that is not a positive whole number with code 2 and no model call', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_FIND_MAX_TOKENS: '32k' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_FIND_MAX_TOKENS must be a positive whole number');
    expect(bodies).toEqual([]);
  });

  it('refuses a limit too large to send with code 2 and no model call', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_FIND_MAX_TOKENS: '9'.repeat(309) } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_FIND_MAX_TOKENS must be a positive whole number');
    expect(bodies).toEqual([]);
  });

  it('refuses an effort it does not know with code 2 and no model call', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({}, { fetchFn, env: { OPENROUTER_API_KEY: KEY, AI_REVIEW_FIND_REASONING: 'lowest' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_FIND_REASONING must be one of none, minimal, low, medium, high');
    expect(bodies).toEqual([]);
  });

  it('refuses a find setting on a run that does not find', async () => {
    const { fetchFn, bodies } = makeFetch();
    const { code, err } = await replay({ contextOnly: true }, { fetchFn, env: { AI_REVIEW_FIND_MAX_TOKENS: '32000' } });

    expect(code).toBe(2);
    expect(err.join('\n')).toContain('AI_REVIEW_FIND_MAX_TOKENS and AI_REVIEW_FIND_REASONING need a run that finds');
    expect(bodies).toEqual([]);
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
    expect(lines.map((l) => l.type)).toEqual(['call', 'run']);
    expect(lines.filter((l) => l.type === 'call').map((l) => l.stage)).toEqual(['find']);
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
    expect(lines.map((l) => l.type)).toEqual(['call', 'run']);
    expect(lines.filter((l) => l.type === 'call').map((l) => l.stage)).toEqual(['verify']);
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

describe('replay run line, failures and edge cases', () => {
  const OPENROUTER = { OPENROUTER_API_KEY: KEY, AI_REVIEW_MODEL: 'f/model', AI_REVIEW_VERIFY_MODEL: 'v/model' };
  const bodyOf = (raw: string): Record<string, any> => JSON.parse(raw) as Record<string, any>;
  const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'detent-findings-')), 'f.json');
  const STANDARD_KEYS = ['model', 'max_completion_tokens', 'response_format', 'messages', 'provider'];
  const TWO_FILES = { 'a.ts': 'export const a = 0;\nconst x = 1;\n', 'b.ts': 'export const b = 0;\nconst y = 2;\n' };
  const twoFindings = (): Response =>
    completion(JSON.stringify({ findings: [FINDING, { ...FINDING, file: 'b.ts', quote: 'const y = 2;', claim: 'y is a constant' }] }));

  it('a failed record write in the verify stage stops the paid calls and ends the run with exit 5', async () => {
    const repo = inRepo(TWO_FILES);
    const path = recordPath();
    const { fetchFn, bodies } = makeFetch({ review_findings: twoFindings });
    faults.failWritesOf = 'verify';
    try {
      await expect(repo.run({ record: path }, { fetchFn })).rejects.toThrow('disk full');
    } finally {
      faults.failWritesOf = null;
    }

    const lines = readRecord(path);
    expect(bodies.map((b) => bodyOf(b).response_format.json_schema.name)).toEqual(['review_findings', 'review_verdicts']);
    expect(lines.map((l) => l.type)).toEqual(['call', 'run']);
    expect(lines[1]).toMatchObject({ exit: 5, error: 'disk full' });
  });

  it('a failed record write in the find stage sends one request and ends the run with exit 5', async () => {
    const repo = inRepo(TWO_FILES);
    const path = recordPath();
    const { fetchFn, bodies } = makeFetch({ review_findings: twoFindings });
    faults.failWritesOf = 'find';
    try {
      await expect(repo.run({ record: path }, { fetchFn })).rejects.toThrow('disk full');
    } finally {
      faults.failWritesOf = null;
    }

    const lines = readRecord(path);
    expect(bodies.map((b) => bodyOf(b).response_format.json_schema.name)).toEqual(['review_findings']);
    expect(lines.map((l) => l.type)).toEqual(['run']);
    expect(lines[0]).toMatchObject({ exit: 5, error: 'OpenAI response hook failed: Error: disk full' });
  });

  it('a verify that fails for every finding exits 0 and says so on the run line and on stderr', async () => {
    const repo = inRepo(TWO_FILES);
    const path = recordPath();
    const { fetchFn } = makeFetch({ review_findings: twoFindings, review_verdicts: () => new Response('bad', { status: 400 }) });
    const { code, err } = await repo.run({ record: path }, { fetchFn });

    expect(code).toBe(0);
    expect(err).toContain('2 of 2 findings not verified');
    expect(readRecord(path).at(-1)).toMatchObject({ exit: 0, error: '2 of 2 findings not verified' });
  });

  it('a verify that fails for one of two files counts only that finding', async () => {
    const repo = inRepo(TWO_FILES);
    const path = recordPath();
    const replies = [
      (): Response => new Response('bad', { status: 400 }),
      (): Response => completion(JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'there' }] })),
    ];
    const { fetchFn } = makeFetch({ review_findings: twoFindings, review_verdicts: () => replies.shift()!() });
    const { code } = await repo.run({ record: path }, { fetchFn });

    expect(code).toBe(0);
    expect(readRecord(path).at(-1)).toMatchObject({ error: '1 of 2 findings not verified' });
  });

  it('a verify without failures leaves the error of the run line null', async () => {
    const path = recordPath();
    const { fetchFn } = makeFetch();
    await replay({ record: path }, { fetchFn });

    expect(readRecord(path).at(-1)).toMatchObject({ error: null });
  });

  it('verify-from with a find pin on a provider that is not openrouter exits 0 and records no find pin', async () => {
    const repo = inRepo();
    const saved = tempFile();
    await repo.run({ findOnly: true, saveFindings: saved }, { fetchFn: makeFetch().fetchFn });
    const path = recordPath();
    const { code } = await repo.run(
      { verifyFrom: saved, record: path },
      { fetchFn: makeFetch().fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_OPENROUTER_ONLY: 'x' } },
    );

    expect(code).toBe(0);
    expect(readRecord(path).at(-1)).toMatchObject({ only: { find: null, verify: null } });
  });

  it('find-only with a verify pin on a provider that is not openrouter exits 0 and records no verify pin', async () => {
    const path = recordPath();
    const { code } = await replay(
      { findOnly: true, saveFindings: tempFile(), record: path },
      { fetchFn: makeFetch().fetchFn, env: { OPENAI_API_KEY: KEY, AI_REVIEW_VERIFY_OPENROUTER_ONLY: 'x' } },
    );

    expect(code).toBe(0);
    expect(readRecord(path).at(-1)).toMatchObject({ only: { find: null, verify: null } });
  });

  it.each([
    ['a list that does not name the model', { AI_REVIEW_CACHE: 'off', AI_REVIEW_CACHE_OFF_MODELS: 'other/model' }],
    ['no list', { AI_REVIEW_CACHE: 'off' }],
  ])('cache off with %s sends the standard body and records the default cache mode', async (_name, extra) => {
    const path = recordPath();
    const { fetchFn, bodies } = makeFetch();
    await replay({ record: path }, { fetchFn, env: { ...OPENROUTER, ...extra } });

    expect(bodies.map((b) => Object.keys(bodyOf(b)))).toEqual([STANDARD_KEYS, STANDARD_KEYS]);
    expect(readRecord(path).at(-1)).toMatchObject({ cacheMode: 'default' });
  });

  it('cache off for the find model only turns it off in the find body and records off', async () => {
    const path = recordPath();
    const { fetchFn, bodies } = makeFetch();
    await replay({ record: path }, { fetchFn, env: { ...OPENROUTER, AI_REVIEW_CACHE: 'off', AI_REVIEW_CACHE_OFF_MODELS: 'f/model' } });

    expect(bodyOf(bodies[0]!).prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(bodyOf(bodies[1]!)).not.toHaveProperty('prompt_cache_options');
    expect(readRecord(path).at(-1)).toMatchObject({ cacheMode: 'off' });
  });

  it('find-only with no reviewable files saves empty findings that verify-from accepts without a call', async () => {
    const repo = inRepo({ 'README.md': '# hi\n' });
    const saved = tempFile();
    const first = makeFetch();
    const found = await repo.run({ findOnly: true, saveFindings: saved }, { fetchFn: first.fetchFn });

    expect(found.code).toBe(0);
    expect(first.bodies).toEqual([]);
    expect(readFindings(saved)).toMatchObject({ head: repo.head, raised: [], kept: [], dropped: [] });

    const second = makeFetch();
    const verified = await repo.run({ verifyFrom: saved }, { fetchFn: second.fetchFn });
    expect(verified.code).toBe(0);
    expect(second.bodies).toEqual([]);
  });

  it('records a run line with empty arrays when no file is reviewable', async () => {
    const repo = inRepo({ 'README.md': '# hi\n' });
    const path = recordPath();
    const { code, out } = await repo.run({ record: path }, { fetchFn: makeFetch().fetchFn });

    expect(code).toBe(0);
    expect(out).toEqual(['no reviewable files']);
    expect(readRecord(path)).toMatchObject([{ type: 'run', exit: 0, error: null, head: repo.head, raised: 0, gated: 0, dropped: [], results: [], diffOnly: [] }]);
  });

  it('verify-from never asks gh', async () => {
    const repo = inRepo();
    const saved = tempFile();
    await repo.run({ findOnly: true, saveFindings: saved }, { fetchFn: makeFetch().fetchFn });
    const code = await runReplay(
      { pr: '418', verifyFrom: saved },
      {
        cwd: repo.cwd,
        env: { OPENAI_API_KEY: KEY },
        out: () => {},
        err: () => {},
        fetchFn: makeFetch().fetchFn,
        gh: () => {
          throw new Error('gh was called');
        },
      },
    );

    expect(code).toBe(0);
  });

  it('a file sent as a diff only reaches the printed line and the run line', async () => {
    const repo = inRepo({ 'a.ts': 'export const a = 0;\nconst x = 1;\n', 'x.test.ts': 'export const t = 1;\n' });
    const path = recordPath();
    const { out } = await repo.run({ record: path }, { fetchFn: makeFetch().fetchFn });

    expect(out).toContain('Context budget: 1 file(s) sent as diff only: x.test.ts');
    expect(readRecord(path).at(-1)).toMatchObject({ diffOnly: ['x.test.ts'] });
  });
});
