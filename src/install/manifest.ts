// `.detent/manifest.json`: what the installer wrote, so a later install can tell its own file
// from a hand edit (spec, «Установка»). Hashes are of LF-normalised content: a CRLF checkout of
// a committed file is not an edit.
import { createHash } from 'node:crypto';

export interface ManifestEntry { sha256: string; version: string }

export interface Manifest {
  detentVersion: string;
  files: Record<string, ManifestEntry>; // project path with `/` → entry
  blocks: Record<string, ManifestEntry>; // `CLAUDE.md` / `AGENTS.md` → hash of the block's inner text
}

export const MANIFEST_PATH = '.detent/manifest.json';

export function emptyManifest(): Manifest {
  return { detentVersion: '', files: {}, blocks: {} };
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function parseEntries(raw: unknown, key: 'files' | 'blocks'): Record<string, ManifestEntry> | string {
  if (!isPlainObject(raw)) return `${MANIFEST_PATH}: "${key}" must be an object`;
  const out: Record<string, ManifestEntry> = {};
  for (const [path, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry) || typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256) || typeof entry.version !== 'string') {
      return `${MANIFEST_PATH}: "${key}.${path}" must be { "sha256": <64 hex>, "version": <string> }`;
    }
    out[path] = { sha256: entry.sha256, version: entry.version };
  }
  return out;
}

// No file → an empty manifest. A broken file is an error (exit 2): without it the installer
// cannot tell its own files from edited ones.
export function parseManifest(text: string | null): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  if (text === null) return { ok: true, manifest: emptyManifest() };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, error: `${MANIFEST_PATH} is not valid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(raw)) return { ok: false, error: `${MANIFEST_PATH} must be a JSON object` };
  if (typeof raw.detentVersion !== 'string') return { ok: false, error: `${MANIFEST_PATH}: "detentVersion" must be a string` };
  const files = parseEntries(raw.files, 'files');
  if (typeof files === 'string') return { ok: false, error: files };
  const blocks = parseEntries(raw.blocks, 'blocks');
  if (typeof blocks === 'string') return { ok: false, error: blocks };
  return { ok: true, manifest: { detentVersion: raw.detentVersion, files, blocks } };
}

function sorted(entries: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(entries).sort()) {
    const e = entries[key] as ManifestEntry;
    out[key] = { sha256: e.sha256, version: e.version };
  }
  return out;
}

// Keys sorted, 2-space JSON, trailing newline: the same manifest always serialises the same.
export function serializeManifest(m: Manifest): string {
  return JSON.stringify({ detentVersion: m.detentVersion, files: sorted(m.files), blocks: sorted(m.blocks) }, null, 2) + '\n';
}
