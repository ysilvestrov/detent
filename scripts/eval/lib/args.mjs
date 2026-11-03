// The command line of funnel.mjs, parsed and checked before anything is read or spent.
import { join } from 'node:path';

const ROUTES = ['openai', 'anthropic', 'openrouter'];

const fail = (message) => {
  throw new Error(message);
};

function parseJudges(text) {
  return text.split(',').map((pair) => {
    const cut = pair.lastIndexOf(':');
    const judge = { model: pair.slice(0, cut), route: pair.slice(cut + 1) };
    return cut > 0 && ROUTES.includes(judge.route) ? judge : fail('--judges needs model:route pairs, route one of openai|anthropic|openrouter');
  });
}

/** Parses the arguments into one command; an `Error` carries the text for a usage failure (exit 2). */
export function parseArgs(argv, home) {
  const flags = new Set(['--preflight', '--endpoints', '--allow-dirty']);
  const withValue = ['--keys', '--batch', '--ceiling', '--labels', '--verify-model', '--verify-route', '--judges', '--repo', '--note-spend', '--reason'];
  const values = {};
  const on = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) on.add(arg);
    else if (withValue.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      values[arg] = value;
      i++;
    } else fail(`unrecognised option: ${arg}`);
  }
  const repo = values['--repo'] ?? join(home, 'projects', 'warsaw-beer-bot');
  const labels = values['--labels']?.split(',').filter(Boolean);

  if (on.has('--preflight')) return { command: 'preflight', repo };
  if (on.has('--endpoints')) return { command: 'endpoints', labels };
  if (values['--note-spend'] !== undefined) {
    const usd = Number(values['--note-spend']);
    if (!Number.isFinite(usd) || usd < 0) fail('--note-spend needs a number of dollars, zero or more');
    if (values['--reason'] === undefined) fail('--note-spend needs --reason');
    return { command: 'note-spend', usd, reason: values['--reason'] };
  }
  if (values['--batch'] === undefined) fail('nothing to do: pass --batch, --preflight, --endpoints or --note-spend');
  const batch = Number(values['--batch']);
  if (!Number.isInteger(batch)) fail('--batch needs a number');
  if (values['--keys'] === undefined) fail('--keys is required');
  const ceilingUsd = Number(values['--ceiling']);
  if (!(ceilingUsd > 0)) fail('--ceiling needs a positive number');
  return {
    command: 'batch',
    keys: values['--keys'],
    batch,
    ceilingUsd,
    labels,
    verifyModel: values['--verify-model'],
    verifyRoute: values['--verify-route'],
    judges: values['--judges'] === undefined ? undefined : parseJudges(values['--judges']),
    repo,
    allowDirty: on.has('--allow-dirty'),
  };
}
