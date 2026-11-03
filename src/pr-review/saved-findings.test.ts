import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFindings, saveFindings, type SavedFindings } from './saved-findings.js';

const SAVED: SavedFindings = {
  v: 1,
  pr: '418',
  head: 'abc123',
  base: 'def456',
  findModel: 'm/find',
  scope: 'scope-hash',
  raised: [
    { file: 'a.ts', start_line: 2, end_line: 2, quote: 'const x = 1;', claim: 'c', why_it_breaks: 'w', severity: 'P1', confidence: 'high' },
    { file: 'b.ts', start_line: 9, end_line: 9, quote: 'gone', claim: 'd', why_it_breaks: 'v', severity: 'P2', confidence: 'low' },
  ],
  kept: [
    { file: 'a.ts', start_line: 2, end_line: 2, quote: 'const x = 1;', claim: 'c', why_it_breaks: 'w', severity: 'P1', confidence: 'high', matchedLine: 3, matchedEndLine: 3 },
  ],
  dropped: [
    {
      finding: { file: 'b.ts', start_line: 9, end_line: 9, quote: 'gone', claim: 'd', why_it_breaks: 'v', severity: 'P2', confidence: 'low' },
      reason: 'quote_not_found',
    },
  ],
};

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'detent-findings-')), 'f.json');

/** Writes `SAVED` with one change and reads it back. */
function readChanged(change: Record<string, unknown>): SavedFindings {
  const path = tempFile();
  writeFileSync(path, JSON.stringify({ ...SAVED, ...change }));
  return readFindings(path);
}

describe('saved findings', () => {
  it('reads back what was saved, without loss', () => {
    const path = tempFile();
    saveFindings(path, SAVED);

    expect(readFindings(path)).toEqual(SAVED);
  });

  it('replaces the content of an existing file', () => {
    const path = tempFile();
    writeFileSync(path, 'old content that is longer than what replaces it'.repeat(100));
    saveFindings(path, SAVED);

    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(SAVED));
  });

  it('names v when the version is not 1', () => {
    expect(() => readChanged({ v: 2 })).toThrow('field "v"');
  });

  it('names kept when it is missing', () => {
    expect(() => readChanged({ kept: undefined })).toThrow('field "kept"');
  });

  it('names matchedLine when a kept finding has none', () => {
    const { matchedLine: _omitted, ...withoutLine } = SAVED.kept[0]!;
    expect(() => readChanged({ kept: [withoutLine] })).toThrow('kept[0]: field "matchedLine"');
  });

  it('names head when it is not a commit sha', () => {
    expect(() => readChanged({ head: '--upload-pack=x' })).toThrow('field "head"');
  });

  it('names the file when it is not JSON', () => {
    const path = tempFile();
    writeFileSync(path, '{not json');
    expect(() => readFindings(path)).toThrow(path);
  });
});
