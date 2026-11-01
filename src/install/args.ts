// Arguments of `detent install` (spec, «Установка»). Without a target flag both targets are
// installed; `--superpowers yes|no` overrides detection for both.

export type Target = 'claude' | 'agents';

export const TARGETS: readonly Target[] = Object.freeze(['claude', 'agents']);

export interface InstallOptions {
  targets: Target[];
  dryRun: boolean;
  superpowers?: 'yes' | 'no';
}

export function parseInstallArgs(argv: readonly string[]): { ok: true; opts: InstallOptions } | { ok: false; error: string } {
  let claude = false;
  let agents = false;
  let dryRun = false;
  let superpowers: 'yes' | 'no' | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--claude') claude = true;
    else if (arg === '--agents') agents = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--superpowers') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return { ok: false, error: '--superpowers needs a value: yes|no' };
      if (value !== 'yes' && value !== 'no') return { ok: false, error: `unknown --superpowers value "${value}" (expected yes|no)` };
      superpowers = value;
      i++;
    } else return { ok: false, error: `unknown argument "${arg}"` };
  }
  // Targets come out in one fixed order, whatever the order of the flags.
  const targets = claude || agents ? TARGETS.filter((t) => (t === 'claude' ? claude : agents)) : [...TARGETS];
  const opts: InstallOptions = { targets, dryRun };
  if (superpowers !== undefined) opts.superpowers = superpowers;
  return { ok: true, opts };
}
