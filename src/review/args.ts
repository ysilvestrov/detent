// Arguments of `detent cross-review` (spec, «Інтерфейс»). The base is not defaulted here: without
// --base the command takes `baseBranch` from the config.
import { REVIEWER_IDS, isReviewerId, type ReviewerId } from './adapters.js';

export interface CrossReviewOptions {
  author: ReviewerId;
  reviewer?: ReviewerId;
  base?: string;
  spec?: string;
  model?: string;
}

const FLAGS = ['--author', '--reviewer', '--base', '--spec', '--model'];
const EXPECTED_IDS = REVIEWER_IDS.join('|');

export function parseCrossReviewArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; opts: CrossReviewOptions } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!FLAGS.includes(flag)) return { ok: false, error: `unknown argument "${flag}"` };
    const value = argv[i + 1];
    // An empty value is refused, so `--model "$UNSET"` can never silently drop a pin.
    if (value === undefined || value === '' || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    values[flag] = value;
    i++;
  }

  // The author cannot be detected from the environment (spec, premises): the flag, else DETENT_AUTHOR.
  const author = values['--author'] ?? (env.DETENT_AUTHOR || undefined);
  if (author === undefined) {
    return { ok: false, error: `--author ${EXPECTED_IDS} (or DETENT_AUTHOR) is required: the author cannot be detected` };
  }
  if (!isReviewerId(author)) return { ok: false, error: `unknown author "${author}" (expected ${EXPECTED_IDS})` };

  const reviewer = values['--reviewer'];
  if (reviewer !== undefined && !isReviewerId(reviewer)) {
    return { ok: false, error: `unknown reviewer "${reviewer}" (expected ${EXPECTED_IDS})` };
  }
  if (values['--spec'] !== undefined && values['--base'] !== undefined) {
    return { ok: false, error: '--spec and --base cannot be combined: a spec review has no base' };
  }
  if (values['--model'] !== undefined && reviewer === undefined) {
    return { ok: false, error: '--model needs --reviewer: a model id belongs to one reviewer CLI' };
  }

  const opts: CrossReviewOptions = { author };
  if (reviewer !== undefined) opts.reviewer = reviewer;
  if (values['--base'] !== undefined) opts.base = values['--base'];
  if (values['--spec'] !== undefined) opts.spec = values['--spec'];
  if (values['--model'] !== undefined) opts.model = values['--model'];
  return { ok: true, opts };
}
