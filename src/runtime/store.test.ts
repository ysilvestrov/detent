import { expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeContract, type RuntimeSnapshot } from './contract.js';
import { verifyRuntime, withRuntimeLock } from './store.js';

const project = () => mkdtempSync(join(tmpdir(), 'detent-runtime-store-'));
function snapshot(version = '1.0.0', code = 'abc'): RuntimeSnapshot {
  const contents = { 'package.json': Buffer.from(JSON.stringify({ name: '@ysilvestrov/detent', version, type: 'module' })), 'dist/cli.js': Buffer.from(code) };
  return { contract: makeContract(version, contents), contents };
}

test('publishes bytes, reuses a verified generation and releases its lock', () => {
  const root = project();
  const s = snapshot();
  const result = withRuntimeLock(root, store => store.publish(s));
  expect(result.reused).toBe(false);
  const path = verifyRuntime(root, s.contract) as string;
  expect(readFileSync(join(path, 'dist/cli.js'), 'utf8')).toBe('abc');
  expect(withRuntimeLock(root, store => store.publish(s))).toEqual({ generation: result.generation, reused: true });
  expect(existsSync(join(root, '.detent/install.lock'))).toBe(false);
});

test('retains two versions and two digests of one version', () => {
  const root = project();
  const a = snapshot();
  const b = snapshot('2.0.0');
  const c = snapshot('1.0.0', 'other build');
  withRuntimeLock(root, store => { store.publish(a); store.publish(b); store.publish(c); });
  expect(readFileSync(join(verifyRuntime(root, a.contract) as string, 'dist/cli.js'), 'utf8')).toBe('abc');
  expect(readFileSync(join(verifyRuntime(root, b.contract) as string, 'package.json'), 'utf8')).toContain('2.0.0');
  expect(readFileSync(join(verifyRuntime(root, c.contract) as string, 'dist/cli.js'), 'utf8')).toBe('other build');
});

test('repairs corrupt bytes with a new generation, preserving the old copy', () => {
  const root = project();
  const s = snapshot();
  const first = withRuntimeLock(root, store => store.publish(s));
  const old = verifyRuntime(root, s.contract) as string;
  writeFileSync(join(old, 'dist/cli.js'), 'corrupt');
  expect(() => verifyRuntime(root, s.contract)).toThrow(/hash/);
  const repaired = withRuntimeLock(root, store => store.publish(s));
  expect(repaired.generation).not.toBe(first.generation);
  expect(readFileSync(join(old, 'dist/cli.js'), 'utf8')).toBe('corrupt');
  expect(readFileSync(join(verifyRuntime(root, s.contract) as string, 'dist/cli.js'), 'utf8')).toBe('abc');
});

test('does not steal an existing install lock or execute its action', () => {
  const root = project();
  mkdirSync(join(root, '.detent'));
  writeFileSync(join(root, '.detent/install.lock'), '{"pid":42}');
  expect(() => withRuntimeLock(root, store => store.publish(snapshot()))).toThrow(/locked.*42/);
  expect(existsSync(join(root, '.detent/runtime'))).toBe(false);
  expect(readFileSync(join(root, '.detent/install.lock'), 'utf8')).toBe('{"pid":42}');
});

test('rejects an unreadable registry rather than selecting another generation', () => {
  const root = project();
  mkdirSync(join(root, '.detent/local'), { recursive: true });
  writeFileSync(join(root, '.detent/local/runtime.json'), '{');
  expect(() => verifyRuntime(root, snapshot().contract)).toThrow(/registry/);
});

test('refuses writing through a linked .detent directory', () => {
  const root = project();
  const outside = project();
  symlinkSync(outside, join(root, '.detent'), 'junction');
  expect(() => withRuntimeLock(root, store => store.publish(snapshot()))).toThrow(/symbolic link/);
  expect(existsSync(join(outside, 'runtime'))).toBe(false);
});

test('releases the lock when publication fails and does not publish mismatching bytes', () => {
  const root = project();
  const s = snapshot();
  s.contents['dist/cli.js'] = Buffer.from('tampered');
  expect(() => withRuntimeLock(root, store => store.publish(s))).toThrow(/snapshot/);
  expect(verifyRuntime(root, s.contract)).toBe(null);
  expect(existsSync(join(root, '.detent/install.lock'))).toBe(false);
});
