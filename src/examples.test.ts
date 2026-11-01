// The examples/ configs are real detent.json files: each must parse to exactly what it says.
// examples/ stays outside the warsaw/beer scan of content.test.ts on purpose.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './config.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('examples/warsaw-beer-bot.detent.json', () => {
  test('parses to the project-specific config', () => {
    expect(parseConfig(read('examples/warsaw-beer-bot.detent.json'))).toStrictEqual({
      ok: true,
      config: {
        language: 'uk',
        specFile: 'spec.md',
        specsDir: 'docs/superpowers/specs',
        plansDir: 'docs/superpowers/plans',
        gate: 'npm test && npm run typecheck',
        baseBranch: 'origin/main',
        tmpDir: 'tmp',
        reviewers: ['codex', 'claude', 'agy'],
        models: { codex: 'gpt-6.1-sol', agy: 'gemini-4-argon' },
        reviewContext: 'One host, SQLite, a budget of $20–40/month, a single maintainer. Merged means deployed: the host deploys main after a merge, except a PR marked [deploy:hold].',
      },
    });
  });
});
