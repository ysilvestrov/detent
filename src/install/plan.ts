// What `detent install` will do (spec, «Установка»), decided before anything is written: every
// file is checked first, and a single conflict means no action at all (exit 4). Pure: the
// caller reads the disk and passes the texts in.
import { DEFAULT_CONFIG, parseConfig } from '../config.js';
import { TARGETS, type Target } from './args.js';
import { AGENTS_AUTHOR_LINE, appendBlock, blockInner, findBlock, renderBlock, replaceAuthorLine, replaceBlock } from './blocks.js';
import { MANIFEST_PATH, hashContent, parseManifest, serializeManifest, type Manifest, type ManifestEntry } from './manifest.js';
import type { SuperpowersDetection } from './superpowers.js';

const SKILLS_DIR: Readonly<Record<Target, string>> = { claude: '.claude/skills', agents: '.agents/skills' };
const BLOCK_FILE: Readonly<Record<Target, string>> = { claude: 'CLAUDE.md', agents: 'AGENTS.md' };

export const DETENT_JSON_PATH = 'detent.json';
export const GITIGNORE_PATH = '.gitignore';

export type Subject = 'skill' | 'block' | 'detentJson' | 'gitignore' | 'manifest';

// `create`/`update` carry the full text to write (LF, except bytes outside the block in
// CLAUDE.md / AGENTS.md, which are kept as they were). `adopt`: the file already holds what
// detent would write and only goes into the manifest. `unchanged`: nothing to do.
export type Action =
  | { kind: 'create' | 'update'; subject: Subject; path: string; content: string }
  | { kind: 'adopt' | 'unchanged'; subject: Subject; path: string };

export interface Conflict { path: string; reason: string }

export interface InstallInput {
  targets: readonly Target[];
  sources: {
    // `<skill>/<path inside the skill dir>` with `/` → text, e.g. `design-spec/spec-format.md`.
    skills: Readonly<Record<string, string>>;
    constitution: string; // `constitution/constitution.md`
  };
  // Project path → current text, for each path of `plannedPaths()` that exists.
  existing: Readonly<Record<string, string>>;
  manifest: string | null; // `.detent/manifest.json`, null when absent
  superpowers: SuperpowersDetection;
  superpowersFlag?: 'yes' | 'no'; // `--superpowers`: overrides detection for both targets
  gitignore: string | null;
  detentJson: string | null;
  version: string; // detent's package version
}

export type InstallPlan =
  | {
      ok: true;
      actions: Action[]; // skills, blocks, detent.json, .gitignore, then the manifest last
      notes: string[];
      devCycleLine: Partial<Record<Target, boolean>>; // per selected target: is the line in its block
    }
  | { ok: false; conflicts: Conflict[] } // exit 4
  | { ok: false; error: string }; // exit 2: a broken detent.json or manifest

const toLF = (text: string) => text.replace(/\r\n/g, '\n');

// Selected targets in their fixed order, without repeats.
function selected(targets: readonly Target[]): Target[] {
  return TARGETS.filter((t) => targets.includes(t));
}

function skillPath(target: Target, sourceKey: string): string {
  const slash = sourceKey.indexOf('/');
  return `${SKILLS_DIR[target]}/detent-${sourceKey.slice(0, slash)}/${sourceKey.slice(slash + 1)}`;
}

// The project paths whose current text `planInstall` needs in `existing`.
export function plannedPaths(p: { targets: readonly Target[]; skillKeys: readonly string[] }): string[] {
  const out: string[] = [];
  for (const t of selected(p.targets)) {
    for (const key of [...p.skillKeys].sort()) out.push(skillPath(t, key));
    out.push(BLOCK_FILE[t]);
  }
  return out;
}

type Verdict = 'unchanged' | 'adopt' | 'update' | 'changed' | 'unrecorded';

// One installed unit (a skill file, or a block's inner text) against what detent would write.
// Equal content → unchanged or adopt; otherwise the manifest must vouch for the current text.
function judge(current: string, desired: string, recorded: ManifestEntry | undefined): Verdict {
  const hash = hashContent(current);
  if (hash === hashContent(desired)) return recorded?.sha256 === hash ? 'unchanged' : 'adopt';
  if (recorded === undefined) return 'unrecorded';
  return recorded.sha256 === hash ? 'update' : 'changed';
}

const REASON = {
  changed: 'changed since detent wrote it (sha256 differs from the manifest)',
  unrecorded: 'differs from what detent would write and has no manifest record',
} as const;

// A line naming tmpDir, with or without a leading or trailing `/`.
function gitignoreHas(text: string, tmpDir: string): boolean {
  const bare = (s: string) => s.trim().replace(/^\//, '').replace(/\/$/, '');
  return toLF(text).split('\n').some((line) => bare(line) === bare(tmpDir));
}

export function planInstall(input: InstallInput): InstallPlan {
  const parsedManifest = parseManifest(input.manifest);
  if (!parsedManifest.ok) return { ok: false, error: parsedManifest.error };
  const config = parseConfig(input.detentJson);
  if (!config.ok) return { ok: false, error: config.error };
  const old = parsedManifest.manifest;

  const targets = selected(input.targets);
  const actions: Action[] = [];
  const conflicts: Conflict[] = [];
  const notes: string[] = [];
  const devCycleLine: Partial<Record<Target, boolean>> = {};
  const next: Manifest = { detentVersion: input.version, files: { ...old.files }, blocks: { ...old.blocks } };

  // Skill files.
  const keys = Object.keys(input.sources.skills).sort();
  for (const target of targets) {
    const shipped = new Set<string>();
    for (const key of keys) {
      const path = skillPath(target, key);
      shipped.add(path);
      const source = toLF(input.sources.skills[key] as string);
      const desired = target === 'agents' ? replaceAuthorLine(source, AGENTS_AUTHOR_LINE) : source;
      next.files[path] = { sha256: hashContent(desired), version: input.version };
      const current = input.existing[path];
      if (current === undefined) {
        actions.push({ kind: 'create', subject: 'skill', path, content: desired });
        continue;
      }
      const verdict = judge(current, desired, old.files[path]);
      if (verdict === 'changed' || verdict === 'unrecorded') conflicts.push({ path, reason: REASON[verdict] });
      else if (verdict === 'update') actions.push({ kind: 'update', subject: 'skill', path, content: desired });
      else actions.push({ kind: verdict, subject: 'skill', path });
    }
    // Never deleted: a file detent once wrote and no longer ships is only named.
    for (const path of Object.keys(old.files).sort()) {
      if (path.startsWith(`${SKILLS_DIR[target]}/`) && !shipped.has(path)) notes.push(`${path}: stale, delete with a script if not needed`);
    }
  }

  // Constitution blocks.
  for (const target of targets) {
    const path = BLOCK_FILE[target];
    const present = input.superpowersFlag === undefined ? input.superpowers[target].found : input.superpowersFlag === 'yes';
    devCycleLine[target] = !present;
    const inner = blockInner(input.sources.constitution, !present);
    const block = renderBlock(inner);
    next.blocks[path] = { sha256: hashContent(inner), version: input.version };
    const current = input.existing[path];
    if (current === undefined) {
      actions.push({ kind: 'create', subject: 'block', path, content: block });
      continue;
    }
    const found = findBlock(current);
    if (found.kind === 'broken') {
      conflicts.push({ path, reason: `broken constitution markers: ${found.reason}` });
      continue;
    }
    if (found.kind === 'none') {
      actions.push({ kind: 'update', subject: 'block', path, content: appendBlock(current, block) });
      continue;
    }
    const verdict = judge(found.inner, inner, old.blocks[path]);
    if (verdict === 'changed' || verdict === 'unrecorded') conflicts.push({ path, reason: `the constitution block ${REASON[verdict]}` });
    else if (verdict === 'update') actions.push({ kind: 'update', subject: 'block', path, content: replaceBlock(current, found, block) });
    else actions.push({ kind: verdict, subject: 'block', path });
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // detent.json: created with the defaults when absent; an existing one is never touched.
  if (input.detentJson === null) {
    actions.push({ kind: 'create', subject: 'detentJson', path: DETENT_JSON_PATH, content: JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n' });
  } else {
    actions.push({ kind: 'unchanged', subject: 'detentJson', path: DETENT_JSON_PATH });
  }

  // .gitignore: tmpDir (from detent.json, else the default) appended when no line names it.
  const tmpDir = config.config.tmpDir;
  if (input.gitignore === null) {
    actions.push({ kind: 'create', subject: 'gitignore', path: GITIGNORE_PATH, content: `${tmpDir}\n` });
  } else if (gitignoreHas(input.gitignore, tmpDir)) {
    actions.push({ kind: 'unchanged', subject: 'gitignore', path: GITIGNORE_PATH });
  } else {
    const sep = input.gitignore === '' || input.gitignore.endsWith('\n') ? '' : '\n';
    actions.push({ kind: 'update', subject: 'gitignore', path: GITIGNORE_PATH, content: `${input.gitignore}${sep}${tmpDir}\n` });
  }

  // The manifest, last. It does not hash itself.
  const manifestText = serializeManifest(next);
  if (input.manifest === null) actions.push({ kind: 'create', subject: 'manifest', path: MANIFEST_PATH, content: manifestText });
  else if (toLF(input.manifest.replace(/^﻿/, '')) === manifestText) actions.push({ kind: 'unchanged', subject: 'manifest', path: MANIFEST_PATH });
  else actions.push({ kind: 'update', subject: 'manifest', path: MANIFEST_PATH, content: manifestText });

  return { ok: true, actions, notes, devCycleLine };
}
