import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeContract { version: string; digest: string; files: Record<string, string> }
export interface RuntimeSnapshot { contract: RuntimeContract; contents: Record<string, Buffer> }
export interface RuntimeRegistry { schemaVersion: 1; entries: Record<string, { generation: string }> }

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const HASH = /^[a-f0-9]{64}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ROOTS = ['dist', 'prompts', 'skills', 'constitution'];
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const runtimeKey = (c: Pick<RuntimeContract, 'version' | 'digest'>): string => `${c.version}/${c.digest}`;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
    && !value.endsWith('.') && !RESERVED.test(value);
}

export function safeInventoryPath(path: string): boolean {
  const parts = path.split('/');
  return (path === 'package.json' || (parts.length > 1 && ROOTS.includes(parts[0] ?? '')))
    && parts.every(safeComponent);
}

function contractDigest(version: string, files: Record<string, string>): string {
  return sha256(JSON.stringify({ version, files }));
}

export function validateContract(value: unknown): RuntimeContract {
  if (!record(value) || typeof value.version !== 'string' || !VERSION.test(value.version)
    || !record(value.files) || typeof value.digest !== 'string' || !HASH.test(value.digest)) {
    throw new Error('invalid runtime contract');
  }
  const files: Record<string, string> = {};
  for (const path of Object.keys(value.files).sort()) {
    const hash = value.files[path];
    if (!safeInventoryPath(path) || typeof hash !== 'string' || !HASH.test(hash)) throw new Error(`invalid runtime path/hash: ${path}`);
    files[path] = hash;
  }
  if (!files['package.json'] || !files['dist/cli.js']) throw new Error('runtime contract requires package.json and dist/cli.js');
  if (contractDigest(value.version, files) !== value.digest) throw new Error('runtime contract digest differs');
  return { version: value.version, digest: value.digest, files };
}

export function makeContract(version: string, contents: Readonly<Record<string, Buffer>>): RuntimeContract {
  const files = Object.fromEntries(Object.keys(contents).sort().map((path) => [path, sha256(contents[path] as Buffer)]));
  return validateContract({ version, files, digest: contractDigest(version, files) });
}

export function snapshotPackage(source: string): RuntimeSnapshot {
  const contents: Record<string, Buffer> = {};
  const visit = (path: string): void => {
    const full = join(source, ...path.split('/'));
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`runtime source symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile()) {
      if (!safeInventoryPath(path)) throw new Error(`invalid runtime path: ${path}`);
      contents[path] = readFileSync(full);
    } else throw new Error(`unsupported runtime file: ${path}`);
  };
  visit('package.json');
  const pkg: unknown = JSON.parse((contents['package.json'] as Buffer).toString('utf8'));
  if (!record(pkg) || pkg.name !== '@ysilvestrov/detent' || typeof pkg.version !== 'string') throw new Error('invalid runtime package identity');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pkg[field] !== undefined && (!record(pkg[field]) || Object.keys(pkg[field]).length !== 0)) {
      throw new Error('runtime dependencies require a new delivery contract');
    }
  }
  for (const path of ROOTS) visit(path);
  const ordered = Object.fromEntries(Object.keys(contents).sort().map((path) => [path, contents[path] as Buffer]));
  return { contract: makeContract(pkg.version, ordered), contents: ordered };
}

export function parseRegistry(text: string): RuntimeRegistry {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('invalid runtime registry JSON'); }
  if (!record(value) || value.schemaVersion !== 1 || !record(value.entries)) throw new Error('invalid runtime registry');
  const entries: RuntimeRegistry['entries'] = {};
  for (const key of Object.keys(value.entries).sort()) {
    const parts = key.split('/');
    if (parts.length !== 2 || !VERSION.test(parts[0] ?? '') || !HASH.test(parts[1] ?? '')) throw new Error('invalid runtime registry key');
    const entry = value.entries[key];
    if (!record(entry) || !safeComponent(entry.generation)) throw new Error('invalid runtime generation');
    entries[key] = { generation: entry.generation };
  }
  return { schemaVersion: 1, entries };
}
