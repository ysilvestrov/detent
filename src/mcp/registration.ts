import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { safeComponent } from '../runtime/contract.js';

export type ReviewerId = 'claude';
export interface Reviewer { id: ReviewerId; executable: string; model?: string }
export interface Capability { version: string; digest: string; reviewers: Reviewer[] }
export interface RegisteredWorktree { root: string; configPath: string; version: string; digest: string; state: 'pending' | 'active' }
export interface ProjectRegistration {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  enabled: boolean;
  mainRoot: string;
  gitCommonDir: string;
  gitExecutable: string;
  capabilities: Capability[];
  worktrees: RegisteredWorktree[];
}
export interface RuntimeIdentity { version: string; digest: string }
export interface Admission { registration: ProjectRegistration; capability: Capability; root: string; gitExecutable: string }

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`invalid registration ${label}: unknown field`);
  if (keys.some((key) => !(key in value))) throw new Error(`invalid registration ${label}: missing field`);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value) throw new Error(`invalid registration ${label}: expected canonical absolute path`);
  return value;
}

function identityFields(value: Record<string, unknown>, label: string): void {
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) throw new Error(`invalid registration ${label} version`);
  if (typeof value.digest !== 'string' || !HASH.test(value.digest)) throw new Error(`invalid registration ${label} digest`);
}

export function parseRegistration(value: unknown): ProjectRegistration {
  if (!object(value)) throw new Error('invalid registration object');
  exactKeys(value, ['schemaVersion', 'projectId', 'revision', 'enabled', 'mainRoot', 'gitCommonDir', 'gitExecutable', 'capabilities', 'worktrees'], 'record');
  if (value.schemaVersion !== 1 || typeof value.projectId !== 'string' || !safeComponent(value.projectId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.enabled !== 'boolean') throw new Error('invalid registration identity');
  const mainRoot = absolutePath(value.mainRoot, 'mainRoot');
  const gitCommonDir = absolutePath(value.gitCommonDir, 'gitCommonDir');
  const gitExecutable = absolutePath(value.gitExecutable, 'gitExecutable');
  if (!Array.isArray(value.capabilities) || !Array.isArray(value.worktrees)) throw new Error('invalid registration entries');

  const capabilities = value.capabilities.map((entry): Capability => {
    if (!object(entry)) throw new Error('invalid registration capability');
    exactKeys(entry, ['version', 'digest', 'reviewers'], 'capability');
    identityFields(entry, 'capability');
    if (!Array.isArray(entry.reviewers) || entry.reviewers.length === 0) throw new Error('invalid registration reviewers');
    const reviewers = entry.reviewers.map((reviewer): Reviewer => {
      if (!object(reviewer)) throw new Error('invalid registration reviewer');
      if (reviewer.model === undefined) exactKeys(reviewer, ['id', 'executable'], 'reviewer');
      else exactKeys(reviewer, ['id', 'executable', 'model'], 'reviewer');
      if (reviewer.id !== 'claude' || (reviewer.model !== undefined && (typeof reviewer.model !== 'string' || reviewer.model.length === 0))) throw new Error('invalid registration reviewer');
      return { id: 'claude', executable: absolutePath(reviewer.executable, 'reviewer executable'), ...(reviewer.model === undefined ? {} : { model: reviewer.model as string }) };
    });
    if (new Set(reviewers.map((reviewer) => reviewer.id)).size !== reviewers.length) throw new Error('duplicate registration reviewer');
    return { version: entry.version as string, digest: entry.digest as string, reviewers };
  });
  const capabilityKeys = capabilities.map(({ version, digest }) => `${version}/${digest}`);
  if (new Set(capabilityKeys).size !== capabilityKeys.length || new Set(capabilities.map(({ version }) => version)).size !== capabilities.length) throw new Error('duplicate or conflicting registration capability');

  const worktrees = value.worktrees.map((entry): RegisteredWorktree => {
    if (!object(entry)) throw new Error('invalid registration worktree');
    exactKeys(entry, ['root', 'configPath', 'version', 'digest', 'state'], 'worktree');
    identityFields(entry, 'worktree');
    const root = absolutePath(entry.root, 'worktree root');
    const configPath = absolutePath(entry.configPath, 'worktree config');
    if (configPath !== join(root, '.codex', 'config.toml') || (entry.state !== 'pending' && entry.state !== 'active')) throw new Error('invalid registration worktree config or state');
    return { root, configPath, version: entry.version as string, digest: entry.digest as string, state: entry.state };
  });
  const roots = worktrees.map((worktree) => pathKey(worktree.root));
  if (new Set(roots).size !== roots.length || !roots.includes(pathKey(mainRoot))) throw new Error('duplicate worktree or missing main root registration');
  for (const worktree of worktrees) {
    if (!capabilities.some((capability) => capability.version === worktree.version && capability.digest === worktree.digest)) throw new Error('worktree has no matching capability');
  }
  return { schemaVersion: 1, projectId: value.projectId, revision: value.revision as number, enabled: value.enabled, mainRoot, gitCommonDir, gitExecutable, capabilities, worktrees };
}

const windows = process.platform === 'win32';
const pathKey = (path: string): string => windows ? path.toLowerCase() : path;
function contains(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function outsideWorktrees(path: string, worktrees: readonly RegisteredWorktree[], label: string): void {
  if (worktrees.some(({ root }) => contains(root, path))) throw new Error(`${label} is inside a registered worktree`);
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
    ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
    ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd: string, executable: string, args: string[]): string {
  const env = gitEnvironment();
  return execFileSync(executable, args, { cwd, env, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkedExecutable(path: string, label: string): string {
  const stat = lstatSync(path);
  const canonical = realpathSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || canonical !== path) throw new Error(`${label} must be a canonical regular file without links`);
  return canonical;
}

function gitPath(cwd: string, executable: string, arg: string): string {
  const raw = git(cwd, executable, ['rev-parse', arg]);
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

export function readAdmission(registrationPath: string, cwd: string, identity: RuntimeIdentity): Admission {
  const sourcePath = resolve(registrationPath);
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1 || realpathSync(sourcePath) !== sourcePath) throw new Error('registration source must be a canonical regular file without symlink or hard-link aliases');
  const registration = parseRegistration(JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown);
  if (!registration.enabled) throw new Error('registration is disabled');
  if (!VERSION.test(identity.version) || !HASH.test(identity.digest)) throw new Error('invalid runtime identity');
  const capability = registration.capabilities.find((item) => item.version === identity.version && item.digest === identity.digest);
  if (!capability) throw new Error('runtime identity has no matching capability');
  let root: string;
  try { root = realpathSync(resolve(cwd)); } catch { throw new Error('cwd must be an existing canonical worktree root'); }
  if (root !== resolve(cwd)) throw new Error('cwd must be a canonical worktree root');
  const worktree = registration.worktrees.find((item) => pathKey(item.root) === pathKey(root));
  if (!worktree || worktree.state !== 'active') throw new Error('cwd is not an active registered worktree');
  if (worktree.version !== identity.version || worktree.digest !== identity.digest) throw new Error('runtime identity is not admitted for this worktree');
  const canonicalGit = checkedExecutable(registration.gitExecutable, 'Git executable');
  for (const worktree of registration.worktrees) {
    outsideWorktrees(sourcePath, [worktree], 'registration source');
    outsideWorktrees(canonicalGit, [worktree], 'Git executable');
    for (const item of registration.capabilities) for (const reviewer of item.reviewers) {
      const canonicalReviewer = checkedExecutable(reviewer.executable, 'reviewer executable');
      outsideWorktrees(canonicalReviewer, [worktree], 'reviewer executable');
    }
  }
  const main = registration.mainRoot;
  const mainRoot = gitPath(main, canonicalGit, '--show-toplevel');
  const mainGitDir = gitPath(main, canonicalGit, '--absolute-git-dir');
  const mainCommon = gitPath(main, canonicalGit, '--git-common-dir');
  if (pathKey(mainRoot) !== pathKey(main) || pathKey(mainGitDir) !== pathKey(mainCommon) || pathKey(mainCommon) !== pathKey(registration.gitCommonDir)) throw new Error('registered main checkout identity mismatch');
  const mainDotGit = join(main, '.git');
  const mainDotGitStat = lstatSync(mainDotGit);
  let primaryWorktreeEntry: string;
  if (mainDotGitStat.isDirectory() && !mainDotGitStat.isSymbolicLink()) {
    if (pathKey(realpathSync(mainDotGit)) !== pathKey(mainCommon)) throw new Error('main .git directory differs from registered common-dir');
    primaryWorktreeEntry = main;
  } else if (mainDotGitStat.isFile() && mainDotGitStat.nlink === 1 && pathKey(realpathSync(mainDotGit)) === pathKey(mainDotGit)) {
    primaryWorktreeEntry = mainCommon;
  } else {
    throw new Error('main .git must be a canonical directory or regular separate-git-dir file');
  }
  const metadataRoot = gitPath(root, canonicalGit, '--show-toplevel');
  const gitDir = gitPath(root, canonicalGit, '--absolute-git-dir');
  const common = gitPath(root, canonicalGit, '--git-common-dir');
  if (pathKey(metadataRoot) !== pathKey(root) || pathKey(common) !== pathKey(mainCommon)
    || (pathKey(root) === pathKey(main) ? pathKey(gitDir) !== pathKey(common) : pathKey(gitDir) === pathKey(common))) throw new Error('Git identity or active worktree registration mismatch');
  const listed = git(root, canonicalGit, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => realpathSync(line.slice('worktree '.length)));
  if (pathKey(listed[0] ?? '') !== pathKey(primaryWorktreeEntry)
    || (pathKey(root) !== pathKey(main) && !listed.some((path) => pathKey(path) === pathKey(root)))) throw new Error('Git worktree membership differs from registration');
  return { registration, capability, root, gitExecutable: canonicalGit };
}
