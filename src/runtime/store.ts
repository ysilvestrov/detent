import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { makeContract, parseRegistry, runtimeKey, sha256, validateContract, type RuntimeContract, type RuntimeRegistry, type RuntimeSnapshot } from './contract.js';

const REGISTRY = '.detent/local/runtime.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Resolve from the project root without following a linked ancestor or a hard-linked file.
export function checkedPath(root: string, rel: string): string {
  const base = realpathSync(root);
  const full = resolve(base, rel);
  const inside = relative(base, full);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('runtime path outside project');
  let current = base;
  for (const part of inside.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`runtime symbolic link: ${current}`);
      if (stat.isFile() && stat.nlink !== 1) throw new Error(`runtime hard link: ${current}`);
    } catch (error) { if (!missing(error)) throw error; }
  }
  return full;
}

function registry(root: string): RuntimeRegistry {
  const path = checkedPath(root, REGISTRY);
  try { return parseRegistry(readFileSync(path, 'utf8')); }
  catch (error) {
    if (missing(error)) return { schemaVersion: 1, entries: {} };
    throw error;
  }
}

function checkCopy(root: string, rel: string, contract: RuntimeContract): string {
  const path = checkedPath(root, rel);
  const seen: string[] = [];
  const walk = (prefix: string): void => {
    const directory = checkedPath(root, join(rel, prefix));
    for (const name of readdirSync(directory).sort()) {
      const key = prefix ? `${prefix}/${name}` : name;
      const file = checkedPath(root, join(rel, key));
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(key);
      else if (stat.isFile()) {
        if (sha256(readFileSync(file)) !== contract.files[key]) throw new Error(`runtime hash mismatch: ${key}; reinstall to repair`);
        seen.push(key);
      } else throw new Error(`unsupported runtime file: ${key}`);
    }
  };
  walk('');
  if (JSON.stringify(seen.sort()) !== JSON.stringify(Object.keys(contract.files).sort())) throw new Error('runtime inventory mismatch; reinstall to repair');
  return path;
}

export function verifyRuntime(root: string, input: RuntimeContract): string | null {
  const contract = validateContract(input);
  const entry = registry(root).entries[runtimeKey(contract)];
  if (!entry) return null;
  return checkCopy(root, `.detent/runtime/${runtimeKey(contract)}/${entry.generation}`, contract);
}

export interface RuntimeStore {
  publish(snapshot: RuntimeSnapshot): { generation: string; reused: boolean };
}

// The callback owns the lock for the whole install transaction, including its future skill writes.
export function withRuntimeLock<T>(root: string, action: (store: RuntimeStore) => T): T {
  const lock = checkedPath(root, '.detent/install.lock');
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try { fd = openSync(lock, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`runtime install locked: ${readFileSync(lock, 'utf8')}`);
    throw error;
  }
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let active = true;
  try {
    writeFileSync(fd, owner);
    closeSync(fd);
    const store: RuntimeStore = {
      publish(snapshot) {
        if (!active) throw new Error('runtime store used after lock release');
        const contract = validateContract(snapshot.contract);
        if (makeContract(contract.version, snapshot.contents).digest !== contract.digest) throw new Error('runtime snapshot bytes differ from contract');
        const state = registry(root);
        const key = runtimeKey(contract);
        const old = state.entries[key];
        if (old) {
          try {
            checkCopy(root, `.detent/runtime/${key}/${old.generation}`, contract);
            return { generation: old.generation, reused: true };
          } catch (error) {
            // Repair corrupt bytes in a fresh directory, never write through a path alias.
            if (/symbolic link|hard link|outside project/.test(String(error))) throw error;
          }
        }
        const generation = randomUUID();
        const rel = `.detent/runtime/${key}/${generation}`;
        const directory = checkedPath(root, rel);
        mkdirSync(directory, { recursive: true });
        for (const [name, bytes] of Object.entries(snapshot.contents)) {
          const target = checkedPath(root, join(rel, name));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes, { flag: 'wx' });
        }
        checkCopy(root, rel, contract);
        state.entries[key] = { generation };
        const destination = checkedPath(root, REGISTRY);
        mkdirSync(dirname(destination), { recursive: true });
        const temporary = checkedPath(root, `${REGISTRY}.${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, destination);
        return { generation, reused: false };
      },
    };
    return action(store);
  } finally {
    active = false;
    // An altered lock is not ours to remove. Leave it for explicit recovery.
    if (readFileSync(checkedPath(root, '.detent/install.lock'), 'utf8') === owner) unlinkSync(lock);
  }
}
