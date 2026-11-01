import { describe, test, expect } from 'vitest';
import { classifyResult, markerReason, renderPrompt, successBody, failedBody, markerLine } from './protocol.js';

const NO_RESULT = { kind: 'failed', reason: 'output does not end with a CROSS-REVIEW-RESULT line' };

describe('classifyResult', () => {
  test('zero findings only from the explicit line', () => {
    expect(classifyResult('looked at everything\nCROSS-REVIEW-RESULT: 0 findings\n')).toEqual({ kind: 'ok', findings: 0 });
  });
  test('singular form is accepted', () => {
    expect(classifyResult('1. bug\nCROSS-REVIEW-RESULT: 1 finding')).toEqual({ kind: 'ok', findings: 1 });
  });
  test('a multi-digit count is read whole', () => {
    expect(classifyResult('CROSS-REVIEW-RESULT: 12 findings')).toEqual({ kind: 'ok', findings: 12 });
  });
  test('the last result line wins when the prompt is quoted back', () => {
    expect(classifyResult('CROSS-REVIEW-RESULT: 0 findings\n...\nCROSS-REVIEW-RESULT: 3 findings')).toEqual({ kind: 'ok', findings: 3 });
  });
  test('a result line quoted in a code fence is not the verdict when the report ends otherwise', () => {
    expect(classifyResult('Example:\n```\nCROSS-REVIEW-RESULT: 0 findings\n```\nI could not read the diff.')).toEqual(NO_RESULT);
  });
  test('an indented result line is not the result line', () => {
    expect(classifyResult('  CROSS-REVIEW-RESULT: 0 findings')).toEqual(NO_RESULT);
  });
  test('trailing blank lines after the result line are ignored', () => {
    expect(classifyResult('findings\nCROSS-REVIEW-RESULT: 2 findings\n\n')).toEqual({ kind: 'ok', findings: 2 });
  });
  test('CRLF line endings still end on the result line', () => {
    expect(classifyResult('1. bug\r\nCROSS-REVIEW-RESULT: 1 finding\r\n')).toEqual({ kind: 'ok', findings: 1 });
  });
  test('text after the count on the same line is not the result line', () => {
    expect(classifyResult('CROSS-REVIEW-RESULT: 2 findings, all minor')).toEqual(NO_RESULT);
  });
  test('the template placeholder is not a count', () => {
    expect(classifyResult('CROSS-REVIEW-RESULT: <n> findings')).toEqual(NO_RESULT);
  });
  test('empty output is a failure, never zero findings', () => {
    expect(classifyResult('')).toEqual(NO_RESULT);
  });
  test('whitespace-only output is a failure', () => {
    expect(classifyResult(' \n\n\t')).toEqual(NO_RESULT);
  });
  test('output without the result line is a failure', () => {
    expect(classifyResult('Looks good to me!')).toEqual(NO_RESULT);
  });
});

describe('markerReason', () => {
  test('a short single line passes through', () => {
    expect(markerReason('exited with code 1')).toBe('exited with code 1');
  });
  test('only the first non-empty line, trimmed', () => {
    expect(markerReason('\n  git diff origin/mian...abc failed: fatal: bad revision  \nusage: git diff\n')).toBe('git diff origin/mian...abc failed: fatal: bad revision');
  });
  test('exactly 200 characters is not cut', () => {
    expect(markerReason('a'.repeat(200))).toBe('a'.repeat(200));
  });
  test('201 characters is cut to 199 plus an ellipsis', () => {
    expect(markerReason('a'.repeat(201))).toBe(`${'a'.repeat(199)}…`);
  });
  test('the cut never splits a character outside the BMP', () => {
    expect(markerReason(`${'a'.repeat(198)}😀bc`)).toBe(`${'a'.repeat(198)}😀…`);
  });
  test('empty input still gives a reason', () => {
    expect(markerReason('')).toBe('unknown error');
  });
  test('whitespace-only input still gives a reason', () => {
    expect(markerReason('  \n\n')).toBe('unknown error');
  });
});

describe('renderPrompt', () => {
  test('fills every placeholder, repeated ones included', () => {
    expect(renderPrompt('{{branch}}@{{sha}} vs {{base}}: {{diffPath}} ({{sha}})', {
      base: 'origin/main', sha: 'abc1234', branch: 'b', diffPath: '/t/d.diff',
    })).toBe('b@abc1234 vs origin/main: /t/d.diff (abc1234)');
  });
  test('a template without placeholders is returned as is', () => {
    expect(renderPrompt('no placeholders here', {})).toBe('no placeholders here');
  });
  test('an empty value fills its placeholder with nothing', () => {
    expect(renderPrompt('[{{x}}]', { x: '' })).toBe('[]');
  });
  test('a value that looks like a placeholder is not expanded again', () => {
    expect(renderPrompt('{{a}}', { a: '{{b}}' })).toBe('{{b}}');
  });
  test('an unknown placeholder is an error, not silent text', () => {
    expect(() => renderPrompt('{{spec}}', { base: 'x', sha: 'y', branch: 'z', diffPath: 'w' })).toThrow('unfilled placeholder {{spec}}');
  });
  test('an inherited Object name is not a filled placeholder', () => {
    expect(() => renderPrompt('{{constructor}}', { base: 'x', sha: 'y', branch: 'z', diffPath: 'w' })).toThrow('unfilled placeholder {{constructor}}');
  });
});

describe('successBody', () => {
  const base = { reviewer: 'codex', model: 'gpt-6.1-sol', sha7: 'abc1234', author: 'claude', findings: 2, fallbacks: [] };
  test('reviewer, model, sha, author and count, with the fixed/rejected stub', () => {
    expect(successBody(base)).toBe('codex/gpt-6.1-sol @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected');
  });
  test('a model not given explicitly is named default', () => {
    expect(successBody({ reviewer: 'claude', sha7: 'abc1234', author: 'codex', findings: 0, fallbacks: [] }))
      .toBe('claude/default @ abc1234 (author: codex) — 0 findings: <f> fixed, <r> rejected');
  });
  test('an empty model is named default too', () => {
    expect(successBody({ ...base, model: '' })).toBe('codex/default @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected');
  });
  test('one finding keeps the plural noun: the marker does not agree the count', () => {
    expect(successBody({ ...base, findings: 1 })).toBe('codex/gpt-6.1-sol @ abc1234 (author: claude) — 1 findings: <f> fixed, <r> rejected');
  });
  test('one fallback is named with its reason', () => {
    expect(successBody({
      reviewer: 'agy', model: 'gemini-4-argon', sha7: 'abc1234', author: 'claude', findings: 3,
      fallbacks: [{ reviewer: 'codex', reason: 'usage limit' }],
    })).toBe('agy/gemini-4-argon @ abc1234 (author: claude) — 3 findings: <f> fixed, <r> rejected (fallback: codex — usage limit)');
  });
  test('two fallbacks are named in chain order', () => {
    expect(successBody({
      reviewer: 'claude', sha7: 'abc1234', author: 'agy', findings: 0,
      fallbacks: [{ reviewer: 'codex', reason: 'not installed' }, { reviewer: 'agy', reason: 'deny rule ineffective' }],
    })).toBe('claude/default @ abc1234 (author: agy) — 0 findings: <f> fixed, <r> rejected (fallback: codex — not installed; agy — deny rule ineffective)');
  });
  test('a long multi-line fallback reason is cut to its first line and 200 characters', () => {
    expect(successBody({ ...base, reviewer: 'agy', model: 'gemini-4-argon', fallbacks: [{ reviewer: 'codex', reason: `${'u'.repeat(250)}\nsecond line` }] }))
      .toBe(`agy/gemini-4-argon @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected (fallback: codex — ${'u'.repeat(199)}…)`);
  });
  test('an empty fallback reason becomes unknown error', () => {
    expect(successBody({ ...base, reviewer: 'agy', model: 'gemini-4-argon', fallbacks: [{ reviewer: 'codex', reason: '' }] }))
      .toBe('agy/gemini-4-argon @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected (fallback: codex — unknown error)');
  });
});

describe('failedBody', () => {
  test('author first, then every reviewer that failed, in chain order', () => {
    expect(failedBody('claude', [{ reviewer: 'codex', reason: 'usage limit' }, { reviewer: 'agy', reason: 'deny rule ineffective' }]))
      .toBe('failed (author: claude; codex: usage limit; agy: deny rule ineffective)');
  });
  test('one failure', () => {
    expect(failedBody('codex', [{ reviewer: 'claude', reason: 'timeout after 15 min' }])).toBe('failed (author: codex; claude: timeout after 15 min)');
  });
  test('no failures leaves only the author', () => {
    expect(failedBody('claude', [])).toBe('failed (author: claude)');
  });
  test('a long multi-line reason is cut to its first line and 200 characters', () => {
    expect(failedBody('claude', [{ reviewer: 'codex', reason: `\n${'e'.repeat(201)}\nmore` }])).toBe(`failed (author: claude; codex: ${'e'.repeat(199)}…)`);
  });
  test('an empty reason becomes unknown error', () => {
    expect(failedBody('claude', [{ reviewer: 'codex', reason: '  ' }])).toBe('failed (author: claude; codex: unknown error)');
  });
});

describe('markerLine', () => {
  test('diff mode prints the PR marker', () => {
    expect(markerLine('diff', 'codex/gpt-6.1-sol @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected'))
      .toBe('PR marker: Cross-review: codex/gpt-6.1-sol @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected');
  });
  test('spec mode prints the Spec-review header line', () => {
    expect(markerLine('spec', 'failed (author: claude; codex: timeout after 15 min)')).toBe('Spec marker: Spec-review: failed (author: claude; codex: timeout after 15 min)');
  });
});
