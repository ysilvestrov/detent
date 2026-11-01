import { describe, test, expect } from 'vitest';
import { detectSuperpowers, detentPluginEnabled } from './superpowers.js';

const NOTHING = { projectClaudeSettings: null, userClaudeSettings: null, codexCacheDirs: [], agentsSkillNames: [] };
const NOT_FOUND = { found: false, where: [] };

describe('detectSuperpowers — nothing to look at', () => {
  test('no settings, no cache, no skills: not found for either target', () => {
    expect(detectSuperpowers(NOTHING)).toEqual({ claude: NOT_FOUND, agents: NOT_FOUND });
  });
});

describe('detectSuperpowers — claude', () => {
  test('enabled in the project settings', () => {
    const r = detectSuperpowers({ ...NOTHING, projectClaudeSettings: '{"enabledPlugins":{"superpowers@claude-plugins-official":true}}' });
    expect(r).toEqual({
      claude: { found: true, where: ['.claude/settings.json: enabledPlugins["superpowers@claude-plugins-official"]'] },
      agents: NOT_FOUND,
    });
  });
  test('enabled in the user settings', () => {
    const r = detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers@x":true}}' });
    expect(r.claude).toEqual({ found: true, where: ['~/.claude/settings.json: enabledPlugins["superpowers@x"]'] });
  });
  test('both places are named, project first', () => {
    const s = '{"enabledPlugins":{"superpowers@m":true}}';
    expect(detectSuperpowers({ ...NOTHING, projectClaudeSettings: s, userClaudeSettings: s }).claude).toEqual({
      found: true,
      where: ['.claude/settings.json: enabledPlugins["superpowers@m"]', '~/.claude/settings.json: enabledPlugins["superpowers@m"]'],
    });
  });
  test('false is not enabled', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers@m":false}}' }).claude).toEqual(NOT_FOUND);
  });
  test('a truthy non-boolean is not enabled', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers@m":"true"}}' }).claude).toEqual(NOT_FOUND);
  });
  test('a key without @ does not count', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers":true}}' }).claude).toEqual(NOT_FOUND);
  });
  test('another plugin whose name starts with superpowers does not count', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers-lab@m":true}}' }).claude).toEqual(NOT_FOUND);
  });
  test('superpowers outside enabledPlugins does not count', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"superpowers@m":true,"enabledPlugins":[]}' }).claude).toEqual(NOT_FOUND);
  });
  test('an empty settings object', () => {
    expect(detectSuperpowers({ ...NOTHING, projectClaudeSettings: '{}' }).claude).toEqual(NOT_FOUND);
  });
  test('a broken settings file is not found, with the reason', () => {
    expect(detectSuperpowers({ ...NOTHING, projectClaudeSettings: '{"enabledPlugins":' }).claude).toEqual({
      found: false, where: ['.claude/settings.json: not a valid JSON object, not checked'],
    });
  });
  test('a broken project file does not hide a finding in the user file', () => {
    expect(detectSuperpowers({ ...NOTHING, projectClaudeSettings: '[1]', userClaudeSettings: '﻿{"enabledPlugins":{"superpowers@m":true}}' }).claude).toEqual({
      found: true,
      where: ['.claude/settings.json: not a valid JSON object, not checked', '~/.claude/settings.json: enabledPlugins["superpowers@m"]'],
    });
  });
  test('Claude settings say nothing about the agents target', () => {
    expect(detectSuperpowers({ ...NOTHING, userClaudeSettings: '{"enabledPlugins":{"superpowers@m":true}}' }).agents).toEqual(NOT_FOUND);
  });
});

describe('detectSuperpowers — agents', () => {
  test('a superpowers dir in the Codex plugin cache', () => {
    expect(detectSuperpowers({ ...NOTHING, codexCacheDirs: ['openai-curated/other', 'openai-curated/superpowers'] })).toEqual({
      claude: NOT_FOUND,
      agents: { found: true, where: ['~/.codex/plugins/cache/openai-curated/superpowers/'] },
    });
  });
  test('a marketplace dir named superpowers is not the plugin', () => {
    expect(detectSuperpowers({ ...NOTHING, codexCacheDirs: ['superpowers/other'] }).agents).toEqual(NOT_FOUND);
  });
  test('a dir deeper than <marketplace>/<plugin> does not count', () => {
    expect(detectSuperpowers({ ...NOTHING, codexCacheDirs: ['m/x/superpowers'] }).agents).toEqual(NOT_FOUND);
  });
  test('using-superpowers in .agents/skills', () => {
    expect(detectSuperpowers({ ...NOTHING, agentsSkillNames: ['detent-dev-cycle', 'using-superpowers'] }).agents).toEqual({
      found: true, where: ['.agents/skills/using-superpowers/'],
    });
  });
  test('another skill name does not count', () => {
    expect(detectSuperpowers({ ...NOTHING, agentsSkillNames: ['superpowers'] }).agents).toEqual(NOT_FOUND);
  });
  test('both places are named, cache first', () => {
    expect(detectSuperpowers({ ...NOTHING, codexCacheDirs: ['m/superpowers'], agentsSkillNames: ['using-superpowers'] }).agents).toEqual({
      found: true, where: ['~/.codex/plugins/cache/m/superpowers/', '.agents/skills/using-superpowers/'],
    });
  });
  test('the agents sources say nothing about the claude target', () => {
    expect(detectSuperpowers({ ...NOTHING, codexCacheDirs: ['m/superpowers'] }).claude).toEqual(NOT_FOUND);
  });
});

describe('detentPluginEnabled', () => {
  test('no settings file', () => {
    expect(detentPluginEnabled(null)).toBe(false);
  });
  test('enabled', () => {
    expect(detentPluginEnabled('{"enabledPlugins":{"detent@detent":true}}')).toBe(true);
  });
  test('disabled', () => {
    expect(detentPluginEnabled('{"enabledPlugins":{"detent@detent":false}}')).toBe(false);
  });
  test('a plugin whose name only starts with detent', () => {
    expect(detentPluginEnabled('{"enabledPlugins":{"detentx@m":true}}')).toBe(false);
  });
  test('broken JSON is not an error', () => {
    expect(detentPluginEnabled('{')).toBe(false);
  });
  test('no enabledPlugins', () => {
    expect(detentPluginEnabled('{}')).toBe(false);
  });
});
