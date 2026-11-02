// Reviewer adapters: how each CLI is told to review read-only, and how it reports a fatal error
// (spec, «Адаптер рецензента»). Pure: the runner spawns what `command` and `canary` return.
import { join } from 'node:path';
import { runArtifacts } from './preflight.js';

export type ReviewerId = 'claude' | 'codex' | 'agy';
export type Family = 'anthropic' | 'openai' | 'google';

export const REVIEWER_IDS: readonly ReviewerId[] = ['claude', 'codex', 'agy'];

export function isReviewerId(s: string): s is ReviewerId {
  return (REVIEWER_IDS as readonly string[]).includes(s);
}

export interface ReviewerCommand { cmd: string; args: string[]; report: 'stdout' | 'file' }
export interface CanaryCommand { cmd: string; args: string[]; mustNotExist: string }

export interface ReviewerAdapter {
  id: ReviewerId;
  family: Family; // for the rule «reviewer ≠ author»
  status: 'stable' | 'experimental'; // experimental is never chosen automatically
  readOnlyBy: 'sandbox' | 'toolset' | 'deny-rule';
  acceptsModel(model: string): boolean;
  command(p: { model?: string; prompt: string; reportPath: string; runDir: string }): ReviewerCommand;
  canary?(p: { runDir: string; model: string }): CanaryCommand;
  errorLine: { stream: 'stdout' | 'stderr'; prefix: string; which: 'first' | 'last' };
}

// The session deny rule is what keeps agy read-only (probe П-А-S); the canary proves it holds.
const AGY_SETTINGS = '{"permissions":{"deny":["write_file(*)"]}}';

// Every agy flag goes before -p: -p takes the very next argument as its prompt (probe П-А3).
// --add-dir lets it read the diff, which lies outside the snapshot (issue #6, probe П-2).
function agyArgs(model: string, runDir: string, prompt: string): string[] {
  return ['--settings', AGY_SETTINGS, '--sandbox', '--model', model, '--output-format', 'text', '--add-dir', runDir, '-p', prompt];
}

// In headless mode a denied shell command or read ends agy's turn with an empty answer: exit 0, no
// report (probes П-1, П-3). Telling it first keeps read-only as it is, with no allow rule. The
// canary does not get this: it must reach write_file.
function agyReviewPreamble(runDir: string): string {
  return `You have no shell in this session: a shell command is denied. The repository is ${runArtifacts(runDir).snapshot}, your current directory. `
    + 'Read files with read_file and absolute paths only, inside that folder or the diff file named below if there is one. '
    + 'Any other read is denied too, and a denied action ends your run with no report. '
    + 'If a file named below does not exist, say so in one line and go on; never stop without the report.\n\n';
}

const codex: ReviewerAdapter = {
  id: 'codex',
  family: 'openai',
  status: 'stable',
  readOnlyBy: 'sandbox',
  acceptsModel: () => true, // a foreign model is refused by codex itself: a reviewer failure (П-В3)
  command: (p) => ({
    cmd: 'codex',
    args: ['exec', '-s', 'read-only', '--ephemeral', '-o', p.reportPath, ...(p.model ? ['-m', p.model] : []), p.prompt],
    report: 'file',
  }),
  errorLine: { stream: 'stderr', prefix: 'ERROR:', which: 'last' },
};

const claude: ReviewerAdapter = {
  id: 'claude',
  family: 'anthropic',
  status: 'stable',
  readOnlyBy: 'toolset',
  acceptsModel: () => true,
  command: (p) => ({
    cmd: 'claude',
    args: ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', p.runDir,
      ...(p.model ? ['--model', p.model] : []), '--', p.prompt],
    report: 'stdout',
  }),
  errorLine: { stream: 'stdout', prefix: 'API Error:', which: 'last' },
};

const agy: ReviewerAdapter = {
  id: 'agy',
  family: 'google',
  status: 'stable',
  readOnlyBy: 'deny-rule',
  acceptsModel: (model) => model.startsWith('gemini-'),
  command: (p) => {
    // Selection never lets this happen: without an explicit model agy's family cannot be proved.
    if (!p.model) throw new Error('agy needs an explicit model: its CLI default is unknown, so its family cannot be proved');
    return { cmd: 'agy', args: agyArgs(p.model, p.runDir, agyReviewPreamble(p.runDir) + p.prompt), report: 'stdout' };
  },
  canary: (p) => {
    const target = join(p.runDir, 'canary');
    const prompt = `Use the write_file tool to create the file ${target} containing the word canary. Do nothing else.`;
    return { cmd: 'agy', args: agyArgs(p.model, p.runDir, prompt), mustNotExist: target };
  },
  // The first line: after its error agy prints the list of available models (probe П-Б2).
  errorLine: { stream: 'stderr', prefix: 'error:', which: 'first' },
};

export const ADAPTERS: Readonly<Record<ReviewerId, ReviewerAdapter>> = { claude, codex, agy };

// The author's family comes from --author: the rule is about the model that wrote, not the CLI.
export function familyOfAuthor(author: ReviewerId): Family {
  return ADAPTERS[author].family;
}

// The adapter's fatal-error line: the first or last non-empty line of its stream, only if it
// starts with the adapter's prefix, so text quoted mid-transcript is never the diagnosis.
export function errorLineOf(adapter: Pick<ReviewerAdapter, 'errorLine'>, stdout: string, stderr: string): string | null {
  const { stream, prefix, which } = adapter.errorLine;
  const lines = (stream === 'stdout' ? stdout : stderr)
    .split(/\r\n|\r|\n/) // a bare \r ends a progress line
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const line = which === 'first' ? lines[0] : lines[lines.length - 1];
  return line !== undefined && line.startsWith(prefix) ? line : null;
}
