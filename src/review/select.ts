// Which reviewers run, in what order, with which model (spec, «Вибір рецензента», with the
// owner's clarification of 2026-11-01). A usage or config problem is an error here (exit 2);
// a reviewer that fails at run time is the chain's business, not this module's.
import type { Config } from '../config.js';
import { ADAPTERS, familyOfAuthor, type ReviewerAdapter, type ReviewerId } from './adapters.js';

export interface ChainEntry { id: ReviewerId; model?: string }

// Why a reviewer cannot review this author's work, or null when it can. `experimental` bars
// only automatic selection: an explicit --reviewer is the person's own choice.
function ineligible(adapter: ReviewerAdapter, author: ReviewerId, model: string | undefined, auto: boolean): string | null {
  const authorFamily = familyOfAuthor(author);
  if (adapter.family === authorFamily) return `same family as the author (${authorFamily})`;
  if (auto && adapter.status === 'experimental') return 'experimental';
  if (model !== undefined && !adapter.acceptsModel(model)) {
    return adapter.id === 'agy'
      ? `model "${model}" is not accepted (agy takes gemini-* only)`
      : `model "${model}" is not accepted`;
  }
  // agy's CLI default model is unknown, so without an explicit one its family cannot be proved.
  if (model === undefined && adapter.id === 'agy') {
    return 'no explicit model: its CLI default is unknown, so its family cannot be proved';
  }
  return null;
}

function entry(id: ReviewerId, model: string | undefined): ChainEntry {
  return model === undefined ? { id } : { id, model };
}

export function selectChain(p: {
  author: ReviewerId;
  reviewer?: ReviewerId;
  model?: string;
  config: Pick<Config, 'reviewers' | 'models'>;
  adapters?: Readonly<Record<ReviewerId, ReviewerAdapter>>;
}): { ok: true; chain: ChainEntry[] } | { ok: false; error: string } {
  const adapters = p.adapters ?? ADAPTERS;

  // An explicit reviewer is a chain of one: a person's explicit choice is never substituted.
  // The final model is --model, else models.<id> from the config, else the CLI default.
  if (p.reviewer !== undefined) {
    const model = p.model ?? p.config.models[p.reviewer];
    const why = ineligible(adapters[p.reviewer], p.author, model, false);
    if (why !== null) return { ok: false, error: `--reviewer ${p.reviewer}: ${why}` };
    return { ok: true, chain: [entry(p.reviewer, model)] };
  }
  if (p.model !== undefined) {
    return { ok: false, error: '--model needs --reviewer: a model id belongs to one reviewer CLI' };
  }

  // Without --reviewer an ineligible reviewer is left out with its reason; only an empty chain is an error.
  const chain: ChainEntry[] = [];
  const excluded: string[] = [];
  const seen = new Set<ReviewerId>();
  for (const id of p.config.reviewers) {
    if (seen.has(id)) continue; // a duplicate counts once, at its first position
    seen.add(id);
    const model = p.config.models[id];
    const why = ineligible(adapters[id], p.author, model, true);
    if (why === null) chain.push(entry(id, model));
    else excluded.push(`${id} — ${why}`);
  }
  if (chain.length > 0) return { ok: true, chain };
  const reasons = excluded.length > 0 ? excluded.join('; ') : '"reviewers" in detent.json is empty';
  return { ok: false, error: `no eligible reviewer for author ${p.author}: ${reasons}` };
}
