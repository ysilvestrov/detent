import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_MARKER,
  MARKER,
  contextReader,
  findExistingReview,
  filterReviewableFiles,
  formatCodeSpan,
  globToRegExp,
  isBodyExcluded,
  isSkipReview,
  matchesAny,
  MAX_UNREVIEWED_DISPLAY,
  partitionPrFiles,
  readReviewableFile,
  renderSkipBody,
  runReview,
  upsertReview,
  wrapBody,
  type PrContext,
  type ReviewDeps,
  type RunSettings,
} from './review.js';
import { PROVIDERS } from './providers.js';
import { DEFAULT_PATTERNS, type FilePatterns } from './settings.js';
import { parseState, renderState } from './state.js';

// warsaw-beer-bot's lists, which these tests were written against. They are what a project would
// put in the prReview section of detent.json; the package defaults are in settings.test.ts.
const PATTERNS: FilePatterns = {
  include: [
    'src/**/*.ts',
    'src/api/**/*.html',
    'tests/**/*.ts',
    'scripts/**/*.ts',
    'scripts/**/*.py',
    'scripts/**/*.sh',
    'deploy/**/*.py',
    'deploy/**/*.sh',
    'deploy/**/*.cjs',
    'extension/**/*.ts',
    'extension/**/*.py',
    'extension/src/**/*.html',
    'extension/src/**/*.css',
    '.github/workflows/*.yml',
  ],
  ignore: ['package-lock.json', '**/*.md', 'docs/**'],
  // Test roots are named explicitly: `**/tests/**/*.ts` would also match `src/contests/foo.ts`.
  bodyExclude: [
    '**/*.test.ts',
    'tests/**/*.ts',
    'extension/tests/**/*.ts',
    'deploy/release/test_*.py',
    'deploy/release/release_testkit.py',
    'scripts/ops/test_*.py',
  ],
  // scripts/ops/test_run.py is the production test supervisor, not a test, despite its name.
  bodyInclude: ['scripts/ops/test_run.py'],
};

describe('partitionPrFiles (warsaw-beer-bot#816, warsaw-beer-bot#526)', () => {
  it('correctly partitions reviewable, ignored, and unreviewed files', () => {
    const files = [
      'src/sources/http.ts',
      'docs/superpowers/specs/2026-10-09-spec.md',
      'package-lock.json',
      'extension/CHANGELOG.md',
      'deploy/README.md',
      '.github/ai-review/AGENTS.md',
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
    ];
    const { reviewable, ignored, unreviewed } = partitionPrFiles(files, PATTERNS);
    expect(reviewable).toEqual(['src/sources/http.ts']);
    expect(ignored).toEqual([
      'docs/superpowers/specs/2026-10-09-spec.md',
      'package-lock.json',
      'extension/CHANGELOG.md',
      'deploy/README.md',
      '.github/ai-review/AGENTS.md',
    ]);
    expect(unreviewed).toEqual([
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
    ]);
  });
});

describe('formatCodeSpan (warsaw-beer-bot#816)', () => {
  it('formats normal filenames with single backticks', () => {
    expect(formatCodeSpan('deploy/warsaw-beer-bot.service')).toBe(
      '`deploy/warsaw-beer-bot.service`',
    );
  });

  it('escapes filenames with embedded backticks without breaking Markdown code span', () => {
    expect(formatCodeSpan('deploy/foo`bar.service')).toBe('``deploy/foo`bar.service``');
    expect(formatCodeSpan('deploy/foo``bar.service')).toBe('```deploy/foo``bar.service```');
    expect(formatCodeSpan('`leading')).toBe('`` `leading ``');
    expect(formatCodeSpan('trailing`')).toBe('`` trailing` ``');
  });
});

describe('renderSkipBody (warsaw-beer-bot#816, warsaw-beer-bot#526)', () => {
  it('renders unreviewed file list when unreviewed files exist', () => {
    const body = wrapBody(
      renderSkipBody({
        unreviewed: ['deploy/warsaw-beer-bot.service', 'deploy/sudoers.d/warsaw-beer-bot'],
      }),
    );
    expect(body).toContain('<!-- ai-pr-review -->');
    expect(body).not.toContain('ai-pr-review-state');
    expect(body).toContain('2 changed file(s) not reviewed (outside reviewer scope)');
    expect(body).toContain('- `deploy/warsaw-beer-bot.service`');
    expect(body).toContain('- `deploy/sudoers.d/warsaw-beer-bot`');
  });

  it('truncates unreviewed file list exceeding MAX_UNREVIEWED_DISPLAY to prevent exceeding GitHub body limits', () => {
    const unreviewed = Array.from({ length: 65 }, (_, i) => `deploy/file_${i}.service`);
    const body = renderSkipBody({ unreviewed });
    expect(body).toContain('65 changed file(s) not reviewed (outside reviewer scope):');
    expect(body).toContain('- `deploy/file_0.service`');
    expect(body).toContain(`- \`deploy/file_${MAX_UNREVIEWED_DISPLAY - 1}.service\``);
    expect(body).not.toContain(`- \`deploy/file_${MAX_UNREVIEWED_DISPLAY}.service\``);
    expect(body).toContain('- … and 15 more file(s)');
  });

  it('renders documentation notice when all changed files are ignored assets', () => {
    const body = wrapBody(renderSkipBody({ unreviewed: [] }));
    expect(body).toContain('<!-- ai-pr-review -->');
    expect(body).not.toContain('ai-pr-review-state');
    expect(body).toContain(
      'No reviewable code changed in this pull request (all changed files are documentation or ignored assets).',
    );
  });
});

describe('isSkipReview (warsaw-beer-bot#816)', () => {
  it('returns true for genuine skip review comments', () => {
    const skip1 = wrapBody(renderSkipBody({ unreviewed: ['deploy/a.service'] }));
    const skip2 = wrapBody(renderSkipBody({ unreviewed: [] }));
    expect(isSkipReview(skip1)).toBe(true);
    expect(isSkipReview(skip2)).toBe(true);
  });

  it('returns false for reviews without marker or normal reviews', () => {
    expect(isSkipReview('Some random comment')).toBe(false);
    expect(
      isSkipReview(
        '<!-- ai-pr-review -->\n\n## 🤖 AI PR Review\n\nNo verified findings.\n\n<!-- ai-pr-review-state ... -->',
      ),
    ).toBe(false);
  });

  it('returns false for reviews with open findings even if findings quote contains "**Review skipped:**"', () => {
    const findingReview = `<!-- ai-pr-review -->\n\n## 🤖 AI PR Review\n\n### Open findings\n\n### 1. P2 — Quote mismatch\nWhere: src/a.ts:10\nQuote: const x = "**Review skipped:**";`;
    expect(isSkipReview(findingReview)).toBe(false);
  });
});

describe('filterReviewableFiles scope expansion (warsaw-beer-bot#816, warsaw-beer-bot#526)', () => {
  it('includes Python, shell, CJS, and extension/API HTML & CSS', () => {
    const files = [
      'scripts/ops/resource_monitor.py',
      'scripts/autodeploy/autodeploy.sh',
      'deploy/deploy.sh',
      'deploy/release/package_runtime.py',
      'deploy/release/payload-probe.cjs',
      'extension/scripts/zip-dist.py',
      'extension/src/popup/popup.html',
      'extension/src/popup/popup.css',
      'src/api/fest-print/index.html',
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
      'site/index.html',
      'docs/spec.md',
    ];
    expect(filterReviewableFiles(files, PATTERNS)).toEqual([
      'scripts/ops/resource_monitor.py',
      'scripts/autodeploy/autodeploy.sh',
      'deploy/deploy.sh',
      'deploy/release/package_runtime.py',
      'deploy/release/payload-probe.cjs',
      'extension/scripts/zip-dist.py',
      'extension/src/popup/popup.html',
      'extension/src/popup/popup.css',
      'src/api/fest-print/index.html',
    ]);
  });
});

describe('isBodyExcluded (warsaw-beer-bot#816)', () => {
  it('never excludes scripts/ops/test_run.py', () => {
    expect(isBodyExcluded('scripts/ops/test_run.py', PATTERNS)).toBe(false);
  });

  it('excludes Python tests and test helpers', () => {
    expect(isBodyExcluded('scripts/ops/test_test_run.py', PATTERNS)).toBe(true);
    expect(isBodyExcluded('scripts/ops/test_resource_monitor.py', PATTERNS)).toBe(true);
    expect(isBodyExcluded('deploy/release/test_publish.py', PATTERNS)).toBe(true);
    expect(isBodyExcluded('deploy/release/release_testkit.py', PATTERNS)).toBe(true);
    expect(isBodyExcluded('src/sources/http.test.ts', PATTERNS)).toBe(true);
    expect(isBodyExcluded('extension/tests/popup.test.ts', PATTERNS)).toBe(true);
  });

  it('does not exclude non-test files due to unanchored globs', () => {
    expect(isBodyExcluded('deploy/contest_foo.py', PATTERNS)).toBe(false);
    expect(isBodyExcluded('deploy/release/latest_x.py', PATTERNS)).toBe(false);
    expect(isBodyExcluded('deploy/release/package_runtime.py', PATTERNS)).toBe(false);
    expect(isBodyExcluded('scripts/ops/host_patch_collect.py', PATTERNS)).toBe(false);
  });
});


describe('bodyExclude', () => {
  it('excludes test bodies at any depth without touching source that merely contains "test"', () => {
    expect(matchesAny('src/storage/x.test.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('x.test.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('extension/src/a.test.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('tests/b.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('tests/a/b.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('src/domain/latest.ts', PATTERNS.bodyExclude)).toBe(false);
    expect(matchesAny('src/domain/triage-plan.ts', PATTERNS.bodyExclude)).toBe(false);
  });

  it('covers the second test root, which is reviewable but not under top-level tests/', () => {
    // extension/tests/setup.ts is a real file: filterReviewableFiles admits it
    // via `extension/**/*.ts`, while `tests/**/*.ts` is anchored at the repo
    // root and never matched it — so its body kept consuming the budget.
    expect(matchesAny('extension/tests/setup.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(matchesAny('extension/tests/helpers/dom.ts', PATTERNS.bodyExclude)).toBe(true);
    expect(filterReviewableFiles(['extension/tests/setup.ts'], PATTERNS)).toEqual([
      'extension/tests/setup.ts',
    ]);
  });

  it('does not let the second root leak into source directories that merely end in "tests"', () => {
    // The reason both roots are listed instead of `**/tests/**/*.ts`: that glob
    // compiles to /^.*tests\/.*[^/]*\.ts$/, which swallows src/contests/foo.ts.
    expect(matchesAny('src/contests/foo.ts', PATTERNS.bodyExclude)).toBe(false);
    expect(matchesAny('src/latests/bar.ts', PATTERNS.bodyExclude)).toBe(false);
  });

  it('does NOT remove test files from review scope', () => {
    expect(filterReviewableFiles(['src/a.test.ts'], PATTERNS)).toEqual(['src/a.test.ts']);
  });
});

describe('contextReader', () => {
  it('hides a test body and passes every other read through untouched', () => {
    const read = contextReader((p) => `BODY OF ${p}`, PATTERNS);
    expect(read('src/a.test.ts')).toBeNull();
    expect(read('tests/helpers.ts')).toBeNull();
    expect(read('src/a.ts')).toBe('BODY OF src/a.ts');
  });

  it('propagates a null from the underlying reader', () => {
    expect(contextReader(() => null, PATTERNS)('src/a.ts')).toBeNull();
  });
});

describe('globToRegExp', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/deep/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.js')).toBe(false);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/sub/ci.yml')).toBe(false);
  });
});

describe('filterReviewableFiles', () => {
  it('keeps in-scope source files and drops ignored/out-of-scope ones', () => {
    const input = [
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      'extension/tests/fixtures/flasker.product.html',
      '.github/workflows/ci.yml',
      'src/e.js',
      'README.md',
      'spec.md',
      'docs/guide.md',
      'package-lock.json',
    ];
    expect(filterReviewableFiles(input, PATTERNS)).toEqual([
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      '.github/workflows/ci.yml',
    ]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('wrapBody', () => {
  it('embeds the hidden marker', () => {
    expect(wrapBody('hello')).toContain(MARKER);
    expect(wrapBody('hello')).toContain('hello');
  });
});

describe('upsertReview', () => {
  const ghDeps = (fetchFn: typeof fetch) => ({
    repo: 'o/r',
    prNumber: 7,
    token: 't',
    fetchFn,
  });

  it('creates a new top-level COMMENT review when none exists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]); // list
      return jsonResponse({ id: 1 }); // create
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('x'))).resolves.toBe('created');
    const create = calls[1]!;
    expect(create.init?.method).toBe('POST');
    expect(JSON.parse(create.init!.body as string).event).toBe('COMMENT');
  });

  it('updates the existing marker review instead of stacking a new one', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        return jsonResponse([{ id: 42, body: `${MARKER}\nold`, user: { type: 'Bot' } }]);
      }
      return jsonResponse({ id: 42 });
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('new'))).resolves.toBe('updated');
    const update = calls[1]!;
    expect(update.init?.method).toBe('PUT');
    expect(update.url).toContain('/reviews/42');
  });

  it('fails loudly with status + body when the post is rejected', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse([]); // list ok
      return jsonResponse({ message: 'Forbidden' }, 403); // create rejected
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('x'))).rejects.toThrow(
      /create review HTTP 403.*Forbidden/,
    );
  });
});

// Windows without the symlink privilege cannot make a link (EPERM); CI on Linux can. Any other
// error from the probe is a real failure and propagates.
function probeSymlink(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'detent-pr-review-probe-'));
  writeFileSync(join(probeDir, 'target'), 'x');
  try {
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}
const canSymlink = probeSymlink();

describe('readReviewableFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detent-pr-review-symlink-'));

  it('reads a regular file', () => {
    const p = join(dir, 'real.ts');
    writeFileSync(p, 'export const a = 1;\n');
    expect(readReviewableFile(p)).toBe('export const a = 1;\n');
  });

  it.runIf(canSymlink)('refuses to follow a symlink instead of shipping the target to the model', () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'SUPER_SECRET_TOKEN\n');
    const link = join(dir, 'leak.ts');
    symlinkSync(secret, link);
    expect(readReviewableFile(link)).toBeNull();
  });

  it('returns null for a directory and for a missing path', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(readReviewableFile(sub)).toBeNull();
    expect(readReviewableFile(join(dir, 'nope.ts'))).toBeNull();
  });
});

const PR: PrContext = {
  repo: 'o/r',
  prNumber: 7,
  baseRef: 'main',
  prTitle: 'Title',
  prBody: 'Body',
  githubToken: 't',
};

const RUN: RunSettings = {
  settings: { patterns: PATTERNS, findPrompt: 'instructions', verifyPrompt: 'instructions', scope: 'scope-1', configured: {} },
  provider: PROVIDERS.openai,
  apiKey: 'sk-test',
  findModel: 'gpt-5.5',
  verifyModel: 'gpt-5.5',
};

const FILE_BODY = "function f() {\n  return 'not_found';\n}\n";
const DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' function f() {',
  "+  return 'not_found';",
  ' }',
].join('\n');

const FINDING = {
  file: 'src/a.ts',
  start_line: 2,
  end_line: 2,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'high',
};

describe('runReview — each stage calls its own model', () => {
  // Until 2026-09-22 both defaults were the same string, so nothing could tell a
  // swapped pair from a correct one and no test did. find is gpt-5.6-sol now and
  // verify is still gpt-5.5, so a swap would quietly bill the wrong model and
  // change what the reviewer finds, with every existing test still green.
  // Distinct sentinels here rather than the real ids: this pins the WIRING, and
  // it must not need editing the next time a model is chosen by measurement.
  it('sends the find model on the find call and the verify model on the verify call', async () => {
    const models: string[] = [];
    const capture = (async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string) as { model: string };
      models.push(sent.model);
      const content =
        models.length === 1
          ? JSON.stringify({ findings: [FINDING] })
          : JSON.stringify({
              verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 returns not_found' }],
            });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
        text: async () => content,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runReview(
      PR,
      { ...RUN, findModel: 'find-sentinel', verifyModel: 'verify-sentinel' },
      deps({ openaiFetch: capture, githubFetch: githubFetch(null).fetchFn }),
    );

    expect(models).toEqual(['find-sentinel', 'verify-sentinel']);
  });
});

function openaiFetch(responses: string[]): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const content = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      }),
      text: async () => content,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    headSha: 'b'.repeat(40),
    hasCommit: () => true,
    isAncestor: () => true,
    listChangedFiles: () => ['src/a.ts'],
    getDiff: () => DIFF,
    readFile: () => FILE_BODY,
    log: () => {},
    openaiFetch: (undefined as unknown) as typeof fetch,
    githubFetch: (undefined as unknown) as typeof fetch,
    ...over,
  };
}

function githubFetch(existingBody: string | null): {
  fetchFn: typeof fetch;
  put: { method?: string; url?: string; body?: string };
} {
  const put: { method?: string; url?: string; body?: string } = {};
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return jsonResponse(
        existingBody === null ? [] : [{ id: 42, body: existingBody, user: { type: 'Bot' } }],
      );
    }
    put.method = init.method;
    put.url = url;
    put.body = JSON.parse(init.body as string).body;
    return jsonResponse({ id: 42 });
  }) as unknown as typeof fetch;
  return { fetchFn, put };
}

describe('runReview — full mode', () => {
  it('lists files once, from the PR diff, and never asks for a second list', async () => {
    const listed: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(null);

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          listed.push(spec);
          return ['src/a.ts'];
        },
      }),
    );
    expect(listed).toEqual(['origin/main...HEAD']);
  });

  it('reviews the whole PR when there is no previous review and publishes the finding', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [FINDING] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 returns not_found' }] }),
    ]);
    const gh = githubFetch(null);

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(2); // one find, one verify
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toContain('ai-pr-review-state');
  });

  it('posts a PR failure comment and still rejects when OpenAI returns an empty completion', async () => {
    const ai = openaiFetch(['']);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    const comment = calls.find(({ url }) => url.endsWith('/issues/7/comments'));
    expect(comment?.init?.method).toBe('POST');
    const body = JSON.parse(comment!.init!.body as string).body;
    expect(body).toContain(FAILURE_MARKER);
    expect(body).toContain('AI PR Review failed');
    expect(body).toContain('OpenAI returned an empty completion');
    expect(body).toContain('b'.repeat(40));
    expect(body).toContain('No new AI review was published for this run.');
    expect(body).not.toContain('this PR has not received an AI review');
  });

  it('reuses the failure marker comment across identical failed reruns', async () => {
    const issueComments: Array<{ id: number; body: string; user: { type: string } }> = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
        return jsonResponse(issueComments);
      }
      const body = JSON.parse(init.body as string).body;
      if (init.method === 'POST') {
        issueComments.push({ id: 99, body, user: { type: 'Bot' } });
      } else if (init.method === 'PATCH') {
        issueComments[0]!.body = body;
      }
      return jsonResponse({ id: 99, body });
    }) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ai = openaiFetch(['']);
      await expect(
        runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
      ).rejects.toThrow('OpenAI returned an empty completion');
    }

    const writes = calls.filter(({ init }) => init?.method === 'POST' || init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.init?.method).toBe('POST');
    expect(issueComments).toHaveLength(1);
  });

  it('updates a changed failure through the issue-comment endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
        return jsonResponse([{ id: 99, body: `${FAILURE_MARKER}\nold`, user: { type: 'Bot' } }]);
      }
      return jsonResponse({ id: 99 });
    }) as unknown as typeof fetch;

    const ai = openaiFetch(['']);
    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    const update = calls.find(({ init }) => init?.method === 'PATCH');
    expect(update?.url).toBe('https://api.github.com/repos/o/r/issues/comments/99');
  });

  it('searches every issue-comment page before creating a failure marker', async () => {
    const markerBody = [
      FAILURE_MARKER,
      '',
      '## ⚠️ AI PR Review failed',
      '',
      `The required AI review did not complete for commit \`${'b'.repeat(40)}\`.`,
      'The failing check remains authoritative. No new AI review was published for this run.',
      '',
      '> OpenAI returned an empty completion',
    ].join('\n');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
      if (url.includes('page=2')) {
        return jsonResponse([{ id: 99, body: markerBody, user: { type: 'Bot' } }]);
      }
      return {
        ...jsonResponse(Array.from({ length: 100 }, (_, id) => ({ id, body: 'ordinary' }))),
        headers: new Headers({
          link: '<https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=2>; rel="next"',
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const ai = openaiFetch(['']);
    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    expect(calls.some(({ url }) => url.includes('page=2'))).toBe(true);
    expect(calls.filter(({ init }) => init?.method === 'POST')).toHaveLength(0);
  });

  it('attempts to create the failure marker when listing comments fails', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
      if (!init?.method) return jsonResponse({ message: 'Bad gateway' }, 502);
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;

    const ai = openaiFetch(['']);
    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    expect(calls.some(({ url, init }) => url.endsWith('/issues/7/comments') && init?.method === 'POST')).toBe(true);
  });

  it('reserves a fresh timeout for creating the marker after lookup aborts', async () => {
    const signals: AbortSignal[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
      if (init?.signal) signals.push(init.signal);
      if (!init?.method) throw new DOMException('lookup timed out', 'AbortError');
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;

    const ai = openaiFetch(['']);
    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    expect(calls.some(({ init }) => init?.method === 'POST')).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]).not.toBe(signals[0]);
  });

  it('attempts marker creation when reading the lookup response body aborts', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
      if (!init?.method) {
        return {
          ...jsonResponse([]),
          json: async () => {
            throw new DOMException('lookup body timed out', 'AbortError');
          },
        } as unknown as Response;
      }
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;

    const ai = openaiFetch(['']);
    await expect(
      runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    expect(calls.some(({ init }) => init?.method === 'POST')).toBe(true);
  });

  it('keeps the original review error when posting the failure comment also fails', async () => {
    const ai = openaiFetch(['']);
    const logs: string[] = [];
    let failureSignal: AbortSignal | null | undefined;
    const githubFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse([]);
      failureSignal = init.signal;
      return jsonResponse({ message: 'Forbidden' }, 403);
    }) as unknown as typeof fetch;

    await expect(
      runReview(PR, RUN, deps({
        openaiFetch: ai.fetchFn,
        githubFetch,
        log: (message) => logs.push(message),
      })),
    ).rejects.toThrow('OpenAI returned an empty completion');
    expect(failureSignal).toBeInstanceOf(AbortSignal);
    expect(logs.some((message) => message.includes('failure comment could not be posted'))).toBe(
      true,
    );
  });
});

describe('skip comment lifecycle (warsaw-beer-bot#816, warsaw-beer-bot#526)', () => {
  it('posts skip comment on initial run with 0 reviewable files, and updates it on subsequent push with code', async () => {
    const ghInitial = githubFetch(null);
    await runReview(
      PR, RUN,
      deps({
        githubFetch: ghInitial.fetchFn,
        listChangedFiles: () => ['deploy/warsaw-beer-bot.service'],
      }),
    );
    expect(ghInitial.put.method).toBe('POST');
    expect(ghInitial.put.body).toContain('<!-- ai-pr-review -->');
    expect(ghInitial.put.body).not.toContain('ai-pr-review-state');
    expect(ghInitial.put.body).toContain('1 changed file(s) not reviewed (outside reviewer scope)');
    expect(ghInitial.put.body).toContain('- `deploy/warsaw-beer-bot.service`');

    const ghSecond = githubFetch(ghInitial.put.body!);
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: ghSecond.fetchFn,
        listChangedFiles: () => ['src/a.ts', 'deploy/warsaw-beer-bot.service'],
      }),
    );
    expect(ghSecond.put.method).toBe('PUT');
    expect(ghSecond.put.url).toContain('/pulls/7/reviews/42');
    expect(ghSecond.put.body).toContain('<!-- ai-pr-review -->');
    expect(ghSecond.put.body).toContain('ai-pr-review-state');
    expect(ghSecond.put.body).toContain('No verified findings.');
    expect(ghSecond.put.body).toContain('<sub>1 changed file(s) outside reviewer scope.</sub>');
  });

  it('posts docs-only skip comment when all files are ignored assets', async () => {
    const gh = githubFetch(null);
    await runReview(
      PR, RUN,
      deps({
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['docs/spec.md'],
      }),
    );
    expect(gh.put.method).toBe('POST');
    expect(gh.put.body).toContain('<!-- ai-pr-review -->');
    expect(gh.put.body).not.toContain('ai-pr-review-state');
    expect(gh.put.body).toContain(
      'No reviewable code changed in this pull request (all changed files are documentation or ignored assets).',
    );
  });

  it('retains existing non-skip review when state parsing failed on 0-reviewable push', async () => {
    const nonSkipBody =
      '<!-- ai-pr-review -->\n\n## 🤖 AI PR Review\n\n### Open findings\n\nExisting bug finding';
    const gh = githubFetch(nonSkipBody);
    const logs: string[] = [];
    await runReview(
      PR, RUN,
      deps({
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['deploy/warsaw-beer-bot.service'],
        log: (msg) => logs.push(msg),
      }),
    );
    expect(gh.put.body).toBeUndefined();
    expect(logs.some((l) => l.includes('retaining existing review'))).toBe(true);
  });

  it('retains existing review even if a finding quote contains "**Review skipped:**"', async () => {
    const reviewWithQuote =
      '<!-- ai-pr-review -->\n\n## 🤖 AI PR Review\n\n### Open findings\n\nQuote: const x = "**Review skipped:**";';
    const gh = githubFetch(reviewWithQuote);
    const logs: string[] = [];
    await runReview(
      PR, RUN,
      deps({
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['deploy/warsaw-beer-bot.service'],
        log: (msg) => logs.push(msg),
      }),
    );
    expect(gh.put.body).toBeUndefined();
    expect(logs.some((l) => l.includes('retaining existing review'))).toBe(true);
  });

  it('omits out-of-scope caption when mixed PR touches only reviewable code and docs/markdown', async () => {
    const gh = githubFetch(null);
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: () => [
          'src/a.ts',
          'docs/spec.md',
          'extension/CHANGELOG.md',
          'deploy/README.md',
        ],
      }),
    );
    expect(gh.put.body).toContain('No verified findings.');
    expect(gh.put.body).not.toContain('outside reviewer scope');
  });

  it('counts unreviewed files from prSpec in incremental mode when diffSpec differs', async () => {
    const storedState = renderState({
      v: 1,
      head: 'a'.repeat(40),
      findings: [
        {
          file: 'src/a.ts',
          quote: "return 'not_found';",
          matchedLine: 2,
          matchedEndLine: 2,
          claim: 'merge reported as failure',
          why_it_breaks: 'cron stats count a success as a miss',
          severity: 'P1',
          evidence: 'evidence',
        },
      ],
      spend: { usd: 0, runs: 1, unpriced: 0 },
    });
    const existingReview = `<!-- ai-pr-review -->\n\n## 🤖 AI PR Review\n\nNo verified findings.\n\n${storedState}`;
    const gh = githubFetch(existingReview);
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        hasCommit: (sha) => sha === 'a'.repeat(40) || sha === 'b'.repeat(40),
        isAncestor: (ancestor, desc) => ancestor === 'a'.repeat(40) && desc === 'b'.repeat(40),
        listChangedFiles: (spec) => {
          if (spec === 'origin/main...HEAD') {
            return ['src/a.ts', 'deploy/warsaw-beer-bot.service'];
          }
          return ['src/a.ts'];
        },
      }),
    );

    expect(gh.put.body).toContain('<sub>1 changed file(s) outside reviewer scope.</sub>');
  });
});

describe('runReview — test-file bodies', () => {
  const TEST_FILE = 'src/a.test.ts';
  const TEST_BODY = "it('guards', () => {\n  expect(scan(SRC, SCRIPTS)).toBe(0);\n});\n";
  const TEST_DIFF = [
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    '@@ -1,2 +1,3 @@',
    " it('guards', () => {",
    '+  expect(scan(SRC, SCRIPTS)).toBe(0);',
    ' });',
  ].join('\n');

  const TEST_FINDING = {
    file: TEST_FILE,
    start_line: 2,
    end_line: 2,
    quote: 'expect(scan(SRC, SCRIPTS)).toBe(0);',
    claim: 'the guard test scans a directory that need not exist',
    why_it_breaks: 'readdirSync throws ENOENT before the assertion runs',
    severity: 'P2',
    confidence: 'high',
  };

  function testFileDeps(over = {}) {
    return deps({
      listChangedFiles: () => [TEST_FILE],
      getDiff: () => TEST_DIFF,
      readFile: () => TEST_BODY,
      ...over,
    });
  }

  it('publishes a finding quoting a test file, although its body was never sent', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [TEST_FINDING] }),
      JSON.stringify({
        verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 calls scan(SRC, SCRIPTS)' }],
      }),
    ]);
    const gh = githubFetch(null);

    await runReview(PR, RUN, testFileDeps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    // The gate must have anchored the quote — which is only possible if it was
    // given the UNFILTERED reader. Filtered, this finding is silently dropped.
    expect(gh.put.body).toContain('the guard test scans a directory that need not exist');
  });

  it('sends the test file as diff-only, so its body never reaches the model', async () => {
    const bodies: string[] = [];
    const capture = (async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runReview(
      PR, RUN,
      testFileDeps({ openaiFetch: capture, githubFetch: githubFetch(null).fetchFn }),
    );

    const findRequest = bodies[0];
    // The diff still carries the changed line — that is what a finding anchors to.
    expect(findRequest).toContain('+  expect(scan(SRC, SCRIPTS)).toBe(0);');
    // …but the body block (`## <path>` + fence) and its section heading are gone,
    // and the model is told explicitly that it is seeing only a diff for this path.
    expect(findRequest).toContain('Files where you see only the diff');
    expect(findRequest).not.toContain('## src/a.test.ts');
    expect(findRequest).not.toContain('# Full contents of changed files (at HEAD)');
  });
});

describe('runReview — republish mode', () => {
  it('re-posts the previous body byte-for-byte and calls OpenAI zero times', async () => {
    const previous = `${MARKER}\n\nold body\n\n${renderState({
      v: 1,
      head: 'b'.repeat(40),
      findings: [],
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previous);

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toBe(previous);
  });
});

describe('runReview — incremental mode', () => {
  const previousState = (findings: unknown[]) =>
    `${MARKER}\n\nold\n\n${renderState({
      v: 1,
      head: 'a'.repeat(40),
      findings: findings as never,
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;

  const carried = {
    file: 'src/a.ts',
    quote: "return 'not_found';",
    matchedLine: 2,
    matchedEndLine: 2,
    claim: 'merge reported as failure',
    why_it_breaks: 'cron stats count a success as a miss',
    severity: 'P1',
    evidence: 'line 2 returns not_found',
  };

  it('diffs from the stored head, and lists the PR\'s own files only to scope that diff', async () => {
    const listed: string[] = [];
    const diffed: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          listed.push(spec);
          return ['src/a.ts'];
        },
        getDiff: (spec) => {
          diffed.push(spec);
          return DIFF;
        },
      }),
    );
    expect(listed).toEqual([`${'a'.repeat(40)}..HEAD`, 'origin/main...HEAD']);
    expect(diffed).toEqual([`${'a'.repeat(40)}..HEAD`]);
  });

  it('skips the find pass when everything since the stored head was merged in from the base (warsaw-beer-bot#742)', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [FINDING] })]);
    const gh = githubFetch(previousState([]));
    const logs: string[] = [];

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        log: (m) => logs.push(m),
        listChangedFiles: (spec) =>
          spec === 'origin/main...HEAD' ? ['src/domain/brewery-aliases.ts'] : ['scripts/cross-review/core.ts', 'scripts/cross-review/cli.ts'],
      }),
    );
    expect(ai.calls).toEqual([]);
    expect(logs).toContain(
      "::notice::AI review: 2 file(s) changed since the last review are not in this PR's own diff (merged in from the base, or reverted to it) — left out of scope.",
    );
  });

  it('reviews only the PR\'s own file out of a mixed push', async () => {
    const diffedFiles: string[][] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => (spec === 'origin/main...HEAD' ? ['src/a.ts'] : ['scripts/other.ts', 'src/a.ts']),
        getDiff: (_spec, files) => {
          diffedFiles.push(files);
          return DIFF;
        },
      }),
    );
    expect(diffedFiles).toEqual([['src/a.ts']]);
  });

  it('logs no merged-in notice on an ordinary push', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));
    const logs: string[] = [];

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn, log: (m) => logs.push(m) }));
    expect(logs.filter((l) => l.includes('merged in from the base'))).toEqual([]);
  });

  it('carries a still-anchored finding for free and does not re-publish it twice', async () => {
    // The find pass re-raises the very same finding; the gate must swallow it.
    const ai = openaiFetch([JSON.stringify({ findings: [FINDING] })]);
    const gh = githubFetch(previousState([carried]));

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(1); // find only — nothing to verify
    // Counted in the visible body only: the state block repeats every open
    // finding verbatim by design, so a whole-body count can never be 1.
    const visible = gh.put.body!.split('<!-- ai-pr-review-state')[0];
    expect(visible!.split('merge reported as failure')).toHaveLength(2);
    expect(gh.put.body).toContain('carried');
  });

  it('closes a finding whose quoted code was edited away and re-adjudicated as fixed', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'refuted', evidence: 'the function now returns merged' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => "function f() {\n  return 'merged';\n}\n",
      }),
    );

    expect(gh.put.body).toContain('Closed by this push');
    expect(gh.put.body).toContain('No verified findings');
  });

  it('keeps a re-checked finding open when the verifier confirms the fix did not close it', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'still returns not_found via the helper' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('the fix did not close this');
  });

  it('keeps a re-checked finding open when its verification errors, unlike a fresh one', async () => {
    const ai = {
      calls: [] as string[],
      fetchFn: (async (url: string, init?: RequestInit) => {
        ai.calls.push(url);
        if (ai.calls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
              usage: { prompt_tokens: 10, completion_tokens: 1 },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 400, text: async () => 'boom' } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    const gh = githubFetch(previousState([carried]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toMatch(/unverified this run/i);
  });

  it('skips the find call entirely when the push touched no reviewable file', async () => {
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      PR, RUN,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['docs/guide.md'],
      }),
    );
    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toContain('merge reported as failure'); // still published
  });

  it('accumulates the PR spend across runs in the state block', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    const state = parseStateFromBody(gh.put.body!);
    expect(state.spend.runs).toBe(2);
    expect(state.spend.usd).toBeGreaterThan(0.1);
  });
});

function parseStateFromBody(body: string) {
  const s = parseState(body);
  if (!s) throw new Error('no state in body');
  return s;
}

describe('findExistingReview', () => {
  it('returns the bot marker review so the body is read once and reused by the upsert', async () => {
    const gh = githubFetch(`${MARKER}\nbody here`);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toEqual({ id: 42, body: `${MARKER}\nbody here` });
  });

  it('returns null when the bot has never reviewed this PR', async () => {
    const gh = githubFetch(null);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toBeNull();
  });
});

// replay.ts calls buildReviewContext directly, so a body exclusion applied only
// on the CI side would leave the measurement harness assembling a different
// context than production — and replay is how every model and prompt decision
// in this project gets made. The asymmetry below is the correctness argument of
// the whole change, which is why it is pinned in source rather than trusted.
//
// Call sites are found by scanning src/pr-review/**/*.ts instead of a hardcoded file list, so a
// future third caller is guarded automatically rather than silently unscanned.
describe('context reader is applied at every call site', () => {
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) {
        out.push(...tsFiles(p));
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      out.push(p);
    }
    return out;
  }

  // Every CALL of `name(`, paired with its own balanced-paren argument text —
  // not a whole-file occurrence count, which a doc comment or an unrelated
  // second occurrence of the wrapped form can inflate independently of the
  // real call. Skips the `function buildReviewContext(` declaration itself.
  function callArgs(src: string, name: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`(function\\s+)?${name}\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (m[1]) continue; // declaration, not a call
      let depth = 1;
      let i = re.lastIndex;
      const start = i;
      while (depth > 0 && i < src.length) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      out.push(src.slice(start, i - 1));
    }
    return out;
  }

  it(
    'every buildReviewContext call wraps readFile in contextReader(…) as an inline object ' +
      'literal, and no fileContent: in the same file is wrapped (a hoisted params variable ' +
      'is not recognised by this guard — the call must stay inline)',
    () => {
      let sawACall = false;
      for (const file of tsFiles(SRC_DIR)) {
        const src = readFileSync(file, 'utf8');

        for (const args of callArgs(src, 'buildReviewContext')) {
          sawACall = true;
          expect(
            args,
            `${file}: buildReviewContext must be called with an inline object literal ` +
              'wrapping readFile: contextReader(…)',
          ).toMatch(/readFile:\s*contextReader\(/);
        }

        // The gate and verify must NOT be wrapped: they need the real bytes.
        const wrappedFileContent = src.match(/fileContent:\s*contextReader\(/g) ?? [];
        expect(
          wrappedFileContent,
          `${file}: fileContent: must never be wrapped in contextReader — the gate and ` +
            'verify need the real file bytes',
        ).toHaveLength(0);
      }
      expect(sawACall, 'the scan should have found at least one buildReviewContext call').toBe(
        true,
      );
    },
  );
});

describe('runReview — settings scope', () => {
  const stateBody = (scope: string | undefined) =>
    `${MARKER}\n\nold\n\n${renderState({
      v: 1,
      head: 'b'.repeat(40),
      findings: [],
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
      ...(scope === undefined ? {} : { scope }),
    })}`;

  it('reviews in full, not republish, when the settings changed since the stored review', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(stateBody('old-scope'));
    const logs: string[] = [];

    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn, log: (m) => logs.push(m) }));

    expect(ai.calls).toHaveLength(1);
    expect(logs.some((l) => l.includes('mode: full') && l.includes('settings changed'))).toBe(true);
  });

  it('writes the current scope into the new state', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(null);
    await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));
    expect(parseState(gh.put.body)!.scope).toBe('scope-1');
  });

  it('republishes when the scope is the same, and when the stored state has none', async () => {
    for (const stored of ['scope-1', undefined]) {
      const ai = openaiFetch(['{}']);
      const gh = githubFetch(stateBody(stored));
      await runReview(PR, RUN, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));
      expect(ai.calls).toEqual([]);
    }
  });
});

describe('runReview — provider and headers', () => {
  it('talks to the provider endpoint with its key, name and extra body', async () => {
    const seen: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    const capture = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, auth: headers.Authorization, body: JSON.parse(init!.body as string) as Record<string, unknown> });
      const content = JSON.stringify({ findings: [] });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        text: async () => content,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runReview(PR, { ...RUN, provider: PROVIDERS.openrouter, apiKey: 'or-key', findModel: 'vendor/model' }, deps({ openaiFetch: capture, githubFetch: githubFetch(null).fetchFn }));

    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer or-key');
    expect(seen[0]!.body.provider).toEqual({ require_parameters: true });
  });

  it('names the provider in the failure comment, and never prints the key', async () => {
    const comments: string[] = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse([]);
      if (url.endsWith('/issues/7/comments')) comments.push(JSON.parse(init.body as string).body as string);
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;
    const echoKey = (async () => ({ ok: false, status: 400, text: async () => 'bad key sk-ant-secret' }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      runReview(PR, { ...RUN, provider: PROVIDERS.anthropic, apiKey: 'sk-ant-secret', findModel: 'm' }, deps({ openaiFetch: echoKey, githubFetch })),
    ).rejects.toThrow(/Anthropic/);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Anthropic');
    expect(comments[0]).not.toContain('sk-ant-secret');
    expect(comments[0]).not.toContain('required AI review');
  });

  it('sends detent-pr-review as the GitHub User-Agent', async () => {
    const agents: string[] = [];
    const githubFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      agents.push((init?.headers as Record<string, string>)['User-Agent']!);
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: githubFetch });
    expect(agents).toEqual(['detent-pr-review']);
  });
});

describe('the package defaults', () => {
  it('review a markdown-only change as a skip, and keep the tests out of the bodies', () => {
    expect(filterReviewableFiles(['src/a.ts', 'README.md', 'docs/x.ts'], DEFAULT_PATTERNS)).toEqual(['src/a.ts']);
    expect(isBodyExcluded('src/a.test.ts', DEFAULT_PATTERNS)).toBe(true);
    expect(isBodyExcluded('tests/helpers/x.ts', DEFAULT_PATTERNS)).toBe(true);
    expect(isBodyExcluded('src/contests/foo.ts', DEFAULT_PATTERNS)).toBe(false);
  });
});
