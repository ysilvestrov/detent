// Whether Superpowers is installed, seen separately for each target, because Claude Code and
// Codex install plugins each in their own place (spec, «Установка», owner's amendment of
// 2026-11-01). A settings file that cannot be read as JSON is "not found" with the reason in
// `where`, never an error: detection only decides whether one line goes into the block.

export interface SuperpowersFinding {
  found: boolean;
  // Where it was found, and why a source could not be checked; empty when there was nothing.
  where: string[];
}

export interface SuperpowersDetection {
  claude: SuperpowersFinding;
  agents: SuperpowersFinding;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Settings = { ok: true; enabledPlugins: Record<string, unknown> } | { ok: false };

function readSettings(text: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(raw)) return { ok: false };
  return { ok: true, enabledPlugins: isPlainObject(raw.enabledPlugins) ? raw.enabledPlugins : {} };
}

// Keys of `enabledPlugins` that start with `<plugin>@` and are exactly `true`.
function enabledKeys(enabledPlugins: Record<string, unknown>, plugin: string): string[] {
  return Object.keys(enabledPlugins).filter((k) => k.startsWith(`${plugin}@`) && enabledPlugins[k] === true);
}

function claudeSource(label: string, text: string | null, finding: SuperpowersFinding): void {
  if (text === null) return;
  const s = readSettings(text);
  if (!s.ok) {
    finding.where.push(`${label}: not a valid JSON object, not checked`);
    return;
  }
  for (const key of enabledKeys(s.enabledPlugins, 'superpowers')) {
    finding.found = true;
    finding.where.push(`${label}: enabledPlugins["${key}"]`);
  }
}

export function detectSuperpowers(p: {
  projectClaudeSettings: string | null; // `.claude/settings.json` of the project, null when absent
  userClaudeSettings: string | null; // `~/.claude/settings.json`, null when absent
  codexCacheDirs: readonly string[]; // `<marketplace>/<plugin>` dirs under `~/.codex/plugins/cache/`
  agentsSkillNames: readonly string[]; // dir names under the project's `.agents/skills/`
}): SuperpowersDetection {
  const claude: SuperpowersFinding = { found: false, where: [] };
  claudeSource('.claude/settings.json', p.projectClaudeSettings, claude);
  claudeSource('~/.claude/settings.json', p.userClaudeSettings, claude);

  const agents: SuperpowersFinding = { found: false, where: [] };
  for (const dir of p.codexCacheDirs) {
    const parts = dir.split('/');
    if (parts.length === 2 && parts[1] === 'superpowers') {
      agents.found = true;
      agents.where.push(`~/.codex/plugins/cache/${dir}/`);
    }
  }
  if (p.agentsSkillNames.includes('using-superpowers')) {
    agents.found = true;
    agents.where.push('.agents/skills/using-superpowers/');
  }
  return { claude, agents };
}

// The detent Claude plugin enabled in these settings: installing by copy as well gives
// duplicate skills (`detent:design-spec` and `detent-design-spec`), so the installer warns.
export function detentPluginEnabled(settings: string | null): boolean {
  if (settings === null) return false;
  const s = readSettings(settings);
  return s.ok && enabledKeys(s.enabledPlugins, 'detent').length > 0;
}
