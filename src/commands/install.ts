// `detent install` (spec, «Установка»). Reads the package's skills and constitution, the
// project and `home`, plans everything first (src/install/plan.ts), and writes only when the
// plan has no conflict: exit 4 means nothing at all was written. Nothing is ever deleted.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, parseInstallArgs, type Target } from '../install/args.js';
import { MANIFEST_PATH } from '../install/manifest.js';
import { DETENT_JSON_PATH, GITIGNORE_PATH, planInstall, plannedPaths, type Action } from '../install/plan.js';
import { detectSuperpowers, detentPluginEnabled, type SuperpowersFinding } from '../install/superpowers.js';

export const EXIT = { ok: 0, usage: 2, conflict: 4 } as const;

export const USAGE = 'Usage: npx -y @ysilvestrov/detent install [--claude] [--agents] [--dry-run] [--superpowers yes|no]';

type Env = Readonly<Record<string, string | undefined>>;

export interface InstallIo {
  cwd: string;
  env: Env;
  home: string; // the user's home: `~/.claude/settings.json`, `~/.codex/plugins/cache/`
  out: (line: string) => void; // the plan and the findings
  err: (line: string) => void; // conflicts, warnings and errors
}

const BLOCK_FILE: Readonly<Record<Target, string>> = { claude: 'CLAUDE.md', agents: 'AGENTS.md' };

// The package root: `src/commands/` in tests, `dist/commands/` when installed.
const packagePath = (...parts: string[]) => join(fileURLToPath(new URL('../../', import.meta.url)), ...parts);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitToplevel(cwd: string, env: Env): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: { ...env }, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git rev-parse --show-toplevel failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`not inside a git repository (git rev-parse --show-toplevel: ${(r.stderr ?? '').trim()})`);
  return r.stdout.trim();
}

// Every file under `dir`, as `/`-separated paths relative to it, sorted.
function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

// Names of the directories directly under `dir`; none when it does not exist. A link to a
// directory counts: a skill or a plugin is often linked in rather than copied.
function dirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const isDir = (name: string) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false; // a dangling link
    }
  };
  return readdirSync(dir).filter(isDir).sort();
}

// Two target paths that are one file or directory on disk (a symlink, a junction, a hard link)
// would get two different texts written through each other, and the manifest would record a
// state that is not on disk. A dangling link would be written through too.
function aliasError(root: string, a: string, b: string): string | null {
  const id = (path: string): string | null => {
    const file = onDisk(root, path);
    let link: boolean;
    try {
      link = lstatSync(file).isSymbolicLink();
    } catch {
      return null; // absent
    }
    try {
      const s = statSync(file, { bigint: true });
      return `${s.dev}:${s.ino}`;
    } catch {
      if (link) throw new Error(`${path} is a link to a missing file or directory; remove the link or create its target`);
      return null;
    }
  };
  const ia = id(a);
  return ia !== null && ia === id(b)
    ? `${a} and ${b} are the same on disk (a link); install one target: --claude or --agents`
    : null;
}

const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

// A project path (`/`-separated) on disk.
const onDisk = (root: string, path: string) => join(root, ...path.split('/'));

function describeFinding(finding: SuperpowersFinding): string {
  const where = finding.where.length > 0 ? ` (${finding.where.join('; ')})` : '';
  return `Superpowers ${finding.found ? 'found' : 'not found'}${where}`;
}

export function install(argv: readonly string[], io: InstallIo): number {
  const fail = (code: number, message: string): number => {
    io.err(`install: ${message}`);
    return code;
  };

  const parsed = parseInstallArgs(argv);
  if (!parsed.ok) return fail(EXIT.usage, `${parsed.error}\n${USAGE}`);
  const opts = parsed.opts;

  let root: string;
  try {
    root = gitToplevel(io.cwd, io.env);
  } catch (error) {
    return fail(EXIT.usage, messageOf(error));
  }

  if (opts.targets.length === TARGETS.length) {
    try {
      const alias = aliasError(root, 'CLAUDE.md', 'AGENTS.md') ?? aliasError(root, '.claude/skills', '.agents/skills');
      if (alias !== null) return fail(EXIT.usage, alias);
    } catch (error) {
      return fail(EXIT.usage, messageOf(error));
    }
  }

  // Everything is read before anything is planned, let alone written.
  let input: Parameters<typeof planInstall>[0];
  let pluginEnabled: boolean;
  try {
    const version = (JSON.parse(readFileSync(packagePath('package.json'), 'utf8')) as { version: string }).version;
    const skillsDir = packagePath('skills');
    const skills: Record<string, string> = {};
    for (const key of filesUnder(skillsDir)) skills[key] = readFileSync(join(skillsDir, ...key.split('/')), 'utf8');
    const constitution = readFileSync(packagePath('constitution', 'constitution.md'), 'utf8');

    const existing: Record<string, string> = {};
    for (const path of plannedPaths({ targets: opts.targets, skillKeys: Object.keys(skills) })) {
      const text = readOrNull(onDisk(root, path));
      if (text !== null) existing[path] = text;
    }

    const projectClaudeSettings = readOrNull(onDisk(root, '.claude/settings.json'));
    const codexCache = join(io.home, '.codex', 'plugins', 'cache');
    const superpowers = detectSuperpowers({
      projectClaudeSettings,
      userClaudeSettings: readOrNull(join(io.home, '.claude', 'settings.json')),
      codexCacheDirs: dirNames(codexCache).flatMap((m) => dirNames(join(codexCache, m)).map((p) => `${m}/${p}`)),
      agentsSkillNames: dirNames(onDisk(root, '.agents/skills')),
    });
    pluginEnabled = detentPluginEnabled(projectClaudeSettings);

    input = {
      targets: opts.targets,
      sources: { skills, constitution },
      existing,
      manifest: readOrNull(onDisk(root, MANIFEST_PATH)),
      superpowers,
      gitignore: readOrNull(onDisk(root, GITIGNORE_PATH)),
      detentJson: readOrNull(onDisk(root, DETENT_JSON_PATH)),
      version,
    };
    if (opts.superpowers !== undefined) input.superpowersFlag = opts.superpowers;
  } catch (error) {
    return fail(EXIT.usage, messageOf(error));
  }

  // Copying the skills next to an enabled plugin gives each skill twice.
  if (pluginEnabled && opts.targets.includes('claude')) {
    io.err('install: warning: the detent plugin is enabled in .claude/settings.json; with the skills copied into .claude/skills/ as well, Claude sees each skill twice (detent:design-spec and detent-design-spec)');
  }

  const plan = planInstall(input);
  if (!plan.ok && 'error' in plan) return fail(EXIT.usage, plan.error);
  if (!plan.ok) {
    for (const c of plan.conflicts) io.err(`install: conflict: ${c.path}: ${c.reason}`);
    return fail(EXIT.conflict, `nothing written; restore ${plan.conflicts.length === 1 ? 'this file' : 'these files'} by hand or move the change outside the markers, then run install again`);
  }

  const prefix = opts.dryRun ? 'dry-run: ' : '';
  const print = (line: string) => io.out(`${prefix}${line}`);
  for (const a of plan.actions) print(`${a.kind.padEnd(9)} ${a.path}`);
  for (const target of TARGETS.filter((t) => opts.targets.includes(t))) {
    const override = opts.superpowers === undefined ? '' : `, overridden by --superpowers ${opts.superpowers}`;
    const line = plan.devCycleLine[target] === true ? 'yes' : 'no';
    print(`${target}: ${describeFinding(input.superpowers[target])}${override}; detent-dev-cycle line in ${BLOCK_FILE[target]}: ${line}`);
  }
  for (const note of plan.notes) print(`note: ${note}`);
  if (opts.dryRun) {
    print('nothing written');
    return EXIT.ok;
  }

  // In plan order, so the manifest goes last.
  const writes = plan.actions.filter((a): a is Extract<Action, { content: string }> => a.kind === 'create' || a.kind === 'update');
  for (const a of writes) {
    const file = onDisk(root, a.path);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, a.content, 'utf8');
    } catch (error) {
      return fail(EXIT.usage, `writing ${a.path} failed: ${messageOf(error)}`);
    }
  }
  return EXIT.ok;
}
