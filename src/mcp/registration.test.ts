import { describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync, writeSync, closeSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitEnvironment, parseRegistration, readAdmission, type ProjectRegistration } from './registration.js';

const DIGEST = 'a'.repeat(64);
const identity = { version: '1.2.3', digest: DIGEST };
const gitExecutable = resolve(join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), process.platform === 'win32' ? 'git.exe' : 'git'));
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExecutable, args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true }).trim();
}
const pathKey = (path: string): string => path.replaceAll('/', '\\').toLowerCase();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'detent-mcp-registration-'));
  const main = join(base, 'main');
  const linked = join(base, 'linked');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'file.txt'), 'fixture\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'fixture');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
  const common = resolve(main, git(main, 'rev-parse', '--git-common-dir'));
  const registrationPath = join(base, 'registration.json');
  const fixtureGit = gitExecutable;
  const reviewerExecutable = join(base, 'claude.exe');
  writeFileSync(reviewerExecutable, 'fixture executable path');
  const registration: ProjectRegistration = {
    schemaVersion: 1,
    projectId: 'fixture',
    revision: 1,
    enabled: true,
    mainRoot: resolve(main),
    gitCommonDir: common,
    gitExecutable: fixtureGit,
    capabilities: [{ version: identity.version, digest: identity.digest, reviewers: [{ id: 'claude', executable: reviewerExecutable, model: 'claude-haiku' }] }],
    worktrees: [main, linked].map((root) => ({ root: resolve(root), configPath: join(resolve(root), '.codex', 'config.toml'), version: identity.version, digest: identity.digest, state: 'active' })),
  };
  writeFileSync(registrationPath, JSON.stringify(registration));
  return { base, main, linked, registrationPath, registration };
}

describe('registration admission', () => {
  test('allows two digests of one version and admits only the selected executable', async () => {
    const f = fixture();
    const unavailable = join(f.base, 'removed-claude.exe');
    const otherDigest = 'b'.repeat(64);
    const registration = { ...f.registration,
      capabilities: [...f.registration.capabilities, { version: identity.version, digest: otherDigest, reviewers: [{ id: 'claude' as const, executable: unavailable }] }],
    };
    writeFileSync(f.registrationPath, JSON.stringify(registration));
    expect((await readAdmission(f.registrationPath, f.main, identity)).capability.digest).toBe(identity.digest);
  });

  test('admits a main checkout with an offline Git-listed linked sibling', async () => {
    const f = fixture();
    const offline = join(f.base, 'offline');
    git(f.main, 'worktree', 'add', '-q', '-b', 'offline', offline);
    const registration = { ...f.registration, worktrees: [...f.registration.worktrees,
      { root: resolve(offline), configPath: join(resolve(offline), '.codex', 'config.toml'), version: identity.version, digest: identity.digest, state: 'active' as const }] };
    writeFileSync(f.registrationPath, JSON.stringify(registration));
    const moved = join(f.base, 'moved-offline');
    renameSync(offline, moved);
    expect((await readAdmission(f.registrationPath, f.main, identity)).root).toBe(resolve(f.main));
  });
  test('parses the exact schema and rejects unknown fields', () => {
    const f = fixture();
    expect(parseRegistration(f.registration)).toEqual(f.registration);
    expect(() => parseRegistration({ ...f.registration, approval: true })).toThrow(/registration/);
    expect(() => parseRegistration({ ...f.registration, worktrees: [...f.registration.worktrees, f.registration.worktrees[0]] })).toThrow(/duplicate|conflict/i);
  });

  test('admits only the exact active main or linked worktree root', async () => {
    const f = fixture();
    const mainEntries = git(f.main, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree '));
    expect(pathKey(mainEntries[0] as string)).toBe(pathKey(`worktree ${resolve(f.main)}`));
    expect((await readAdmission(f.registrationPath, f.main, identity)).root).toBe(resolve(f.main));
    expect((await readAdmission(f.registrationPath, f.linked, identity)).root).toBe(resolve(f.linked));
    mkdirSync(join(f.linked, 'child'));
    await expect(readAdmission(f.registrationPath, join(f.linked, 'child'), identity)).rejects.toThrow('cwd is not an active registered worktree');
    const other = join(f.base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(f.registrationPath, JSON.stringify({ ...f.registration, gitExecutable: join(f.base, 'missing-git.exe') }));
    await expect(readAdmission(f.registrationPath, other, identity)).rejects.toThrow(/active registered/i);
  });

  test('rejects disabled, pending, stale and malformed registration records', async () => {
    const f = fixture();
    const write = (registration: ProjectRegistration) => writeFileSync(f.registrationPath, JSON.stringify(registration));
    write({ ...f.registration, enabled: false });
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/disabled|enabled/i);
    write({ ...f.registration, worktrees: f.registration.worktrees.map((w) => ({ ...w, state: 'pending' as const })) });
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/active|pending/i);
    write(f.registration);
    await expect(readAdmission(f.registrationPath, f.main, { ...identity, digest: 'b'.repeat(64) })).rejects.toThrow(/capability|version|digest/i);
    expect(() => parseRegistration({ ...f.registration, gitExecutable: 'git' })).toThrow(/absolute|executable/i);
    expect(() => parseRegistration({ ...f.registration, worktrees: [{ ...f.registration.worktrees[0], digest: 'nope' }] })).toThrow(/digest|registration/i);
  });

  test('rejects changed Git identity and registration files inside worktrees', async () => {
    const f = fixture();
    const changed = { ...f.registration, gitCommonDir: join(f.base, 'other.git') };
    writeFileSync(f.registrationPath, JSON.stringify(changed));
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/identity|common/i);
    const inside = join(f.main, 'registration.json');
    writeFileSync(inside, JSON.stringify(f.registration));
    await expect(readAdmission(inside, f.main, identity)).rejects.toThrow(/inside|worktree|registration/i);
  });

  test('rejects a registration that names the linked checkout as main', async () => {
    const f = fixture();
    writeFileSync(f.registrationPath, JSON.stringify({ ...f.registration, mainRoot: resolve(f.linked) }));
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/main|identity|registration/i);
  });

  test('supports a main checkout with a separate Git directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'detent-mcp-separate-git-'));
    const main = join(base, 'main');
    const commonDir = join(base, 'metadata');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main', `--separate-git-dir=${commonDir}`, main);
    writeFileSync(join(main, 'file.txt'), 'fixture\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'fixture');
    const actualCommon = resolve(main, git(main, 'rev-parse', '--git-common-dir'));
    const separateEntries = git(main, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree '));
    expect(pathKey(separateEntries[0] as string)).toBe(pathKey(`worktree ${actualCommon}`));
    const reviewer = join(base, 'claude.exe');
    writeFileSync(reviewer, 'fixture executable path');
    const registration: ProjectRegistration = {
      schemaVersion: 1,
      projectId: 'separate',
      revision: 1,
      enabled: true,
      mainRoot: resolve(main),
      gitCommonDir: actualCommon,
      gitExecutable,
      capabilities: [{ version: identity.version, digest: identity.digest, reviewers: [{ id: 'claude', executable: reviewer }] }],
      worktrees: [{ root: resolve(main), configPath: join(resolve(main), '.codex', 'config.toml'), version: identity.version, digest: identity.digest, state: 'active' }],
    };
    const registrationPath = join(base, 'registration.json');
    writeFileSync(registrationPath, JSON.stringify(registration));
    expect((await readAdmission(registrationPath, main, identity)).root).toBe(resolve(main));
    const gitFile = join(main, '.git');
    chmodSync(gitFile, 0o666);
    const fd = openSync(gitFile, 'r+');
    ftruncateSync(fd, 0);
    writeSync(fd, `gitdir: ${join(base, 'tampered-metadata')}\n`);
    closeSync(fd);
    await expect(readAdmission(registrationPath, main, identity)).rejects.toThrow(/main|Git|identity|metadata/i);
  });

  test('rejects a reviewer executable hard-linked into a registered worktree', async () => {
    const f = fixture();
    linkSync(f.registration.capabilities[0]!.reviewers[0]!.executable, join(f.main, 'reviewer-hardlink.exe'));
    writeFileSync(f.registrationPath, JSON.stringify(f.registration));
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/link/i);
  });

  test('rejects a Git executable hard-linked into a registered worktree', async () => {
    const f = fixture();
    const linkedGit = join(f.base, 'git-hardlink.exe');
    copyFileSync(f.registration.gitExecutable, linkedGit);
    linkSync(linkedGit, join(f.main, 'git-hardlink.exe'));
    const registration = { ...f.registration, gitExecutable: linkedGit };
    writeFileSync(f.registrationPath, JSON.stringify(registration));
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/link/i);
  });

  test('refuses a hard-link registration source', async () => {
    const f = fixture();
    const hardlink = join(f.base, 'registration-hardlink.json');
    linkSync(f.registrationPath, hardlink);
    await expect(readAdmission(hardlink, f.main, identity)).rejects.toThrow(/hard.?link/i);
  });

  test.skipIf(process.platform === 'win32')('refuses a symlink registration source', async () => {
    const f = fixture();
    const symlink = join(f.base, 'registration-link.json');
    symlinkSync(f.registrationPath, symlink, 'file');
    await expect(readAdmission(symlink, f.main, identity)).rejects.toThrow(/symbolic|link/i);
  });

  test.skipIf(process.platform === 'win32')('refuses a registration path reached through an ancestor symlink', async () => {
    const f = fixture();
    const alias = join(f.base, 'main-alias');
    symlinkSync(f.main, alias, 'dir');
    const aliasedPath = join(alias, '.codex', 'registration.json');
    mkdirSync(join(f.main, '.codex'));
    writeFileSync(join(f.main, '.codex', 'registration.json'), JSON.stringify(f.registration));
    await expect(readAdmission(aliasedPath, f.main, identity)).rejects.toThrow(/canonical|link|registration/i);
  });

  test.skipIf(process.platform !== 'win32')('refuses a registration path reached through an ancestor directory junction', async () => {
    const f = fixture();
    const stateDir = join(f.base, 'external-state');
    const stateAlias = join(f.base, 'state-alias');
    mkdirSync(stateDir);
    const registrationPath = join(stateDir, 'registration.json');
    writeFileSync(registrationPath, JSON.stringify(f.registration));
    symlinkSync(stateDir, stateAlias, 'junction');
    await expect(readAdmission(join(stateAlias, 'registration.json'), f.main, identity)).rejects.toThrow(/canonical|link|registration/i);
  });

  test.skipIf(process.platform === 'win32')('treats case-distinct POSIX worktree roots as distinct', () => {
    const f = fixture();
    const cap = f.registration.capabilities[0]!;
    const upper = resolve(f.base, 'CaseRoot');
    const lower = resolve(f.base, 'caseroot');
    const worktrees = [upper, lower].map((root) => ({ root, configPath: join(root, '.codex', 'config.toml'), version: cap.version, digest: cap.digest, state: 'active' as const }));
    expect(parseRegistration({ ...f.registration, mainRoot: upper, worktrees })).toMatchObject({ mainRoot: upper });
  });

  test.skipIf(process.platform !== 'win32')('treats case-only worktree roots as duplicates on Windows', () => {
    const f = fixture();
    const upper = resolve(f.base, 'CaseRoot');
    const lower = resolve(f.base, 'caseroot');
    const cap = f.registration.capabilities[0]!;
    const worktrees = [upper, lower].map((root) => ({ root, configPath: join(root, '.codex', 'config.toml'), version: cap.version, digest: cap.digest, state: 'active' as const }));
    expect(() => parseRegistration({ ...f.registration, mainRoot: upper, worktrees })).toThrow(/duplicate/i);
  });

  test('re-reads revocation state on every admission', async () => {
    const f = fixture();
    expect((await readAdmission(f.registrationPath, f.main, identity)).registration.enabled).toBe(true);
    writeFileSync(f.registrationPath, JSON.stringify({ ...f.registration, enabled: false }));
    await expect(readAdmission(f.registrationPath, f.main, identity)).rejects.toThrow(/disabled|enabled/i);
  });

  test.skipIf(process.platform === 'win32')('builds the Git environment from the POSIX OS and Git allowlist', () => {
    vi.stubEnv('PATH', 'test-path');
    vi.stubEnv('TEMP', 'test-temp');
    vi.stubEnv('TMP', 'test-tmp');
    vi.stubEnv('BASH_ENV', 'inject.sh');
    vi.stubEnv('LD_PRELOAD', 'inject.so');
    vi.stubEnv('DYLD_INSERT_LIBRARIES', 'inject.dylib');
    vi.stubEnv('NODE_OPTIONS', '--require inject.js');
    const env = gitEnvironment();
    vi.unstubAllEnvs();
    expect(Object.keys(env).sort()).toEqual(['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'PATH', 'TEMP', 'TMP']);
  });

  test.skipIf(process.platform !== 'win32')('builds the Git environment from the Windows OS and Git allowlist', () => {
    vi.stubEnv('PATH', 'test-path');
    vi.stubEnv('TEMP', 'test-temp');
    vi.stubEnv('TMP', 'test-tmp');
    vi.stubEnv('SystemRoot', 'test-system-root');
    vi.stubEnv('WINDIR', 'test-windir');
    vi.stubEnv('BASH_ENV', 'inject.sh');
    vi.stubEnv('LD_PRELOAD', 'inject.so');
    vi.stubEnv('DYLD_INSERT_LIBRARIES', 'inject.dylib');
    vi.stubEnv('NODE_OPTIONS', '--require inject.js');
    const env = gitEnvironment();
    vi.unstubAllEnvs();
    expect(Object.keys(env).sort()).toEqual(['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
  });
});
