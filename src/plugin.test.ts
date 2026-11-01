// The Claude plugin reads the same skills/ as the installer (spec, decision 1); these files only
// describe it. Format: code.claude.com/docs/en/plugins/{manifest,marketplace}-reference.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const json = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')) as Record<string, unknown>;
const plugin = json('.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const pkg = json('package.json');

describe('.claude-plugin/plugin.json', () => {
  test('is named detent, so its skills are detent:<name> and its install id is detent@detent', () => {
    expect(plugin.name).toBe('detent');
  });
  test('carries the package version: one release, one number', () => {
    expect(plugin.version).toBe(pkg.version);
  });
  test('declares no skills path: the default skills/ directory is the single source', () => {
    expect(Object.hasOwn(plugin, 'skills')).toBe(false);
  });
});

describe('.claude-plugin/marketplace.json', () => {
  test('lists exactly one plugin: this repository root, under the same name as plugin.json', () => {
    expect(marketplace.name).toBe('detent');
    expect(marketplace.owner).toEqual({ name: 'Yuriy Silvestrov' });
    expect((marketplace.plugins as Record<string, unknown>[]).map((p) => [p.name, p.source])).toEqual([['detent', './']]);
  });
  test('describes the plugin with the same text as plugin.json', () => {
    expect((marketplace.plugins as Record<string, unknown>[])[0]?.description).toBe(plugin.description);
  });
});
