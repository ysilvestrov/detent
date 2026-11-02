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
  test('has the nine steps', () => {
    expect(skill.match(/^\d\. \*\*/gm)).toEqual(['1. **', '2. **', '3. **', '4. **', '5. **', '6. **', '7. **', '8. **', '9. **']);
  });
  test('with Superpowers, the estimate question ends the first message', () => {
    expect(skill.replace(/\s+/g, ' ').includes('Do not name yours or hint at it. With Superpowers, this question ends your first message.')).toBe(true);
  });
  test('the builder check runs before the cross-review and feeds the owner questions', () => {
    expect(skill.match(/^\d\. \*\*(Builder check|Commit, then cross-review\.)\*\*/gm)).toEqual(['6. **Builder check**', '7. **Commit, then cross-review.**']);
    expect(skill.replace(/\s+/g, ' ').includes('More than three such questions means the spec is not ready: ask the owner before the cross-review, in one message.')).toBe(true);
  });
  test('spec-format.md counts the builder questions among the owner questions', () => {
    const format = read('skills/design-spec/spec-format.md');
    expect(format.includes("| Questions for the owner | At most three; with Superpowers, these include the builder check's questions only the owner can answer | \"None\" is allowed |")).toBe(true);
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
  const flat = skill.replace(/\s+/g, ' ');
  test('saves plans in monthly folders', () => {
    expect(flat.includes('save them under `<plansDir>/<YYYY-MM>/`.')).toBe(true);
  });
  test("with Superpowers, the core plan's final review is the end-to-end review", () => {
    expect(flat.includes('With Superpowers, the final whole-branch review of the core plan is this review.')).toBe(true);
  });
  test('the next review package starts before the inline task', () => {
    expect(flat.includes("Record the base commit before the inline task, so that the next task's review package starts from it.")).toBe(true);
  });
  test('the dispatch rule is scoped to subagent-driven-development', () => {
    expect(flat.includes('With `superpowers:executing-plans` every task is done inline; the dispatch rule applies only to `superpowers:subagent-driven-development`.')).toBe(true);
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
    expect(skill.match(/^npx -y @ysilvestrov\/detent cross-review .*$/gm)).toEqual([
      'npx -y @ysilvestrov/detent cross-review --author <id>                # the branch against baseBranch',
      'npx -y @ysilvestrov/detent cross-review --author <id> --spec <file>  # a committed spec',
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
  // Rule 7 wraps and indents its lines; the overrides are pinned on single-spaced text.
  const flat = text.replace(/\s+/g, ' ');
  test('names the Superpowers version the overrides were checked against', () => {
    expect(text.includes('checked against Superpowers 7.0.1')).toBe(true);
  });
  test('names the seven Superpowers skills that were checked', () => {
    expect(flat.includes('checked against Superpowers 7.0.1 (brainstorming, writing-plans, subagent-driven-development, executing-plans, finishing-a-development-branch, using-git-worktrees, requesting-code-review)')).toBe(true);
  });
  test.each([
    ['sizing is the estimate game', "the question that ends your first message is the owner's size (XS–XL), and yours comes only after an approach is picked."],
    ['builder check before cross-review, not a reviewer', 'Before the owner sees a spec: builder check, then `cross-review --spec`. The builder is of your family and is not the reviewer of rule 6;'],
    ['more than three owner questions: one message before the cross-review', 'More than three such questions means the spec is not ready: ask them in one message before the cross-review.'],
    ['a spike commits nothing', 'A spike commits nothing.'],
    ['specs in monthly folders', 'Specs go to `<specsDir>/<YYYY-MM>/`, never flat.'],
    ['plans in monthly folders', 'save it under `<plansDir>/<YYYY-MM>/`.'],
    ['no plan review round', 'Do not ask the owner to review the plan or pick an execution method'],
    ['the core plan ends in its end-to-end review', 'the final review of a core plan is its end-to-end review: write the harness plan next, and finish the branch only after the last plan.'],
    ['an owner-section ruling stops the run', "A ruling that would change the spec's owner section stops the run"],
    ['the plan workspace is not deleted', "Never delete the plan's workspace; rule 8 applies."],
    ['finishing takes baseBranch and runs cross-review', 'do not ask for the base branch: rebase on `baseBranch`, run the gate, run `cross-review`, then open the PR by default'],
  ])('rule 7: %s', (_name, phrase) => {
    expect(flat.includes(phrase)).toBe(true);
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

describe('the command in the rules', () => {
  const files = [...filesUnder('skills'), ...filesUnder('constitution')];
  test.each(files)('%s names the scoped package, not bare `npx detent`', (file) => {
    expect(read(file).includes('npx detent')).toBe(false);
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
