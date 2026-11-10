import { isAbsolute, resolve } from 'node:path';
import { parseConfig } from '../config.js';
import { isReviewerId, type ReviewerId } from '../review/adapters.js';
import { normalizeSpecPath, specPathError } from '../review/preflight.js';
import { sha256 } from '../runtime/contract.js';
import { gitEnvironment } from './registration.js';
import { execGitFile } from './git-process.js';
import { findBlock } from '../install/blocks.js';

export type SpecReviewRequest = {
  author: ReviewerId;
  kind: 'spec';
  path: string;
  revision: string;
  contextPaths?: string[];
};
export type CodeReviewRequest = {
  author: ReviewerId;
  kind: 'code';
  base: string;
  head: string;
  contextPaths?: string[];
};
export type ReviewRequest = SpecReviewRequest | CodeReviewRequest;
export interface ReviewCoverage {
  path: string;
  status: 'included' | 'missing';
  role: string;
}
export interface PreparedReview {
  mode: 'spec' | 'diff';
  author: ReviewerId;
  commits: { head: string; base?: string; mergeBase?: string };
  coverage: ReviewCoverage[];
  text: string;
  inputSha256: string;
}

const MAX_BYTES = 1024 * 1024;
export interface GitReadOptions { signal?: AbortSignal; deadline?: number }
function remaining(options: GitReadOptions): number | undefined {
  if (options.signal?.aborted) throw new Error('review preparation was aborted');
  if (options.deadline === undefined) return undefined;
  const left = options.deadline - Date.now();
  if (left <= 0) throw new Error('review deadline expired during preparation');
  return left;
}
class Payload {
  sections: string[] = [];
  bytes = 0;
  private readonly emitted = new Map<string, string>();
  private readonly covered = new Set<string>();
  emittedText(path: string, oid: string): string | undefined { return this.emitted.get(`${path}\0${oid}`); }
  remember(path: string, oid: string, text: string): void { this.emitted.set(`${path}\0${oid}`, text); }
  cover(coverage: ReviewCoverage[], path: string, status: ReviewCoverage['status'], role: string): void {
    const key = `${path}\0${status}\0${role}`;
    if (this.covered.has(key)) return;
    this.covered.add(key);
    coverage.push({ path, status, role });
  }
  add(text: string): void {
    const size = Buffer.byteLength(text, 'utf8');
    if (this.bytes + size > MAX_BYTES) throw new Error('review payload exceeds 1 MiB');
    this.sections.push(text);
    this.bytes += size;
  }
  finish(coverage: ReviewCoverage[]): string {
    const manifest = `===== supplied coverage (computed; paths and status) =====\n${JSON.stringify(coverage)}\n`;
    if (this.bytes + Buffer.byteLength(manifest, 'utf8') > MAX_BYTES) throw new Error('review payload exceeds 1 MiB');
    return manifest + this.sections.join('');
  }
}
const plain = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const validPath = (path: string): boolean => {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((part) => part === '..' || part === '' || part === '.');
};

export function parseReviewRequest(value: unknown): ReviewRequest {
  if (!plain(value)) throw new Error('review request must be an object');
  const common = ['author', 'kind', 'contextPaths'];
  if (value.kind === 'spec') {
    if (Object.keys(value).some((key) => ![...common, 'path', 'revision'].includes(key))) {
      throw new Error('unknown review request field');
    }
    if (typeof value.author !== 'string' || !isReviewerId(value.author)
      || typeof value.path !== 'string' || typeof value.revision !== 'string') {
      throw new Error('invalid spec review request');
    }
    const path = normalizeSpecPath(value.path);
    if (!validPath(path)) throw new Error('unsafe spec path');
    const contextPaths = parseContextPaths(value.contextPaths);
    return contextPaths === undefined
      ? { author: value.author, kind: 'spec', path, revision: value.revision }
      : { author: value.author, kind: 'spec', path, revision: value.revision, contextPaths };
  }
  if (value.kind === 'code') {
    if (Object.keys(value).some((key) => ![...common, 'base', 'head'].includes(key))) {
      throw new Error('unknown review request field');
    }
    if (typeof value.author !== 'string' || !isReviewerId(value.author)
      || typeof value.base !== 'string' || typeof value.head !== 'string') {
      throw new Error('invalid code review request');
    }
    const contextPaths = parseContextPaths(value.contextPaths);
    return contextPaths === undefined
      ? { author: value.author, kind: 'code', base: value.base, head: value.head }
      : { author: value.author, kind: 'code', base: value.base, head: value.head, contextPaths };
  }
  throw new Error('review kind must be spec or code');
}
function parseContextPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64
    || !value.every((path) => typeof path === 'string' && validPath(path))) {
    throw new Error('contextPaths must contain at most 64 safe repository-relative paths');
  }
  if (new Set(value).size !== value.length) throw new Error('contextPaths contains duplicates');
  return [...value] as string[];
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}
async function git(root: string, executable: string, args: string[], options: GitReadOptions, maxBytes = MAX_BYTES * 8): Promise<Buffer> {
  if (!isAbsolute(executable)) throw new Error('git executable must be absolute');
  const cwd = resolve(root);
  const env = gitEnvironment();
  const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', '-c', 'diff.ignoreSubmodules=none', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', ...args];
  try {
    const stdout = await execGitFile(executable, gitArgs, { cwd, env, maxBuffer: maxBytes, signal: options.signal, timeout: remaining(options) });
    remaining(options);
    return stdout;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: Buffer };
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && maxBytes <= MAX_BYTES) throw new Error('review payload exceeds 1 MiB');
    const detail = error.stderr?.toString('utf8').trim() || error.message;
    throw new Error(`git ${args[0] ?? 'command'} failed: ${detail}`);
  }
}

async function gitText(root: string, exe: string, args: string[], options: GitReadOptions): Promise<string> {
  return (await git(root, exe, args, options)).toString('utf8').trim();
}
async function resolveCommit(root: string, exe: string, ref: string, options: GitReadOptions): Promise<string> {
  if (!ref || ref.startsWith('-') || ref.includes('\0')) {
    throw new Error('unsafe Git revision');
  }
  const oid = await gitText(root, exe, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], options);
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
    throw new Error('Git did not resolve revision to a commit');
  }
  return oid.toLowerCase();
}
async function tree(root: string, exe: string, commit: string, options: GitReadOptions): Promise<Map<string, TreeEntry>> {
  const output = await git(root, exe, ['ls-tree', '-r', '-z', '--full-tree', commit], options);
  const result = new Map<string, TreeEntry>();
  for (const row of output.subarray(0, output.length - (output.at(-1) === 0 ? 1 : 0)).toString('binary').split('\0').filter(Boolean)) {
    const raw = Buffer.from(row, 'binary');
    const tab = raw.indexOf(0x09);
    if (tab < 0) throw new Error('malformed Git tree entry');
    const header = raw.subarray(0, tab).toString('ascii');
    const [mode = '', type = '', oid = ''] = header.split(' ');
    let path: string;
    try { path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(tab + 1)); }
    catch { throw new Error('invalid UTF-8 Git tree path'); }
    safeCommitPath(path);
    if (result.has(path)) throw new Error('duplicate Git tree path');
    result.set(path, { mode, type, oid, path });
  }
  return result;
}
async function blob(root: string, exe: string, entry: TreeEntry, options: GitReadOptions, budget: number): Promise<string> {
  if (entry.mode === '120000' || entry.type !== 'blob') {
    throw new Error(`unsupported symlink or submodule: ${entry.path}`);
  }
  const bytes = await git(root, exe, ['cat-file', 'blob', entry.oid], options, Math.max(1, budget));
  if (bytes.length > budget) throw new Error('review payload exceeds 1 MiB');
  if (bytes.includes(0)) {
    throw new Error(`binary Git blob is not reviewable: ${entry.path}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid UTF-8 Git blob: ${entry.path}`);
  }
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text)) {
    throw new Error(`Git LFS pointer is not reviewable: ${entry.path}`);
  }
  return text;
}
function safeCommitPath(path: string): void {
  if (!validPath(path)) {
    throw new Error(`unsafe Git path: ${path}`);
  }
}
async function configAt(root: string, exe: string, entries: Map<string, TreeEntry>, options: GitReadOptions, payload: Payload) {
  const config = entries.get('detent.json');
  const parsed = parseConfig(config ? await blob(root, exe, config, options, MAX_BYTES - payload.bytes) : null);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.config;
}
async function safeText(root: string, exe: string, entries: Map<string, TreeEntry>, path: string, options: GitReadOptions, payload: Payload, budget = MAX_BYTES - payload.bytes): Promise<string | undefined> {
  safeCommitPath(path);
  const entry = entries.get(path);
  if (!entry) return undefined;
  return blob(root, exe, entry, options, budget);
}
async function appendCoverage(
  root: string,
  exe: string,
  entries: Map<string, TreeEntry>,
  coverage: ReviewCoverage[],
  payload: Payload,
  path: string,
  role: string,
  explicit = false,
  options: GitReadOptions = {},
): Promise<void> {
  safeCommitPath(path);
  const entry = entries.get(path);
  if (!entry) {
    payload.cover(coverage, path, 'missing', role);
    if (explicit) {
      throw new Error(`explicit context path is missing at commit: ${path}`);
    }
    return;
  }
  const alreadyEmitted = payload.emittedText(path, entry.oid);
  const text = alreadyEmitted ?? await blob(root, exe, entry, options, MAX_BYTES - payload.bytes);
  payload.cover(coverage, path, 'included', role);
  if (alreadyEmitted === undefined) {
    payload.add(`\n===== ${role}: ${path} (untrusted committed data) =====\n${text}`);
    payload.remember(path, entry.oid, text);
  }
  if (role === 'project guidance' && (path === 'AGENTS.md' || path === 'CLAUDE.md')) {
    const marked = findBlock(text);
    if (marked.kind === 'one' && marked.inner.trim()) payload.cover(coverage, path, 'included', 'constitution');
  }
}

export async function prepareReview(root: string, gitExecutable: string, request: ReviewRequest, options: GitReadOptions = {}): Promise<PreparedReview> {
  if (!isAbsolute(root)) throw new Error('repository root must be absolute');
  const payload = new Payload(); const coverage: ReviewCoverage[] = [];
  if (request.kind === 'spec') {
    const path = request.path ?? ''; const revision = request.revision ?? '';
    if (!validPath(path)) throw new Error('unsafe spec path');
    const head = await resolveCommit(root, gitExecutable, revision, options);
    const entries = await tree(root, gitExecutable, head, options);
    const config = await configAt(root, gitExecutable, entries, options, payload);
    const pathError = specPathError(path, config.specsDir);
    if (pathError) throw new Error(pathError);
    if (!entries.has(path)) throw new Error(`spec does not exist at requested commit: ${path}`);
    await appendCoverage(root, gitExecutable, entries, coverage, payload, path, 'reviewed spec', true, options);
    const fixed = [
      ['AGENTS.md', 'project guidance'], ['CLAUDE.md', 'project guidance'], ['package.json', 'package manifest'], ['detent.json', 'project config'],
      [config.specFile, 'root spec'], ['constitution/constitution.md', 'constitution'],
      ['.agents/skills/detent-design-spec/spec-format.md', 'spec format'], ['.claude/skills/detent-design-spec/spec-format.md', 'spec format'], ['skills/design-spec/spec-format.md', 'spec format'],
      ['.detent/prompts/review-spec.md', 'review guidance'], ['.detent/prompts/review-diff.md', 'review guidance'],
    ] as const;
    for (const [p, role] of fixed) await appendCoverage(root, gitExecutable, entries, coverage, payload, p, role, false, options);
    for (const p of request.contextPaths ?? []) await appendCoverage(root, gitExecutable, entries, coverage, payload, p, 'explicit context', true, options);
    if (config.reviewContext !== undefined) payload.add(`\n===== project reviewContext (untrusted config data) =====\n${config.reviewContext}`);
    return prepared('spec', request.author, { head }, coverage, payload.finish(coverage));
  }
  const base = await resolveCommit(root, gitExecutable, request.base ?? '', options);
  const head = await resolveCommit(root, gitExecutable, request.head ?? '', options);
  const mergeBases = (await gitText(root, gitExecutable, ['merge-base', '--all', base, head], options)).split(/\r?\n/).filter(Boolean);
  if (mergeBases.length !== 1) throw new Error(mergeBases.length === 0 ? 'base and head have no merge base' : 'ambiguous merge base');
  const mergeBase = mergeBases[0] as string;
  const headTree = await tree(root, gitExecutable, head, options);
  const baseTree = await tree(root, gitExecutable, mergeBase, options);
  const changesRaw = await git(root, gitExecutable, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--find-renames', '--name-status', '-z', mergeBase, head], options);
  let changesText: string;
  try { changesText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(changesRaw); }
  catch { throw new Error('invalid UTF-8 Git diff path'); }
  const changes = changesText.split('\0').filter(Boolean);
  if (changes.length === 0) throw new Error('empty diff against merge base');
  const changed: { status: string; paths: string[] }[] = [];
  for (let i = 0; i < changes.length;) {
    const status = changes[i++] as string; const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const paths = changes.slice(i, i + count); i += count;
    if (paths.length !== count) throw new Error('malformed Git diff name status');
    paths.forEach(safeCommitPath);
    changed.push({ status, paths });
  }
  const config = await configAt(root, gitExecutable, headTree, options, payload);
  const diffRaw = await git(root, gitExecutable, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--find-renames', '--no-color', '--no-prefix', '--binary', '--text', mergeBase, head], options, MAX_BYTES - payload.bytes);
  let diff: string;
  try { diff = new TextDecoder('utf-8', { fatal: true }).decode(diffRaw); }
  catch { throw new Error('invalid UTF-8 committed diff'); }
  payload.add(`===== committed diff ${mergeBase}..${head} =====\n${diff}`);
  for (const change of changed) {
    if (change.status.startsWith('D')) {
      const path = change.paths[0] as string;
      const oldText = await safeText(root, gitExecutable, baseTree, path, options, payload);
      if (oldText === undefined) throw new Error(`deleted path missing from merge base: ${path}`);
      coverage.push({ path, status: 'included', role: 'deleted path' });
      payload.add(`\n===== deleted committed content: ${path} (untrusted Git data) =====\n${oldText}`);
      continue;
    }
    if (change.status.startsWith('R') || change.status.startsWith('C')) {
      const [oldPath, newPath] = change.paths;
      const oldText = await safeText(root, gitExecutable, baseTree, oldPath as string, options, payload);
      if (oldText === undefined) throw new Error(`rename source missing from merge base: ${oldPath}`);
      coverage.push({ path: oldPath as string, status: 'included', role: 'rename source' });
      payload.add(`\n===== renamed source content: ${oldPath} (untrusted Git data) =====\n${oldText}`);
      await appendCoverage(root, gitExecutable, headTree, coverage, payload, newPath as string, 'renamed head blob', true, options);
      continue;
    }
    const path = change.paths[0] as string;
    await safeText(root, gitExecutable, baseTree, path, options, payload, MAX_BYTES);
    await appendCoverage(root, gitExecutable, headTree, coverage, payload, path, 'changed head blob', true, options);
  }
  const fixed = [['AGENTS.md', 'project guidance'], ['CLAUDE.md', 'project guidance'], ['package.json', 'package manifest'], ['detent.json', 'project config'], ['constitution/constitution.md', 'constitution'], ['.detent/prompts/review-diff.md', 'review guidance']] as const;
  for (const [p, role] of fixed) await appendCoverage(root, gitExecutable, headTree, coverage, payload, p, role, false, options);
  for (const p of request.contextPaths ?? []) await appendCoverage(root, gitExecutable, headTree, coverage, payload, p, 'explicit context', true, options);
  if (config.reviewContext !== undefined) payload.add(`\n===== project reviewContext (untrusted config data) =====\n${config.reviewContext}`);
  return prepared('diff', request.author, { head, base, mergeBase }, coverage, payload.finish(coverage));
}
function prepared(mode: PreparedReview['mode'], author: ReviewerId, commits: PreparedReview['commits'], coverage: ReviewCoverage[], text: string): PreparedReview {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) throw new Error('empty review payload');
  if (bytes.length > MAX_BYTES) throw new Error('review payload exceeds 1 MiB');
  return { mode, author, commits, coverage, text, inputSha256: sha256(bytes) };
}
