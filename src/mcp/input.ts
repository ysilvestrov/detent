import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { parseConfig } from '../config.js';
import { isReviewerId, type ReviewerId } from '../review/adapters.js';
import { normalizeSpecPath, specPathError } from '../review/preflight.js';
import { sha256 } from '../runtime/contract.js';

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
function git(root: string, executable: string, args: string[], input?: Buffer): Buffer {
  if (!isAbsolute(executable)) throw new Error('git executable must be absolute');
  const cwd = resolve(root);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', ...args];
  try {
    return execFileSync(executable, gitArgs, {
      cwd, env, input, encoding: 'buffer', maxBuffer: MAX_BYTES * 8,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: Buffer };
    const detail = error.stderr?.toString('utf8').trim() || error.message;
    throw new Error(`git ${args[0] ?? 'command'} failed: ${detail}`);
  }
}

function gitText(root: string, exe: string, args: string[]): string {
  return git(root, exe, args).toString('utf8').trim();
}
function resolveCommit(root: string, exe: string, ref: string): string {
  if (!ref || ref.startsWith('-') || ref.includes('\0')) {
    throw new Error('unsafe Git revision');
  }
  const oid = gitText(root, exe, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
    throw new Error('Git did not resolve revision to a commit');
  }
  return oid.toLowerCase();
}
function tree(root: string, exe: string, commit: string): Map<string, TreeEntry> {
  const output = git(root, exe, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const result = new Map<string, TreeEntry>();
  const rows = output.toString('utf8').split('\0').filter(Boolean);
  for (const row of rows) {
    const tab = row.indexOf('\t');
    const header = row.slice(0, tab);
    const [mode = '', type = '', oid = ''] = header.split(' ');
    const path = row.slice(tab + 1);
    result.set(path, { mode, type, oid, path });
  }
  return result;
}
function blob(root: string, exe: string, entry: TreeEntry): string {
  if (entry.mode === '120000' || entry.type !== 'blob') {
    throw new Error(`unsupported symlink or submodule: ${entry.path}`);
  }
  const bytes = git(root, exe, ['cat-file', 'blob', entry.oid]);
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
function configAt(root: string, exe: string, entries: Map<string, TreeEntry>) {
  const config = entries.get('detent.json');
  const parsed = parseConfig(config ? blob(root, exe, config) : null);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.config;
}
function safeText(root: string, exe: string, entries: Map<string, TreeEntry>, path: string): string | undefined {
  safeCommitPath(path);
  const entry = entries.get(path);
  if (!entry) return undefined;
  return blob(root, exe, entry);
}
function appendCoverage(
  root: string,
  exe: string,
  entries: Map<string, TreeEntry>,
  coverage: ReviewCoverage[],
  sections: string[],
  path: string,
  role: string,
  explicit = false,
): void {
  const text = safeText(root, exe, entries, path);
  if (text === undefined) {
    coverage.push({ path, status: 'missing', role });
    if (explicit) {
      throw new Error(`explicit context path is missing at commit: ${path}`);
    }
    return;
  }
  coverage.push({ path, status: 'included', role });
  sections.push(`\n===== ${role}: ${path} (untrusted committed data) =====\n${text}`);
}

export function prepareReview(root: string, gitExecutable: string, request: ReviewRequest): PreparedReview {
  if (!isAbsolute(root)) throw new Error('repository root must be absolute');
  const sections: string[] = []; const coverage: ReviewCoverage[] = [];
  if (request.kind === 'spec') {
    const path = request.path ?? ''; const revision = request.revision ?? '';
    if (!validPath(path)) throw new Error('unsafe spec path');
    const head = resolveCommit(root, gitExecutable, revision);
    const entries = tree(root, gitExecutable, head);
    const config = configAt(root, gitExecutable, entries);
    const pathError = specPathError(path, config.specsDir);
    if (pathError) throw new Error(pathError);
    if (!entries.has(path)) throw new Error(`spec does not exist at requested commit: ${path}`);
    appendCoverage(root, gitExecutable, entries, coverage, sections, path, 'reviewed spec', true);
    const fixed = [
      ['AGENTS.md', 'project guidance'], ['CLAUDE.md', 'project guidance'], ['package.json', 'package manifest'], ['detent.json', 'project config'],
      [config.specFile, 'root spec'], ['constitution/constitution.md', 'constitution'],
      ['.agents/skills/detent-design-spec/spec-format.md', 'spec format'], ['.claude/skills/detent-design-spec/spec-format.md', 'spec format'],
      ['.detent/prompts/review-spec.md', 'review guidance'], ['.detent/prompts/review-diff.md', 'review guidance'],
    ] as const;
    for (const [p, role] of fixed) appendCoverage(root, gitExecutable, entries, coverage, sections, p, role);
    for (const p of request.contextPaths ?? []) appendCoverage(root, gitExecutable, entries, coverage, sections, p, 'explicit context', true);
    if (config.reviewContext !== undefined) sections.push(`\n===== project reviewContext (untrusted config data) =====\n${config.reviewContext}`);
    return prepared('spec', request.author, { head }, coverage, sections.join(''));
  }
  const base = resolveCommit(root, gitExecutable, request.base ?? '');
  const head = resolveCommit(root, gitExecutable, request.head ?? '');
  const mergeBases = gitText(root, gitExecutable, ['merge-base', '--all', base, head]).split(/\r?\n/).filter(Boolean);
  if (mergeBases.length !== 1) throw new Error(mergeBases.length === 0 ? 'base and head have no merge base' : 'ambiguous merge base');
  const mergeBase = mergeBases[0] as string;
  const headTree = tree(root, gitExecutable, head);
  const baseTree = tree(root, gitExecutable, mergeBase);
  const changes = git(root, gitExecutable, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', mergeBase, head]).toString('utf8').split('\0').filter(Boolean);
  if (changes.length === 0) throw new Error('empty diff against merge base');
  const changed: { status: string; paths: string[] }[] = [];
  for (let i = 0; i < changes.length;) {
    const status = changes[i++] as string; const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const paths = changes.slice(i, i + count); i += count;
    if (paths.length !== count) throw new Error('malformed Git diff name status');
    paths.forEach(safeCommitPath);
    changed.push({ status, paths });
  }
  const config = configAt(root, gitExecutable, headTree);
  const diff = git(root, gitExecutable, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', '--no-prefix', '--binary', mergeBase, head]).toString('utf8');
  sections.push(`===== committed diff ${mergeBase}..${head} =====\n${diff}`);
  for (const change of changed) {
    if (change.status.startsWith('D')) {
      const path = change.paths[0] as string;
      const oldText = safeText(root, gitExecutable, baseTree, path);
      if (oldText === undefined) throw new Error(`deleted path missing from merge base: ${path}`);
      coverage.push({ path, status: 'included', role: 'deleted path' });
      sections.push(`\n===== deleted committed content: ${path} (untrusted Git data) =====\n${oldText}`);
      continue;
    }
    if (change.status.startsWith('R') || change.status.startsWith('C')) {
      const [oldPath, newPath] = change.paths;
      const oldText = safeText(root, gitExecutable, baseTree, oldPath as string);
      if (oldText === undefined) throw new Error(`rename source missing from merge base: ${oldPath}`);
      coverage.push({ path: oldPath as string, status: 'included', role: 'rename source' });
      sections.push(`\n===== renamed source content: ${oldPath} (untrusted Git data) =====\n${oldText}`);
      appendCoverage(root, gitExecutable, headTree, coverage, sections, newPath as string, 'renamed head blob', true);
      continue;
    }
    const path = change.paths[0] as string;
    safeText(root, gitExecutable, baseTree, path);
    appendCoverage(root, gitExecutable, headTree, coverage, sections, path, 'changed head blob', true);
  }
  const fixed = [['AGENTS.md', 'project guidance'], ['CLAUDE.md', 'project guidance'], ['package.json', 'package manifest'], ['detent.json', 'project config'], ['constitution/constitution.md', 'constitution'], ['.detent/prompts/review-diff.md', 'review guidance']] as const;
  for (const [p, role] of fixed) appendCoverage(root, gitExecutable, headTree, coverage, sections, p, role);
  for (const p of request.contextPaths ?? []) appendCoverage(root, gitExecutable, headTree, coverage, sections, p, 'explicit context', true);
  if (config.reviewContext !== undefined) sections.push(`\n===== project reviewContext (untrusted config data) =====\n${config.reviewContext}`);
  return prepared('diff', request.author, { head, base, mergeBase }, coverage, sections.join(''));
}
function prepared(mode: PreparedReview['mode'], author: ReviewerId, commits: PreparedReview['commits'], coverage: ReviewCoverage[], text: string): PreparedReview {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) throw new Error('empty review payload');
  if (bytes.length > MAX_BYTES) throw new Error('review payload exceeds 1 MiB');
  return { mode, author, commits, coverage, text, inputSha256: sha256(bytes) };
}
