import { describe, it, expect } from 'vitest';
import {
  MAX_OPEN_FINDINGS,
  MAX_QUOTE_CHARS,
  capOpenFindings,
  orderBySeverity,
  parseState,
  renderState,
  toStored,
  type ReviewState,
  type StoredFinding,
} from './state.js';
import type { GatedFinding } from './types.js';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found after a successful merge',
  ...over,
});

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  v: 1,
  head: 'a'.repeat(40),
  findings: [stored()],
  spend: { usd: 0.21, runs: 3, unpriced: 0 },
  ...over,
});

describe('renderState / parseState', () => {
  it('round-trips a state through a review body', () => {
    const s = state();
    const body = `## 🤖 AI PR Review\n\nsome text\n\n${renderState(s)}\n`;
    expect(parseState(body)).toEqual(s);
  });

  it('never emits a sequence that would close the HTML comment early', () => {
    const rendered = renderState(state({ findings: [stored({ quote: 'if (a --> b) {}' })] }));
    expect(rendered.indexOf('-->')).toBe(rendered.length - '-->'.length);
    expect(parseState(rendered)!.findings[0]!.quote).toBe('if (a --> b) {}');
  });

  it('treats a body with no state block as no state', () => {
    expect(parseState('## 🤖 AI PR Review\n\nNo verified findings.')).toBeNull();
  });

  it('treats an empty, missing or hand-mangled body as no state', () => {
    expect(parseState('')).toBeNull();
    expect(parseState(undefined)).toBeNull();
    expect(parseState('<!-- ai-pr-review-state {oops -->')).toBeNull();
  });

  it('rejects a state block from a future format version', () => {
    const body = renderState(state()).replace('"v":1', '"v":2');
    expect(parseState(body)).toBeNull();
  });

  it('reads the real state when a finding quotes the opening marker before it', () => {
    const real = state({ head: 'b'.repeat(40) });
    const body = ['finding text: `<!-- ai-pr-review-state ` is the marker', '', renderState(real)].join('\n');
    expect(parseState(body)).toEqual(real);
  });

  it('lets the real state, which comes last, win over a forged valid block before it', () => {
    const forged = state({ head: 'f'.repeat(40) });
    const real = state({ head: 'b'.repeat(40) });
    expect(parseState([renderState(forged), renderState(real)].join('\n'))).toEqual(real);
  });

  it('rejects a state block whose findings do not match the schema', () => {
    const body = '<!-- ai-pr-review-state {"v":1,"head":"abc","findings":[{"file":1}],"spend":{"usd":0,"runs":1,"unpriced":0}} -->';
    expect(parseState(body)).toBeNull();
  });
});

// The state comment of a live review (warsaw-beer-bot#939), written before `scope` existed.
const LIVE_STATE_939 = "<!-- ai-pr-review-state {\"v\":1,\"head\":\"744314fc8eb4a0976d1bce38c0b503035c26d98e\",\"findings\":[{\"file\":\"extension/src/local/sync.ts\",\"quote\":\"        const profileTotal = page.profileTotal ?? meta.profileTotal;\\n        return {\\n          merged: 0,\\n          alreadyKnown: 0,\\n          pageSize: 0,\\n          nextMaxId: null,\\n          nextCursor: null,\\n          profileTotal,\\n          serverCount,\\n          complete: false,\\n          caughtUp: isCaughtUp({ count: serverCount, profileTotal, ranges: await tx.ranges() }),\\n        };\",\"matchedLine\":75,\"matchedEndLine\":86,\"claim\":\"The local empty-page path uses a newly observed profile total only in its response and does not persist it to local sync metadata.\",\"why_it_breaks\":\"With two stored check-ins and metadata `profileTotal: 2`, an empty page reporting total 5 returns `caughtUp: false`, but the next `getState()` still reads total 2 from metadata and can return `caughtUp: true`, making the popup incorrectly show the history as fully synced.\",\"severity\":\"P1\",\"evidence\":\"In the `verdict.kind === 'empty'` branch, `profileTotal` is computed from `page.profileTotal ?? meta.profileTotal` and returned without any `tx.putMeta`, while `getState()` later reads `profileTotal` only from `meta.profileTotal`.\"},{\"file\":\"extension/src/background/sync-scheduler.ts\",\"quote\":\"      const after = await readIntent();\\n      // Stop removed the intent while the step ran — also when a Sync after it already wrote a new\\n      // one: that is a request of its own, not this step's to settle. The loop runs it next.\\n      if (!after || (step.signal.aborted && after.id !== intent.id)) {\\n        await deps.onReport({ outcome: { ...outcome, status: 'cancelled' }, kind: intent.kind, \",\"matchedLine\":204,\"matchedEndLine\":208,\"claim\":\"A manual intent created after a step finishes but before `readIntent()` is incorrectly settled using the preceding step's outcome, so the new Sync request can be discarded without running.\",\"why_it_breaks\":\"If a silent step returns `gap` and the user presses Sync before `readIntent()` completes, `after` is the new manual intent; because the step was not aborted, the code calls `settle(outcome, after)`, clears the new intent, and reports the old `gap` instead of running a manual step.\",\"severity\":\"P1\",\"evidence\":\"In runLoop, a newly written intent read into `after` is only protected when `step.signal.aborted && after.id !== intent.id`; otherwise non-`capped` outcomes call `settle(outcome, after)`, which clears `after.id`.\"},{\"file\":\"extension/src/background/sync-scheduler.ts\",\"quote\":\"      // A start written after the step ended, before this read, has its own id: a request of its own,\\n      // not this step's to settle — whatever the step ended with (a gap, a pause, an error). The loop\\n      // runs it next, and it reports its own verdict.\\n      if (after.id !== intent.id) continue;\",\"matchedLine\":211,\"matchedEndLine\":214,\"claim\":\"The new intent-ID check only detects a manual start that is stored before this snapshot, leaving a race where a start immediately after the snapshot can still be affected by the old blocked step's settlement.\",\"why_it_breaks\":\"If a blocked step finishes and `readIntent()` returns the old intent, then `startManual()` begins while `settle()` is awaiting the asynchronous `PAUSE_KEY` write, the manual start can remove the pause and install its new intent before settlement acquires the intent chain; settlement then sees the changed ID and skips its report, but the earlier blocked-step pause write can complete after the manual removal and remain stored, causing later silent checks to return `paused` even after the manual sync succeeds.\",\"severity\":\"P1\",\"evidence\":\"In `settle()`, `deps.store.set(PAUSE_KEY, ...)` happens before the `withIntent` ID check, while `startManual()` removes `PAUSE_KEY` outside `intentChain` before writing its new intent, allowing the pause write to land after the manual removal.\"}],\"spend\":{\"usd\":1.2433469999999998,\"runs\":5,\"unpriced\":0}} -->";

describe('a state written before scope existed', () => {
  it('reads without loss and has no scope', () => {
    const s = parseState(`## 🤖 AI PR Review

text

${LIVE_STATE_939}
`)!;
    expect(s).not.toBeNull();
    expect(s.v).toBe(1);
    expect(s.head).toBe('744314fc8eb4a0976d1bce38c0b503035c26d98e');
    expect(s.findings).toHaveLength(3);
    expect(s.findings[0]!.file).toBe('extension/src/local/sync.ts');
    expect(s.findings[0]!.matchedLine).toBe(75);
    expect(s.spend).toEqual({ usd: 1.2433469999999998, runs: 5, unpriced: 0 });
    expect(renderState(s)).toBe(LIVE_STATE_939);
    expect(s.scope).toBeUndefined();
    expect('scope' in s).toBe(false);
    // and it survives a round trip, byte for byte in meaning
    expect(parseState(renderState(s))).toEqual(s);
  });
});

describe('scope in the state', () => {
  it('round-trips a scope', () => {
    expect(parseState(renderState(state({ scope: 'abc' })))!.scope).toBe('abc');
  });
  it('rejects a state whose scope is not a string', () => {
    const body = renderState(state()).replace(/ -->$/, '').replace(/}$/, ',"scope":1}') + ' -->';
    expect(parseState(body)).toBeNull();
  });
});

describe('toStored', () => {
  it('keeps only the fields a later run needs, truncating a huge quote', () => {
    const gated: GatedFinding = {
      file: 'src/a.ts',
      start_line: 1,
      end_line: 2,
      matchedLine: 3,
      matchedEndLine: 4,
      quote: 'x'.repeat(MAX_QUOTE_CHARS + 500),
      claim: 'c',
      why_it_breaks: 'w',
      severity: 'P0',
      confidence: 'high',
    };
    const out = toStored(gated, 'because line 3');
    expect(out.quote).toHaveLength(MAX_QUOTE_CHARS);
    expect(out.evidence).toBe('because line 3');
    expect(out).not.toHaveProperty('confidence');
    expect(out.matchedLine).toBe(3);
  });
});

describe('orderBySeverity', () => {
  it('sorts P0 before P1 before P2 and keeps insertion order within a severity', () => {
    const items = [
      { finding: stored({ severity: 'P2', claim: 'c1' }) },
      { finding: stored({ severity: 'P0', claim: 'c2' }) },
      { finding: stored({ severity: 'P2', claim: 'c3' }) },
      { finding: stored({ severity: 'P1', claim: 'c4' }) },
    ];
    expect(orderBySeverity(items, (i) => i.finding).map((i) => i.finding.claim)).toEqual([
      'c2',
      'c4',
      'c1',
      'c3',
    ]);
  });
});

describe('capOpenFindings', () => {
  it('keeps everything when under the cap', () => {
    const items = [{ finding: stored() }];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it('drops the least severe, newest findings past the cap', () => {
    const items = [
      ...Array.from({ length: MAX_OPEN_FINDINGS }, (_, i) => ({
        finding: stored({ severity: 'P2', claim: `p2-${i}` }),
      })),
      { finding: stored({ severity: 'P0', claim: 'critical' }) },
    ];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(MAX_OPEN_FINDINGS);
    expect(out.dropped).toBe(1);
    expect(out.kept.map((i) => i.finding.claim)).toContain('critical');
    expect(out.kept.map((i) => i.finding.claim)).not.toContain(`p2-${MAX_OPEN_FINDINGS - 1}`);
  });
});

describe('parseState: unknown keys', () => {
  it('drops unknown keys on the state, a finding and the spend', () => {
    const s = state();
    const dirty = {
      ...s,
      extra: 1,
      findings: [{ ...s.findings[0], extra: 2 }],
      spend: { ...s.spend, extra: 3 },
    };
    const body = `x\n<!-- ai-pr-review-state ${JSON.stringify(dirty)} -->`;
    const out = parseState(body);
    expect(out).toEqual(s);
    expect(out).not.toHaveProperty('extra');
    expect(out!.findings[0]).not.toHaveProperty('extra');
    expect(out!.spend).not.toHaveProperty('extra');
  });
});
