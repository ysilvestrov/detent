import { describe, test, expect } from 'vitest';
import { MANIFEST_PATH, emptyManifest, hashContent, parseManifest, serializeManifest } from './manifest.js';

const H_ABC = 'edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb'; // sha256("abc\n")
const H_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const H_ALPHA = 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060'; // sha256("alpha\n")

describe('hashContent', () => {
  test('sha256 hex of the UTF-8 text', () => {
    expect(hashContent('abc\n')).toBe(H_ABC);
  });
  test('an empty text', () => {
    expect(hashContent('')).toBe(H_EMPTY);
  });
  test('CRLF hashes as LF', () => {
    expect(hashContent('abc\r\n')).toBe(H_ABC);
  });
  test('a lone CR is content', () => {
    expect(hashContent('abc\r')).toBe('e2af64b38bbaf25b74d1e999d27370bde03f62b612f43a3f8f548287079ef77e');
  });
});

describe('MANIFEST_PATH', () => {
  test('is .detent/manifest.json', () => {
    expect(MANIFEST_PATH).toBe('.detent/manifest.json');
  });
});

describe('parseManifest', () => {
  test('no file gives an empty manifest', () => {
    expect(parseManifest(null)).toEqual({ ok: true, manifest: { detentVersion: '', files: {}, blocks: {} } });
  });
  test('a full manifest is read as given', () => {
    const text = JSON.stringify({
      detentVersion: '0.1.0',
      files: { '.claude/skills/detent-a/SKILL.md': { sha256: H_ALPHA, version: '0.1.0' } },
      blocks: { 'CLAUDE.md': { sha256: H_ABC, version: '0.0.9' } },
    });
    expect(parseManifest(text)).toEqual({
      ok: true,
      manifest: {
        detentVersion: '0.1.0',
        files: { '.claude/skills/detent-a/SKILL.md': { sha256: H_ALPHA, version: '0.1.0' } },
        blocks: { 'CLAUDE.md': { sha256: H_ABC, version: '0.0.9' } },
      },
    });
  });
  test('extra keys in an entry are dropped', () => {
    const text = `{"detentVersion":"0.1.0","files":{"a":{"sha256":"${H_ABC}","version":"1","x":1}},"blocks":{}}`;
    expect(parseManifest(text)).toEqual({ ok: true, manifest: { detentVersion: '0.1.0', files: { a: { sha256: H_ABC, version: '1' } }, blocks: {} } });
  });
  test('a leading BOM is not content', () => {
    expect(parseManifest('﻿{"detentVersion":"0.1.0","files":{},"blocks":{}}')).toEqual({
      ok: true, manifest: { detentVersion: '0.1.0', files: {}, blocks: {} },
    });
  });
  test('an empty file is broken', () => {
    expect(parseManifest('')).toEqual({ ok: false, error: '.detent/manifest.json is not valid JSON: Unexpected end of JSON input' });
  });
  test('an array is not a manifest', () => {
    expect(parseManifest('[]')).toEqual({ ok: false, error: '.detent/manifest.json must be a JSON object' });
  });
  test('detentVersion is required', () => {
    expect(parseManifest('{"files":{},"blocks":{}}')).toEqual({ ok: false, error: '.detent/manifest.json: "detentVersion" must be a string' });
  });
  test('files is required', () => {
    expect(parseManifest('{"detentVersion":"0.1.0","blocks":{}}')).toEqual({ ok: false, error: '.detent/manifest.json: "files" must be an object' });
  });
  test('blocks must be an object', () => {
    expect(parseManifest('{"detentVersion":"0.1.0","files":{},"blocks":[]}')).toEqual({ ok: false, error: '.detent/manifest.json: "blocks" must be an object' });
  });
  test('an entry without a version', () => {
    expect(parseManifest(`{"detentVersion":"0.1.0","files":{"a":{"sha256":"${H_ABC}"}},"blocks":{}}`)).toEqual({
      ok: false, error: '.detent/manifest.json: "files.a" must be { "sha256": <64 hex>, "version": <string> }',
    });
  });
  test('a sha256 that is not 64 lower-case hex', () => {
    expect(parseManifest(`{"detentVersion":"0.1.0","files":{},"blocks":{"CLAUDE.md":{"sha256":"${H_ABC.toUpperCase()}","version":"1"}}}`)).toEqual({
      ok: false, error: '.detent/manifest.json: "blocks.CLAUDE.md" must be { "sha256": <64 hex>, "version": <string> }',
    });
  });
});

describe('emptyManifest', () => {
  test('a fresh object each call', () => {
    const first = emptyManifest();
    first.files.x = { sha256: H_ABC, version: '1' };
    expect(emptyManifest()).toEqual({ detentVersion: '', files: {}, blocks: {} });
  });
});

describe('serializeManifest', () => {
  test('an empty manifest', () => {
    expect(serializeManifest({ detentVersion: '0.1.0', files: {}, blocks: {} })).toBe(
      '{\n  "detentVersion": "0.1.0",\n  "files": {},\n  "blocks": {}\n}\n',
    );
  });
  test('keys sorted, entries as sha256 then version, 2-space JSON, final newline', () => {
    const text = serializeManifest({
      detentVersion: '0.1.0',
      files: { 'b/x': { version: '0.1.0', sha256: H_ABC } as never, 'a/y': { sha256: H_ALPHA, version: '0.0.9' } },
      blocks: { 'CLAUDE.md': { sha256: H_EMPTY, version: '0.1.0' } },
    });
    expect(text).toBe(
      '{\n' +
      '  "detentVersion": "0.1.0",\n' +
      '  "files": {\n' +
      `    "a/y": {\n      "sha256": "${H_ALPHA}",\n      "version": "0.0.9"\n    },\n` +
      `    "b/x": {\n      "sha256": "${H_ABC}",\n      "version": "0.1.0"\n    }\n` +
      '  },\n' +
      '  "blocks": {\n' +
      `    "CLAUDE.md": {\n      "sha256": "${H_EMPTY}",\n      "version": "0.1.0"\n    }\n` +
      '  }\n' +
      '}\n',
    );
  });
});
