import { describe, test, expect } from 'vitest';
import { selectChain } from './select.js';
import { ADAPTERS } from './adapters.js';

const PINS = { codex: 'gpt-6.1-sol', agy: 'gemini-4-argon' };
const ALL = { reviewers: ['codex', 'claude', 'agy'] as ('codex' | 'claude' | 'agy')[], models: PINS };

describe('selectChain — explicit --reviewer', () => {
  test('a reviewer of another family with its pinned model is a chain of one', () => {
    expect(selectChain({ author: 'claude', reviewer: 'codex', config: ALL })).toEqual({ ok: true, chain: [{ id: 'codex', model: 'gpt-6.1-sol' }] });
  });
  test('--model overrides the pin', () => {
    expect(selectChain({ author: 'claude', reviewer: 'codex', model: 'gpt-5.5', config: ALL })).toEqual({ ok: true, chain: [{ id: 'codex', model: 'gpt-5.5' }] });
  });
  test('no pin and no --model: the CLI default, no model in the entry', () => {
    expect(selectChain({ author: 'codex', reviewer: 'claude', config: ALL })).toEqual({ ok: true, chain: [{ id: 'claude' }] });
  });
  test('the same family as the author is refused', () => {
    expect(selectChain({ author: 'claude', reviewer: 'claude', config: ALL })).toEqual({
      ok: false, error: '--reviewer claude: same family as the author (anthropic)',
    });
  });
  test('the same family is refused even with a model of another family: the rule follows the author', () => {
    expect(selectChain({ author: 'agy', reviewer: 'agy', model: 'gemini-4-argon', config: ALL })).toEqual({
      ok: false, error: '--reviewer agy: same family as the author (google)',
    });
  });
  test('agy with a foreign --model is refused', () => {
    expect(selectChain({ author: 'claude', reviewer: 'agy', model: 'claude-opus-5-5', config: ALL })).toEqual({
      ok: false, error: '--reviewer agy: model "claude-opus-5-5" is not accepted (agy takes gemini-* only)',
    });
  });
  test('agy with a foreign model in the config is refused just like --model', () => {
    expect(selectChain({ author: 'claude', reviewer: 'agy', config: { ...ALL, models: { agy: 'claude-opus-5-5' } } })).toEqual({
      ok: false, error: '--reviewer agy: model "claude-opus-5-5" is not accepted (agy takes gemini-* only)',
    });
  });
  test('--model gemini-* rescues agy from a foreign pin', () => {
    expect(selectChain({ author: 'claude', reviewer: 'agy', model: 'gemini-4-argon-high', config: { ...ALL, models: { agy: 'claude-opus-5-5' } } })).toEqual({
      ok: true, chain: [{ id: 'agy', model: 'gemini-4-argon-high' }],
    });
  });
  test('agy without any explicit model is refused', () => {
    expect(selectChain({ author: 'codex', reviewer: 'agy', config: { ...ALL, models: {} } })).toEqual({
      ok: false, error: '--reviewer agy: no explicit model: its CLI default is unknown, so its family cannot be proved',
    });
  });
  test('an explicit reviewer need not be in the reviewers list', () => {
    expect(selectChain({ author: 'claude', reviewer: 'agy', config: { reviewers: [], models: PINS } })).toEqual({
      ok: true, chain: [{ id: 'agy', model: 'gemini-4-argon' }],
    });
  });
  test('an explicit experimental reviewer is allowed: only automatic selection skips it', () => {
    const adapters = { ...ADAPTERS, codex: { ...ADAPTERS.codex, status: 'experimental' as const } };
    expect(selectChain({ author: 'claude', reviewer: 'codex', config: ALL, adapters })).toEqual({ ok: true, chain: [{ id: 'codex', model: 'gpt-6.1-sol' }] });
  });
});

describe('selectChain — the chain from the config', () => {
  test('claude author: codex then agy, claude left out', () => {
    expect(selectChain({ author: 'claude', config: ALL })).toEqual({
      ok: true, chain: [{ id: 'codex', model: 'gpt-6.1-sol' }, { id: 'agy', model: 'gemini-4-argon' }],
    });
  });
  test('codex author: claude on its CLI default, then agy', () => {
    expect(selectChain({ author: 'codex', config: ALL })).toEqual({
      ok: true, chain: [{ id: 'claude' }, { id: 'agy', model: 'gemini-4-argon' }],
    });
  });
  test('agy author: codex then claude', () => {
    expect(selectChain({ author: 'agy', config: ALL })).toEqual({
      ok: true, chain: [{ id: 'codex', model: 'gpt-6.1-sol' }, { id: 'claude' }],
    });
  });
  test('the config order is the chain order', () => {
    expect(selectChain({ author: 'claude', config: { reviewers: ['agy', 'codex'], models: PINS } })).toEqual({
      ok: true, chain: [{ id: 'agy', model: 'gemini-4-argon' }, { id: 'codex', model: 'gpt-6.1-sol' }],
    });
  });
  test('duplicates count once, at their first position', () => {
    expect(selectChain({ author: 'claude', config: { reviewers: ['agy', 'codex', 'agy', 'codex'], models: PINS } })).toEqual({
      ok: true, chain: [{ id: 'agy', model: 'gemini-4-argon' }, { id: 'codex', model: 'gpt-6.1-sol' }],
    });
  });
  test('a foreign agy pin leaves agy out without an error while others remain', () => {
    expect(selectChain({ author: 'claude', config: { ...ALL, models: { codex: 'gpt-6.1-sol', agy: 'claude-opus-5-5' } } })).toEqual({
      ok: true, chain: [{ id: 'codex', model: 'gpt-6.1-sol' }],
    });
  });
  test('agy without a pin is left out while others remain', () => {
    expect(selectChain({ author: 'codex', config: { ...ALL, models: {} } })).toEqual({ ok: true, chain: [{ id: 'claude' }] });
  });
  test('an experimental reviewer is left out of the chain', () => {
    const adapters = { ...ADAPTERS, codex: { ...ADAPTERS.codex, status: 'experimental' as const } };
    expect(selectChain({ author: 'claude', config: ALL, adapters })).toEqual({ ok: true, chain: [{ id: 'agy', model: 'gemini-4-argon' }] });
  });
  test('a single eligible reviewer is a chain of one', () => {
    expect(selectChain({ author: 'claude', config: { reviewers: ['codex'], models: {} } })).toEqual({ ok: true, chain: [{ id: 'codex' }] });
  });
  test('--model without --reviewer is refused here too', () => {
    expect(selectChain({ author: 'claude', model: 'gpt-6.1-sol', config: ALL })).toEqual({
      ok: false, error: '--model needs --reviewer: a model id belongs to one reviewer CLI',
    });
  });
});

describe('selectChain — empty chain', () => {
  test('an empty reviewers list is an error that says so', () => {
    expect(selectChain({ author: 'claude', config: { reviewers: [], models: PINS } })).toEqual({
      ok: false, error: 'no eligible reviewer for author claude: "reviewers" in detent.json is empty',
    });
  });
  test('only the same family: the reason names the family', () => {
    expect(selectChain({ author: 'claude', config: { reviewers: ['claude'], models: PINS } })).toEqual({
      ok: false, error: 'no eligible reviewer for author claude: claude — same family as the author (anthropic)',
    });
  });
  test('every exclusion is listed once, in config order, duplicates included once', () => {
    expect(selectChain({
      author: 'claude',
      config: { reviewers: ['claude', 'agy', 'claude'], models: { agy: 'claude-opus-5-5' } },
    })).toEqual({
      ok: false,
      error: 'no eligible reviewer for author claude: claude — same family as the author (anthropic); agy — model "claude-opus-5-5" is not accepted (agy takes gemini-* only)',
    });
  });
  test('agy without a model, the author family and experimental, each with its reason', () => {
    const adapters = { ...ADAPTERS, codex: { ...ADAPTERS.codex, status: 'experimental' as const } };
    expect(selectChain({ author: 'claude', config: { reviewers: ['codex', 'claude', 'agy'], models: {} }, adapters })).toEqual({
      ok: false,
      error: 'no eligible reviewer for author claude: codex — experimental; claude — same family as the author (anthropic); agy — no explicit model: its CLI default is unknown, so its family cannot be proved',
    });
  });
  test('the family reason comes before the experimental one', () => {
    const adapters = { ...ADAPTERS, claude: { ...ADAPTERS.claude, status: 'experimental' as const } };
    expect(selectChain({ author: 'claude', config: { reviewers: ['claude'], models: {} }, adapters })).toEqual({
      ok: false, error: 'no eligible reviewer for author claude: claude — same family as the author (anthropic)',
    });
  });
  test('a model refused by a non-agy adapter gets the generic reason', () => {
    const adapters = { ...ADAPTERS, codex: { ...ADAPTERS.codex, acceptsModel: () => false } };
    expect(selectChain({ author: 'claude', config: { reviewers: ['codex'], models: { codex: 'o9' } }, adapters })).toEqual({
      ok: false, error: 'no eligible reviewer for author claude: codex — model "o9" is not accepted',
    });
  });
});
