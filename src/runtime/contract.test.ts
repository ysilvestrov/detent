import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeContract, parseRegistry, snapshotPackage, validateContract } from './contract.js';

function source() {
  const root = mkdtempSync(join(tmpdir(), 'detent-runtime-source-'));
  for (const name of ['dist', 'prompts', 'skills', 'constitution']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'package.json'), '{"name":"@ysilvestrov/detent","version":"1.0.0","type":"module"}');
  writeFileSync(join(root, 'dist/cli.js'), 'abc');
  return root;
}

describe('runtime contract', () => {
  test('snapshots bytes without unrelated project files', () => {
    const root = source();
    writeFileSync(join(root, 'secret.txt'), 'must not copy');
    const snapshot = snapshotPackage(root);
    expect(Object.keys(snapshot.contents)).toEqual(['dist/cli.js', 'package.json']);
    expect(snapshot.contract.version).toBe('1.0.0');
    expect(snapshot.contract.files['dist/cli.js']).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(snapshot.contents['dist/cli.js']?.toString()).toBe('abc');
  });
  test('refuses omitted runtime dependencies', () => {
    const root = source();
    writeFileSync(join(root, 'package.json'), '{"name":"@ysilvestrov/detent","version":"1.0.0","dependencies":{"x":"1"}}');
    expect(() => snapshotPackage(root)).toThrow(/runtime dependencies/);
  });
  test('refuses source aliases', () => {
    const root = source();
    symlinkSync(mkdtempSync(join(tmpdir(), 'detent-external-')), join(root, 'dist/alias'), 'junction');
    expect(() => snapshotPackage(root)).toThrow(/symbolic link/);
  });
  test.each(['../escape', 'C:/escape', 'dist/../outside', 'dist\\cli.js', 'dist//cli.js', 'dist/CON', 'other/file.js'])(
    'refuses inventory path %s', (path) => {
      expect(() => makeContract('1.0.0', { 'package.json': Buffer.from('{}'), 'dist/cli.js': Buffer.from('abc'), [path]: Buffer.from('x') })).toThrow(/path/);
    },
  );
  test('refuses a modified contract digest', () => {
    const contract = snapshotPackage(source()).contract;
    expect(() => validateContract({ ...contract, files: { ...contract.files, 'dist/cli.js': '0'.repeat(64) } })).toThrow(/digest/);
  });
  test('reads independent generations of two versions', () => {
    const entries = { [`1.0.0/${'a'.repeat(64)}`]: { generation: 'one' }, [`2.0.0/${'b'.repeat(64)}`]: { generation: 'two' } };
    expect(parseRegistry(JSON.stringify({ schemaVersion: 1, entries }))).toEqual({ schemaVersion: 1, entries });
  });
  test.each(['../outside', '/absolute', 'a/b', '..', 'CON'])('refuses generation %s', (generation) => {
    expect(() => parseRegistry(JSON.stringify({ schemaVersion: 1, entries: { [`1.0.0/${'a'.repeat(64)}`]: { generation } } }))).toThrow(/generation/);
  });
  test.each(['{}', '{"schemaVersion":2,"entries":{}}', '{"schemaVersion":1,"entries":[]}'])('refuses invalid registry %s', (text) => {
    expect(() => parseRegistry(text)).toThrow(/registry/);
  });
});
