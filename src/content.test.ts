// The shipped texts: skills, the constitution block and the review prompts.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const skillDirs = readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// The YAML frontmatter as flat `key: value` lines; throws when there is none.
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (m === null) throw new Error('no frontmatter');
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

function filesUnder(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .map((p) => join(dir, p).replaceAll('\\', '/'))
    .filter((p) => statSync(join(root, p)).isFile())
    .sort();
}

describe('skills', () => {
  test('the skill set', () => {
    expect(skillDirs).toEqual(['cross-review', 'design-spec', 'dev-cycle', 'pr-slicing']);
  });

  test.each(skillDirs)('skills/%s/SKILL.md: name is detent-<dir>, lower-case and dashes', (dir) => {
    const fm = frontmatter(read(`skills/${dir}/SKILL.md`));
    expect(fm.name).toBe(`detent-${dir}`);
    expect(/^[a-z0-9-]+$/.test(fm.name!)).toBe(true);
  });

  test.each(skillDirs)('skills/%s/SKILL.md: description is not empty', (dir) => {
    const fm = frontmatter(read(`skills/${dir}/SKILL.md`));
    expect(typeof fm.description).toBe('string');
    expect(fm.description).not.toBe('');
  });
});

describe('design-spec skill', () => {
  const skill = read('skills/design-spec/SKILL.md');
  test('states the process point', () => {
    expect(frontmatter(skill).description!.startsWith('Use when writing an architectural design spec')).toBe(true);
  });
  test('points at the format file next to it, which exists', () => {
    expect(skill.includes('`spec-format.md` next to this file')).toBe(true);
    expect(statSync(join(root, 'skills/design-spec/spec-format.md')).isFile()).toBe(true);
  });
  test('tells the agent to write in the configured language', () => {
    expect(skill.includes('Write the spec in the `language` from `detent.json`')).toBe(true);
  });
  test('spec-format.md carries the generalised L size and goal', () => {
    const format = read('skills/design-spec/spec-format.md');
    expect(format.includes('| L | 2–3 PRs, or a step a human performs outside the repo |')).toBe(true);
    expect(format.includes("what changes for the product's users or for the project's resources")).toBe(true);
  });
});

describe('pr-slicing skill', () => {
  const skill = read('skills/pr-slicing/SKILL.md');
  test('states the process point', () => {
    expect(frontmatter(skill).description!.startsWith('Use when writing an implementation plan or deciding how to cut a change into PRs')).toBe(true);
  });
  test('carries the three inline conditions', () => {
    expect(skill.match(/^- \([abc]\) .*$/gm)).toEqual([
      '- (a) the plan\'s text for the task contains the complete code;',
      '- (b) it touches at most two files plus their tests;',
      '- (c) it needs no new decision.',
    ]);
  });
});

describe('cross-review skill', () => {
  const skill = read('skills/cross-review/SKILL.md');
  test('states the process point', () => {
    expect(frontmatter(skill).description!.startsWith('Use when a design spec is committed')).toBe(true);
  });
  test('has exactly one pair of author markers', () => {
    expect(skill.match(/<!-- detent:author (?:begin|end) -->/g)).toEqual(['<!-- detent:author begin -->', '<!-- detent:author end -->']);
  });
  test('between the markers: the Claude author line', () => {
    const m = /<!-- detent:author begin -->\r?\n([\s\S]*?)\r?\n<!-- detent:author end -->/.exec(skill);
    expect(m![1]).toBe('You are Claude: pass --author claude.');
  });
  test('names --reviewer once, as the flag never to pass', () => {
    expect(skill.split('--reviewer').length).toBe(2);
    expect(skill.includes('Never pass `--reviewer`')).toBe(true);
  });
  test('the commands it runs pass --author and no --reviewer', () => {
    expect(skill.match(/^npx detent cross-review .*$/gm)).toEqual([
      'npx detent cross-review --author <id>                # the branch against baseBranch',
      'npx detent cross-review --author <id> --spec <file>  # a committed spec',
    ]);
  });
  test('runs in the background', () => {
    expect(skill.includes('Run it **in the background**')).toBe(true);
  });
  test('reads the marker after its stdout prefix', () => {
    expect(skill.includes('take the text after `PR marker: ` or')).toBe(true);
    expect(skill.includes('`Spec marker: `.')).toBe(true);
  });
  test('docs-only PRs get the skipped marker', () => {
    expect(skill.includes('`Cross-review: skipped (docs-only)`')).toBe(true);
  });
  test('on exit 5 tells the human explicitly', () => {
    expect(skill.includes('**Tell the human explicitly in')).toBe(true);
  });
});

describe('dev-cycle skill', () => {
  const skill = read('skills/dev-cycle/SKILL.md');
  test('description is exactly the explicit-only line', () => {
    expect(frontmatter(skill).description).toBe('Only when invoked explicitly.');
  });
  test('the first step checks for Superpowers and hands over to its brainstorming', () => {
    expect(skill.includes('1. **Check for Superpowers, then retell the task.** If `superpowers:brainstorming` is among your')).toBe(true);
    expect(skill.includes('`superpowers:brainstorming`; stop following this skill.')).toBe(true);
  });
  test('has the five steps', () => {
    expect(skill.match(/^\d\. \*\*/gm)).toEqual(['1. **', '2. **', '3. **', '4. **', '5. **']);
  });
});

describe('constitution', () => {
  const text = read('constitution/constitution.md');
  test('names the Superpowers version the overrides were checked against', () => {
    expect(text.includes('checked against Superpowers 7.0.1')).toBe(true);
  });
  test('does not name the bounded branch', () => {
    expect(text.includes('bounded')).toBe(false);
  });
  test('is the block body only: no markers, no dev-cycle line', () => {
    expect(text.includes('<!--')).toBe(false);
    expect(text.includes('detent-dev-cycle')).toBe(false);
  });
  test('has the eight rules', () => {
    expect(text.match(/^\d\. \*\*/gm)).toEqual(['1. **', '2. **', '3. **', '4. **', '5. **', '6. **', '7. **', '8. **']);
  });
});

describe('no project specifics in shipped texts', () => {
  const banned = ['warsaw', 'beer', 'deploy:hold', 'orphan', 'sqlite'];
  const files = [...filesUnder('skills'), ...filesUnder('constitution'), ...filesUnder('prompts')];

  test('the scan reaches every shipped folder', () => {
    expect(files.includes('skills/design-spec/SKILL.md')).toBe(true);
    expect(files.includes('constitution/constitution.md')).toBe(true);
    expect(files.includes('prompts/review-spec.md')).toBe(true);
  });

  test.each(files)('%s', (file) => {
    const lower = read(file).toLowerCase();
    expect(banned.filter((w) => lower.includes(w))).toEqual([]);
  });
});
