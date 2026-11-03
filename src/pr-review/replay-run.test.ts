// `runReplay` end to end: a real git repository, a stubbed `gh` and a stubbed `fetch`. No model call leaves the machine.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReplay, type ReplayArgs, type ReplayIo } from './replay.js';

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
