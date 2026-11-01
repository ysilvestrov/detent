import { describe, test, expect } from 'vitest';
import { planInstall, plannedPaths, type InstallInput, type InstallPlan, type Action } from './plan.js';

const B = '<!-- detent:constitution v1 begin — edit outside these markers; `npx detent install` rewrites this block -->';
const E = '<!-- detent:constitution end -->';
const DEV = 'Without Superpowers, start any behaviour change with `detent-dev-cycle`';
const AGENTS_LINE =
  'You are Codex or Antigravity: pass --author codex in Codex and --author agy in Antigravity on a Gemini model; if Antigravity runs you on a Claude model, pass --author claude, because the rule is about the model family that wrote the work.';

const CROSS = '# x\n<!-- detent:author begin -->\nYou are Claude: pass --author claude.\n<!-- detent:author end -->\nend\n';
const CROSS_AGENTS = `# x\n<!-- detent:author begin -->\n${AGENTS_LINE}\n<!-- detent:author end -->\nend\n`;
const CONSTITUTION = '## Rules\n\n1. One.\n';
const INNER = '## Rules\n\n1. One.\n';
const INNER_DEV = `## Rules\n\n1. One.\n\n${DEV}\n`;
const BLOCK = `${B}\n${INNER}${E}\n`;
const BLOCK_DEV = `${B}\n${INNER_DEV}${E}\n`;

// sha256 of the LF texts above, computed once with `node -e`.
const H = {
  alpha: 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060', // "alpha\n"
  alphaV2: 'ac87f7fdd6e31ebd160dcc5fd0fd6d21e5691d9996b9c7d57543207078778c6f', // "alpha v2\n"
  edited: 'd024b0ecd55aa8396c9c492f1ad01b68b6bc15c60f8b61b92bd36b60d506ab14', // "alpha edited\n"
  format: '06fc9c397e9dc7d907bf567166eb3adc638950418ae757cde915a754b70f4bc7', // "format\n"
  cross: '4ee81c1e318a749421128edda6008b58f1c192a9f9f508682d5c61d42bad780a',
  crossAgents: '349d947aee0ed4732752df09cfc5ef1810179f86fa8a09ada7c3a3b331605758',
  inner: 'f7af303eed4f018e2720a88429e6e4a12cad96789e4cba9a62d60bc30b3fe5d1',
  innerDev: '8563cbce7611db9c0f55fc63b9cced11b94c7e35e15c0a931fcccaa54f02b8d4',
  innerOld: '7f682e816b0d1a3594bf572de04c5b7fd25a7598b122d074ba8a96bd090d07c1', // "## Rules\n\n1. Old.\n\n<DEV>\n"
} as const;

const SOURCES = {
  skills: { 'cross-review/SKILL.md': CROSS, 'alpha/spec-format.md': 'format\n', 'alpha/SKILL.md': 'alpha\n' },
  constitution: CONSTITUTION,
};

const P = {
  cA: '.claude/skills/detent-alpha/SKILL.md',
  cF: '.claude/skills/detent-alpha/spec-format.md',
  cX: '.claude/skills/detent-cross-review/SKILL.md',
  aA: '.agents/skills/detent-alpha/SKILL.md',
  aF: '.agents/skills/detent-alpha/spec-format.md',
  aX: '.agents/skills/detent-cross-review/SKILL.md',
} as const;

const NO_SP = { claude: { found: false, where: [] }, agents: { found: false, where: [] } };

const DETENT_JSON = `{
  "language": "uk",
  "specFile": "spec.md",
  "specsDir": "docs/specs",
  "plansDir": "docs/plans",
  "gate": "npm test && npm run typecheck",
  "baseBranch": "origin/main",
  "tmpDir": "tmp",
  "reviewers": [
    "codex",
    "claude",
    "agy"
  ],
  "models": {
    "codex": "gpt-6.1-sol",
    "agy": "gemini-4-argon"
  }
}
`;

const e = (sha256: string, version = '0.1.0') => ({ sha256, version });

// The manifest a first install of both targets without Superpowers writes.
const MANIFEST_FULL = `{
  "detentVersion": "0.1.0",
  "files": {
    ".agents/skills/detent-alpha/SKILL.md": {
      "sha256": "${H.alpha}",
      "version": "0.1.0"
    },
    ".agents/skills/detent-alpha/spec-format.md": {
      "sha256": "${H.format}",
      "version": "0.1.0"
    },
    ".agents/skills/detent-cross-review/SKILL.md": {
      "sha256": "${H.crossAgents}",
      "version": "0.1.0"
    },
    ".claude/skills/detent-alpha/SKILL.md": {
      "sha256": "${H.alpha}",
      "version": "0.1.0"
    },
    ".claude/skills/detent-alpha/spec-format.md": {
      "sha256": "${H.format}",
      "version": "0.1.0"
    },
    ".claude/skills/detent-cross-review/SKILL.md": {
      "sha256": "${H.cross}",
      "version": "0.1.0"
    }
  },
  "blocks": {
    "AGENTS.md": {
      "sha256": "${H.innerDev}",
      "version": "0.1.0"
    },
    "CLAUDE.md": {
      "sha256": "${H.innerDev}",
      "version": "0.1.0"
    }
  }
}
`;

// The project right after that first install.
const INSTALLED: Record<string, string> = {
  [P.cA]: 'alpha\n', [P.cF]: 'format\n', [P.cX]: CROSS,
  [P.aA]: 'alpha\n', [P.aF]: 'format\n', [P.aX]: CROSS_AGENTS,
  'CLAUDE.md': BLOCK_DEV, 'AGENTS.md': BLOCK_DEV,
};

const FRESH: InstallInput = {
  targets: ['claude', 'agents'],
  sources: SOURCES,
  existing: {},
  manifest: null,
  superpowers: NO_SP,
  gitignore: null,
  detentJson: null,
  version: '0.1.0',
};

const REINSTALL: InstallInput = { ...FRESH, existing: INSTALLED, manifest: MANIFEST_FULL, gitignore: 'tmp\n', detentJson: DETENT_JSON };

type Ok = Extract<InstallPlan, { ok: true }>;
const ok = (p: InstallPlan) => p as Ok;
const lines = (p: InstallPlan) => ok(p).actions.map((a) => `${a.kind} ${a.path}`);
const action = (p: InstallPlan, path: string) => ok(p).actions.find((a) => a.path === path) as Action;
const manifestOf = (p: InstallPlan) => JSON.parse((action(p, '.detent/manifest.json') as { content: string }).content) as unknown;

describe('planInstall — empty project', () => {
  test('both targets, no Superpowers: every file is created, the manifest last', () => {
    expect(planInstall(FRESH)).toEqual({
      ok: true,
      actions: [
        { kind: 'create', subject: 'skill', path: P.cA, content: 'alpha\n' },
        { kind: 'create', subject: 'skill', path: P.cF, content: 'format\n' },
        { kind: 'create', subject: 'skill', path: P.cX, content: CROSS },
        { kind: 'create', subject: 'skill', path: P.aA, content: 'alpha\n' },
        { kind: 'create', subject: 'skill', path: P.aF, content: 'format\n' },
        { kind: 'create', subject: 'skill', path: P.aX, content: CROSS_AGENTS },
        { kind: 'create', subject: 'block', path: 'CLAUDE.md', content: BLOCK_DEV },
        { kind: 'create', subject: 'block', path: 'AGENTS.md', content: BLOCK_DEV },
        { kind: 'create', subject: 'detentJson', path: 'detent.json', content: DETENT_JSON },
        { kind: 'create', subject: 'gitignore', path: '.gitignore', content: 'tmp\n' },
        { kind: 'create', subject: 'manifest', path: '.detent/manifest.json', content: MANIFEST_FULL },
      ],
      notes: [],
      devCycleLine: { claude: true, agents: true },
    });
  });
  test('targets given twice and out of order are planned once, in the fixed order', () => {
    expect(lines(planInstall({ ...FRESH, targets: ['agents', 'claude', 'agents'] }))).toEqual([
      `create ${P.cA}`, `create ${P.cF}`, `create ${P.cX}`,
      `create ${P.aA}`, `create ${P.aF}`, `create ${P.aX}`,
      'create CLAUDE.md', 'create AGENTS.md',
      'create detent.json', 'create .gitignore', 'create .detent/manifest.json',
    ]);
  });
  test('no targets: only detent.json, .gitignore and the manifest', () => {
    expect(planInstall({ ...FRESH, targets: [] })).toEqual({
      ok: true,
      actions: [
        { kind: 'create', subject: 'detentJson', path: 'detent.json', content: DETENT_JSON },
        { kind: 'create', subject: 'gitignore', path: '.gitignore', content: 'tmp\n' },
        { kind: 'create', subject: 'manifest', path: '.detent/manifest.json', content: '{\n  "detentVersion": "0.1.0",\n  "files": {},\n  "blocks": {}\n}\n' },
      ],
      notes: [],
      devCycleLine: {},
    });
  });
  test('CRLF sources are written LF', () => {
    const p = planInstall({ ...FRESH, targets: ['claude'], sources: { skills: { 'alpha/SKILL.md': 'alpha\r\n' }, constitution: '## Rules\r\n\r\n1. One.\r\n' } });
    expect([action(p, P.cA), action(p, 'CLAUDE.md')]).toEqual([
      { kind: 'create', subject: 'skill', path: P.cA, content: 'alpha\n' },
      { kind: 'create', subject: 'block', path: 'CLAUDE.md', content: BLOCK_DEV },
    ]);
  });
});

describe('planInstall — reinstall', () => {
  test('nothing changed: everything is unchanged', () => {
    expect(planInstall(REINSTALL)).toEqual({
      ok: true,
      actions: [
        { kind: 'unchanged', subject: 'skill', path: P.cA },
        { kind: 'unchanged', subject: 'skill', path: P.cF },
        { kind: 'unchanged', subject: 'skill', path: P.cX },
        { kind: 'unchanged', subject: 'skill', path: P.aA },
        { kind: 'unchanged', subject: 'skill', path: P.aF },
        { kind: 'unchanged', subject: 'skill', path: P.aX },
        { kind: 'unchanged', subject: 'block', path: 'CLAUDE.md' },
        { kind: 'unchanged', subject: 'block', path: 'AGENTS.md' },
        { kind: 'unchanged', subject: 'detentJson', path: 'detent.json' },
        { kind: 'unchanged', subject: 'gitignore', path: '.gitignore' },
        { kind: 'unchanged', subject: 'manifest', path: '.detent/manifest.json' },
      ],
      notes: [],
      devCycleLine: { claude: true, agents: true },
    });
  });
  test('a CRLF checkout of the same files, blocks and manifest is unchanged', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const existing = Object.fromEntries(Object.entries(INSTALLED).map(([k, v]) => [k, crlf(v)]));
    expect(lines(planInstall({ ...REINSTALL, existing, manifest: crlf(MANIFEST_FULL), gitignore: 'tmp\r\n' }))).toEqual([
      `unchanged ${P.cA}`, `unchanged ${P.cF}`, `unchanged ${P.cX}`,
      `unchanged ${P.aA}`, `unchanged ${P.aF}`, `unchanged ${P.aX}`,
      'unchanged CLAUDE.md', 'unchanged AGENTS.md',
      'unchanged detent.json', 'unchanged .gitignore', 'unchanged .detent/manifest.json',
    ]);
  });
  test('a new detent version with the same content: files unchanged, the manifest records the version', () => {
    const p = planInstall({ ...REINSTALL, targets: ['claude'], version: '0.2.0' });
    expect([lines(p), manifestOf(p)]).toEqual([
      [`unchanged ${P.cA}`, `unchanged ${P.cF}`, `unchanged ${P.cX}`, 'unchanged CLAUDE.md', 'unchanged detent.json', 'unchanged .gitignore', 'update .detent/manifest.json'],
      {
        detentVersion: '0.2.0',
        files: {
          [P.aA]: e(H.alpha), [P.aF]: e(H.format), [P.aX]: e(H.crossAgents),
          [P.cA]: e(H.alpha, '0.2.0'), [P.cF]: e(H.format, '0.2.0'), [P.cX]: e(H.cross, '0.2.0'),
        },
        blocks: { 'AGENTS.md': e(H.innerDev), 'CLAUDE.md': e(H.innerDev, '0.2.0') },
      },
    ]);
  });
  test('a skill the manifest vouches for and the source changed: update', () => {
    const p = planInstall({ ...REINSTALL, targets: ['claude'], sources: { ...SOURCES, skills: { ...SOURCES.skills, 'alpha/SKILL.md': 'alpha v2\n' } } });
    expect([action(p, P.cA), (manifestOf(p) as { files: Record<string, unknown> }).files[P.cA]]).toEqual([
      { kind: 'update', subject: 'skill', path: P.cA, content: 'alpha v2\n' },
      e(H.alphaV2),
    ]);
  });
});

describe('planInstall — conflicts: nothing is planned', () => {
  test('a skill edited by hand: one conflict and no actions', () => {
    expect(planInstall({ ...REINSTALL, existing: { ...INSTALLED, [P.cA]: 'alpha edited\n' } })).toEqual({
      ok: false,
      conflicts: [{ path: P.cA, reason: 'changed since detent wrote it (sha256 differs from the manifest)' }],
    });
  });
  test('a skill edited by hand blocks the update of that skill too', () => {
    const p = planInstall({
      ...REINSTALL,
      existing: { ...INSTALLED, [P.aA]: 'alpha edited\n' },
      sources: { ...SOURCES, skills: { ...SOURCES.skills, 'alpha/SKILL.md': 'alpha v2\n' } },
    });
    expect(p).toEqual({ ok: false, conflicts: [{ path: P.aA, reason: 'changed since detent wrote it (sha256 differs from the manifest)' }] });
  });
  test('a file without a manifest record that differs: conflict', () => {
    expect(planInstall({ ...FRESH, targets: ['claude'], existing: { [P.cF]: 'my format\n' } })).toEqual({
      ok: false,
      conflicts: [{ path: P.cF, reason: 'differs from what detent would write and has no manifest record' }],
    });
  });
  test('every conflict is listed, files and blocks', () => {
    expect(planInstall({
      ...REINSTALL,
      existing: { ...INSTALLED, [P.cX]: 'x\n', [P.aF]: 'y\n', 'CLAUDE.md': `${B}\n${INNER_DEV}hand edit\n${E}\n`, 'AGENTS.md': `${B}\n` },
    })).toEqual({
      ok: false,
      conflicts: [
        { path: P.cX, reason: 'changed since detent wrote it (sha256 differs from the manifest)' },
        { path: P.aF, reason: 'changed since detent wrote it (sha256 differs from the manifest)' },
        { path: 'CLAUDE.md', reason: 'the constitution block changed since detent wrote it (sha256 differs from the manifest)' },
        { path: 'AGENTS.md', reason: 'broken constitution markers: a begin marker without an end marker' },
      ],
    });
  });
  test('only an end marker', () => {
    expect(planInstall({ ...FRESH, targets: ['agents'], existing: { 'AGENTS.md': `# A\n${E}\n` } })).toEqual({
      ok: false, conflicts: [{ path: 'AGENTS.md', reason: 'broken constitution markers: an end marker without a begin marker' }],
    });
  });
  test('two pairs of markers', () => {
    expect(planInstall({ ...FRESH, targets: ['claude'], existing: { 'CLAUDE.md': BLOCK + BLOCK } })).toEqual({
      ok: false, conflicts: [{ path: 'CLAUDE.md', reason: 'broken constitution markers: 2 begin and 2 end markers: expected one pair' }],
    });
  });
  test('a block without a manifest record that differs: conflict', () => {
    expect(planInstall({ ...FRESH, targets: ['claude'], existing: { 'CLAUDE.md': `${B}\nmine\n${E}\n` } })).toEqual({
      ok: false, conflicts: [{ path: 'CLAUDE.md', reason: 'the constitution block differs from what detent would write and has no manifest record' }],
    });
  });
});

describe('planInstall — files already there without a manifest record', () => {
  test('the same content (even CRLF) is adopted, not written', () => {
    const p = planInstall({ ...FRESH, targets: ['claude'], existing: { [P.cA]: 'alpha\r\n', 'CLAUDE.md': `# Mine\r\n\r\n${BLOCK_DEV}` } });
    expect([lines(p), manifestOf(p)]).toEqual([
      [`adopt ${P.cA}`, `create ${P.cF}`, `create ${P.cX}`, 'adopt CLAUDE.md', 'create detent.json', 'create .gitignore', 'create .detent/manifest.json'],
      { detentVersion: '0.1.0', files: { [P.cA]: e(H.alpha), [P.cF]: e(H.format), [P.cX]: e(H.cross) }, blocks: { 'CLAUDE.md': e(H.innerDev) } },
    ]);
  });
  test('a manifest record with another hash, but the content is what detent writes: adopt', () => {
    const manifest = `{"detentVersion":"0.1.0","files":{"${P.cA}":{"sha256":"${H.edited}","version":"0.1.0"}},"blocks":{}}`;
    expect(action(planInstall({ ...FRESH, targets: ['claude'], manifest, existing: { [P.cA]: 'alpha\n' } }), P.cA)).toEqual({ kind: 'adopt', subject: 'skill', path: P.cA });
  });
  test('a file the manifest records but that is gone is created again', () => {
    const { [P.cA]: _gone, ...rest } = INSTALLED;
    expect(action(planInstall({ ...REINSTALL, existing: rest }), P.cA)).toEqual({ kind: 'create', subject: 'skill', path: P.cA, content: 'alpha\n' });
  });
});

describe('planInstall — the constitution block', () => {
  test('a file without markers gets the block appended; the text before it is kept', () => {
    const p = planInstall({ ...FRESH, targets: ['claude'], existing: { 'CLAUDE.md': '# Project\r\nnotes' } });
    expect(action(p, 'CLAUDE.md')).toEqual({ kind: 'update', subject: 'block', path: 'CLAUDE.md', content: `# Project\r\nnotes\n\n${BLOCK_DEV}` });
  });
  test('an empty file gets the block alone', () => {
    expect(action(planInstall({ ...FRESH, targets: ['agents'], existing: { 'AGENTS.md': '' } }), 'AGENTS.md')).toEqual({
      kind: 'update', subject: 'block', path: 'AGENTS.md', content: BLOCK_DEV,
    });
  });
  test('a block the manifest vouches for is replaced between the markers; text outside stays byte for byte', () => {
    const old = `${B}\r\n## Rules\r\n\r\n1. Old.\r\n\r\n${DEV}\r\n${E}\r\n`;
    const manifest = `{"detentVersion":"0.0.9","files":{},"blocks":{"CLAUDE.md":{"sha256":"${H.innerOld}","version":"0.0.9"}}}`;
    const p = planInstall({ ...FRESH, targets: ['claude'], manifest, existing: { 'CLAUDE.md': `# Top\r\n\r\n${old}\r\n## Bottom\r\n` } });
    expect([action(p, 'CLAUDE.md'), (manifestOf(p) as { blocks: unknown }).blocks]).toEqual([
      { kind: 'update', subject: 'block', path: 'CLAUDE.md', content: `# Top\r\n\r\n${BLOCK_DEV}\r\n## Bottom\r\n` },
      { 'CLAUDE.md': e(H.innerDev) },
    ]);
  });
});

describe('planInstall — Superpowers and the dev-cycle line', () => {
  const claudeOnly = { claude: { found: true, where: ['~/.claude/settings.json: enabledPlugins["superpowers@m"]'] }, agents: { found: false, where: [] } };
  test('found for claude only: the line goes into AGENTS.md alone', () => {
    const p = planInstall({ ...FRESH, superpowers: claudeOnly });
    expect([action(p, 'CLAUDE.md'), action(p, 'AGENTS.md'), ok(p).devCycleLine]).toEqual([
      { kind: 'create', subject: 'block', path: 'CLAUDE.md', content: BLOCK },
      { kind: 'create', subject: 'block', path: 'AGENTS.md', content: BLOCK_DEV },
      { claude: false, agents: true },
    ]);
  });
  test('--superpowers no overrides a finding', () => {
    const p = planInstall({ ...FRESH, superpowers: claudeOnly, superpowersFlag: 'no' });
    expect([action(p, 'CLAUDE.md'), action(p, 'AGENTS.md'), ok(p).devCycleLine]).toEqual([
      { kind: 'create', subject: 'block', path: 'CLAUDE.md', content: BLOCK_DEV },
      { kind: 'create', subject: 'block', path: 'AGENTS.md', content: BLOCK_DEV },
      { claude: true, agents: true },
    ]);
  });
  test('--superpowers yes overrides "not found"', () => {
    const p = planInstall({ ...FRESH, superpowersFlag: 'yes' });
    expect([action(p, 'CLAUDE.md'), action(p, 'AGENTS.md'), ok(p).devCycleLine]).toEqual([
      { kind: 'create', subject: 'block', path: 'CLAUDE.md', content: BLOCK },
      { kind: 'create', subject: 'block', path: 'AGENTS.md', content: BLOCK },
      { claude: false, agents: false },
    ]);
  });
  test('Superpowers installed since the last install: the block loses the line (manifest vouches for the old block)', () => {
    const p = planInstall({ ...REINSTALL, targets: ['claude'], superpowers: claudeOnly });
    expect(action(p, 'CLAUDE.md')).toEqual({ kind: 'update', subject: 'block', path: 'CLAUDE.md', content: BLOCK });
  });
});

describe('planInstall — one target', () => {
  test('--claude writes nothing under .agents/ nor AGENTS.md, and keeps their manifest records', () => {
    const p = planInstall({ ...FRESH, targets: ['claude'], manifest: `{"detentVersion":"0.0.9","files":{"${P.aA}":{"sha256":"${H.alpha}","version":"0.0.9"}},"blocks":{"AGENTS.md":{"sha256":"${H.inner}","version":"0.0.9"}}}` });
    expect([lines(p), manifestOf(p), ok(p).devCycleLine]).toEqual([
      [`create ${P.cA}`, `create ${P.cF}`, `create ${P.cX}`, 'create CLAUDE.md', 'create detent.json', 'create .gitignore', 'update .detent/manifest.json'],
      {
        detentVersion: '0.1.0',
        files: { [P.aA]: e(H.alpha, '0.0.9'), [P.cA]: e(H.alpha), [P.cF]: e(H.format), [P.cX]: e(H.cross) },
        blocks: { 'AGENTS.md': e(H.inner, '0.0.9'), 'CLAUDE.md': e(H.innerDev) },
      },
      { claude: true },
    ]);
  });
});

describe('planInstall — stale skills', () => {
  const manifest = `{"detentVersion":"0.0.9","files":{".claude/skills/detent-old/SKILL.md":{"sha256":"${H.alpha}","version":"0.0.9"},".agents/skills/detent-old/SKILL.md":{"sha256":"${H.alpha}","version":"0.0.9"}},"blocks":{}}`;
  test('a recorded skill no longer shipped: a note, no action, and its record stays', () => {
    const p = planInstall({ ...FRESH, manifest });
    expect([ok(p).notes, lines(p).filter((l) => l.includes('detent-old')), (manifestOf(p) as { files: Record<string, unknown> }).files['.claude/skills/detent-old/SKILL.md']]).toEqual([
      [
        '.claude/skills/detent-old/SKILL.md: stale, delete with a script if not needed',
        '.agents/skills/detent-old/SKILL.md: stale, delete with a script if not needed',
      ],
      [],
      e(H.alpha, '0.0.9'),
    ]);
  });
  test('only the selected target is looked at', () => {
    expect(ok(planInstall({ ...FRESH, targets: ['agents'], manifest })).notes).toEqual(['.agents/skills/detent-old/SKILL.md: stale, delete with a script if not needed']);
  });
});

describe('planInstall — detent.json and .gitignore', () => {
  test('an existing detent.json is never touched, and its tmpDir is the one ignored', () => {
    const p = planInstall({ ...FRESH, targets: [], detentJson: '{"tmpDir":"build/tmp"}', gitignore: 'node_modules\n' });
    expect([action(p, 'detent.json'), action(p, '.gitignore')]).toEqual([
      { kind: 'unchanged', subject: 'detentJson', path: 'detent.json' },
      { kind: 'update', subject: 'gitignore', path: '.gitignore', content: 'node_modules\nbuild/tmp\n' },
    ]);
  });
  test('.gitignore without a final newline gets one before tmpDir', () => {
    expect(action(planInstall({ ...FRESH, targets: [], gitignore: 'node_modules' }), '.gitignore')).toEqual({
      kind: 'update', subject: 'gitignore', path: '.gitignore', content: 'node_modules\ntmp\n',
    });
  });
  test('an empty .gitignore', () => {
    expect(action(planInstall({ ...FRESH, targets: [], gitignore: '' }), '.gitignore')).toEqual({
      kind: 'update', subject: 'gitignore', path: '.gitignore', content: 'tmp\n',
    });
  });
  test('tmpDir already ignored as /tmp/ with CRLF', () => {
    expect(action(planInstall({ ...FRESH, targets: [], gitignore: 'dist\r\n/tmp/\r\n' }), '.gitignore')).toEqual({
      kind: 'unchanged', subject: 'gitignore', path: '.gitignore',
    });
  });
  test('a longer name that contains tmpDir does not count', () => {
    expect(action(planInstall({ ...FRESH, targets: [], gitignore: 'tmp2\n' }), '.gitignore')).toEqual({
      kind: 'update', subject: 'gitignore', path: '.gitignore', content: 'tmp2\ntmp\n',
    });
  });
});

describe('planInstall — usage errors (exit 2)', () => {
  test('a broken detent.json', () => {
    expect(planInstall({ ...FRESH, detentJson: '{"tmpDir":1}' })).toEqual({ ok: false, error: 'detent.json: "tmpDir" must be a string' });
  });
  test('a broken manifest', () => {
    expect(planInstall({ ...FRESH, manifest: '{"detentVersion":"0.1.0"}' })).toEqual({ ok: false, error: '.detent/manifest.json: "files" must be an object' });
  });
});

describe('plannedPaths', () => {
  test('skill files per selected target, sorted, then that target block file', () => {
    expect(plannedPaths({ targets: ['agents', 'claude'], skillKeys: ['b/SKILL.md', 'a/x/y.md'] })).toEqual([
      '.claude/skills/detent-a/x/y.md', '.claude/skills/detent-b/SKILL.md', 'CLAUDE.md',
      '.agents/skills/detent-a/x/y.md', '.agents/skills/detent-b/SKILL.md', 'AGENTS.md',
    ]);
  });
  test('no targets: nothing', () => {
    expect(plannedPaths({ targets: [], skillKeys: ['a/SKILL.md'] })).toEqual([]);
  });
});
