import { describe, test, expect } from 'vitest';
import { join } from 'node:path';
import { ADAPTERS, REVIEWER_IDS, isReviewerId, familyOfAuthor, errorLineOf } from './adapters.js';

const P = { prompt: 'P', reportPath: '/t/run/report.md', runDir: '/t/run' };
const AGY_SETTINGS = '{"permissions":{"deny":["write_file(*)"]}}';

describe('reviewer ids', () => {
  test('the three ids in spec order', () => {
    expect(REVIEWER_IDS).toEqual(['claude', 'codex', 'agy']);
  });
  test('a known id is an id', () => {
    expect(isReviewerId('agy')).toBe(true);
  });
  test('an unknown, differently cased or empty id is not', () => {
    expect([isReviewerId('gemini'), isReviewerId('Codex'), isReviewerId('')]).toEqual([false, false, false]);
  });
  test('an inherited Object name is not an id', () => {
    expect(isReviewerId('constructor')).toBe(false);
  });
});

describe('adapter metadata', () => {
  test('codex: openai, stable, read-only by its sandbox', () => {
    const a = ADAPTERS.codex;
    expect([a.id, a.family, a.status, a.readOnlyBy]).toEqual(['codex', 'openai', 'stable', 'sandbox']);
  });
  test('claude: anthropic, stable, read-only by its tool set', () => {
    const a = ADAPTERS.claude;
    expect([a.id, a.family, a.status, a.readOnlyBy]).toEqual(['claude', 'anthropic', 'stable', 'toolset']);
  });
  test('agy: google, stable, read-only by the deny rule', () => {
    const a = ADAPTERS.agy;
    expect([a.id, a.family, a.status, a.readOnlyBy]).toEqual(['agy', 'google', 'stable', 'deny-rule']);
  });
  test('error lines: claude stdout last, codex stderr last, agy stderr first', () => {
    expect([ADAPTERS.claude.errorLine, ADAPTERS.codex.errorLine, ADAPTERS.agy.errorLine]).toEqual([
      { stream: 'stdout', prefix: 'API Error:', which: 'last' },
      { stream: 'stderr', prefix: 'ERROR:', which: 'last' },
      { stream: 'stderr', prefix: 'error:', which: 'first' },
    ]);
  });
  test('only agy has a canary', () => {
    expect([ADAPTERS.claude.canary, ADAPTERS.codex.canary]).toEqual([undefined, undefined]);
  });
});

describe('acceptsModel', () => {
  test('agy takes gemini-* models', () => {
    expect([ADAPTERS.agy.acceptsModel('gemini-4-argon'), ADAPTERS.agy.acceptsModel('gemini-4-argon-high')]).toEqual([true, true]);
  });
  test('agy refuses a Claude model', () => {
    expect(ADAPTERS.agy.acceptsModel('claude-opus-5-5')).toBe(false);
  });
  test('agy refuses the bare prefix without the dash and a differently cased one', () => {
    expect([ADAPTERS.agy.acceptsModel('gemini'), ADAPTERS.agy.acceptsModel('Gemini-4-argon')]).toEqual([false, false]);
  });
  test('codex and claude take any model: their own CLI refuses a foreign one', () => {
    expect([ADAPTERS.codex.acceptsModel('claude-opus-5-5'), ADAPTERS.claude.acceptsModel('gpt-6.1-sol')]).toEqual([true, true]);
  });
});

describe('command', () => {
  test('codex: read-only sandbox, ephemeral, report via -o, no model flag without a model', () => {
    expect(ADAPTERS.codex.command(P)).toEqual({
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/run/report.md', 'P'],
      report: 'file',
    });
  });
  test('codex: a model goes in -m before the prompt', () => {
    expect(ADAPTERS.codex.command({ ...P, model: 'gpt-6.1-sol' })).toEqual({
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/run/report.md', '-m', 'gpt-6.1-sol', 'P'],
      report: 'file',
    });
  });
  test('codex: an empty model counts as absent', () => {
    expect(ADAPTERS.codex.command({ ...P, model: '' }).args).toEqual(['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/run/report.md', 'P']);
  });
  test('claude: restricted, read-only tool set, run dir readable, prompt after --', () => {
    expect(ADAPTERS.claude.command(P)).toEqual({
      cmd: 'claude',
      args: ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', '/t/run', '--', 'P'],
      report: 'stdout',
    });
  });
  test('claude: a model goes before --', () => {
    expect(ADAPTERS.claude.command({ ...P, model: 'claude-sonnet-5-5' })).toEqual({
      cmd: 'claude',
      args: ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', '/t/run', '--model', 'claude-sonnet-5-5', '--', 'P'],
      report: 'stdout',
    });
  });
  test('claude: a prompt that starts with dashes stays after --', () => {
    expect(ADAPTERS.claude.command({ ...P, prompt: '--help' }).args).toEqual(
      ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', '/t/run', '--', '--help'],
    );
  });
  test('agy: deny rule, sandbox, model and text output all before -p, the prompt right after it', () => {
    expect(ADAPTERS.agy.command({ ...P, model: 'gemini-4-argon' })).toEqual({
      cmd: 'agy',
      args: ['--settings', '{"permissions":{"deny":["write_file(*)"]}}', '--sandbox', '--model', 'gemini-4-argon', '--output-format', 'text', '-p', 'P'],
      report: 'stdout',
    });
  });
  test('agy without a model throws: its family cannot be proved', () => {
    expect(() => ADAPTERS.agy.command(P)).toThrow('agy needs an explicit model: its CLI default is unknown, so its family cannot be proved');
  });
  test('agy with an empty model throws too', () => {
    expect(() => ADAPTERS.agy.command({ ...P, model: '' })).toThrow('agy needs an explicit model: its CLI default is unknown, so its family cannot be proved');
  });
});

describe('agy canary', () => {
  // The file path is joined by the platform's path module: the runner checks exactly this path.
  const target = join('/t/run', 'canary');
  test('same settings and model, a write_file prompt, and the file that must not appear', () => {
    expect(ADAPTERS.agy.canary?.({ runDir: '/t/run', model: 'gemini-4-argon-low' })).toEqual({
      cmd: 'agy',
      args: ['--settings', AGY_SETTINGS, '--sandbox', '--model', 'gemini-4-argon-low', '--output-format', 'text', '-p',
        `Use the write_file tool to create the file ${target} containing the word canary. Do nothing else.`],
      mustNotExist: target,
    });
  });
});

describe('familyOfAuthor', () => {
  test('claude → anthropic, codex → openai, agy → google', () => {
    expect([familyOfAuthor('claude'), familyOfAuthor('codex'), familyOfAuthor('agy')]).toEqual(['anthropic', 'openai', 'google']);
  });
});

const CLAUDE_OVERLOADED = 'API Error: 529 Overloaded';
const CODEX_LIMIT = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:20 AM.';
const CODEX_NO_NET_STDERR = [
  '2026-09-29T09:38:47.000090Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out',
  'ERROR: Reconnecting... 5/5',
  'ERROR: workspace routing discovery failed',
  '',
].join('\n');
const AGY_BAD_MODEL_STDERR = [
  'error: model "gemini-9" is not available',
  'available models:',
  '  gemini-4-argon',
  '  gemini-4-argon-low',
  '',
].join('\n');

describe('errorLineOf', () => {
  test('claude: its fatal error is the last stdout line', () => {
    expect(errorLineOf(ADAPTERS.claude, `thinking\n${CLAUDE_OVERLOADED}\n`, '')).toBe(CLAUDE_OVERLOADED);
  });
  test('claude: the right prefix mid-transcript is not the error line', () => {
    expect(errorLineOf(ADAPTERS.claude, `${CLAUDE_OVERLOADED}\nand then the review went on`, '')).toBeNull();
  });
  test('codex: the last stderr line, repeated limit lines included', () => {
    expect(errorLineOf(ADAPTERS.codex, '', `OpenAI Codex v0.158.0\n${CODEX_LIMIT}\n${CODEX_LIMIT}\n`)).toBe(CODEX_LIMIT);
  });
  test('codex: the last ERROR: line wins over earlier ones', () => {
    expect(errorLineOf(ADAPTERS.codex, '', CODEX_NO_NET_STDERR)).toBe('ERROR: workspace routing discovery failed');
  });
  test('codex: a first-line error followed by other text is not the last line', () => {
    expect(errorLineOf(ADAPTERS.codex, '', 'ERROR: boom\nshutting down')).toBeNull();
  });
  test('codex: the right prefix on the wrong stream does not count', () => {
    expect(errorLineOf(ADAPTERS.codex, CODEX_LIMIT, '')).toBeNull();
  });
  test('codex: a bare carriage return separates lines (progress output)', () => {
    expect(errorLineOf(ADAPTERS.codex, '', 'Reconnecting... 5/5\rERROR: workspace routing discovery failed')).toBe('ERROR: workspace routing discovery failed');
  });
  test('agy: the first stderr line, the model list after it notwithstanding', () => {
    expect(errorLineOf(ADAPTERS.agy, '', AGY_BAD_MODEL_STDERR)).toBe('error: model "gemini-9" is not available');
  });
  test('agy: leading blank lines and CRLF do not hide the first line', () => {
    expect(errorLineOf(ADAPTERS.agy, '', '\r\n  \r\n  error: quota exceeded  \r\navailable models:\r\n')).toBe('error: quota exceeded');
  });
  test('agy: an error: line that is not the first line does not count', () => {
    expect(errorLineOf(ADAPTERS.agy, '', 'jetski: starting\nerror: quota exceeded')).toBeNull();
  });
  test('agy: the prefix is case-sensitive, so codex-style ERROR: is not agy\'s', () => {
    expect(errorLineOf(ADAPTERS.agy, '', 'ERROR: quota exceeded')).toBeNull();
  });
  test('agy: the jetski no-output line is not an error line', () => {
    expect(errorLineOf(ADAPTERS.agy, '', 'jetski: no output produced — a tool required the "command" permission')).toBeNull();
  });
  test('empty streams have no error line', () => {
    expect([errorLineOf(ADAPTERS.claude, '', ''), errorLineOf(ADAPTERS.codex, '', ''), errorLineOf(ADAPTERS.agy, '', '')]).toEqual([null, null, null]);
  });
  test('whitespace-only streams have no error line', () => {
    expect(errorLineOf(ADAPTERS.agy, '', ' \n\t\r\n')).toBeNull();
  });
  test('a bare prefix is still the error line (the runner falls back to the exit code)', () => {
    expect(errorLineOf(ADAPTERS.codex, '', 'ERROR:')).toBe('ERROR:');
  });
});
