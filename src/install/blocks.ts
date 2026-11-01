// The constitution block in CLAUDE.md / AGENTS.md and the author line of `detent-cross-review`
// (spec, «Шаблон конституції», «Установка»). Pure text in, text out.

export const BLOCK_BEGIN = '<!-- detent:constitution v1 begin — edit outside these markers; `npx detent install` rewrites this block -->';
export const BLOCK_END = '<!-- detent:constitution end -->';

// Added as the last line inside the block only for a target where Superpowers is not seen
// (spec, «Скіли» → `detent-dev-cycle`).
export const DEV_CYCLE_LINE = 'Without Superpowers, start any behaviour change with `detent-dev-cycle`';

export const AUTHOR_BEGIN = '<!-- detent:author begin -->';
export const AUTHOR_END = '<!-- detent:author end -->';

// The author line `.agents/` copies of `detent-cross-review` get (spec, «Установка»). The source
// in `skills/` carries the Claude line, because the Claude plugin reads `skills/` as is.
export const AGENTS_AUTHOR_LINE =
  'You are Codex or Antigravity: pass --author codex in Codex and --author agy in Antigravity on a Gemini model; if Antigravity runs you on a Claude model, pass --author claude, because the rule is about the model family that wrote the work.';

// Any version of the begin marker is recognised, so a later version can still replace a v1 block.
const BEGIN_RE = /^<!-- detent:constitution v\d+ begin\b.*-->$/;

export type FoundBlock =
  | { kind: 'none' }
  // `start`/`end`: the whole block, from the start of the begin line to past the end line's
  // terminator. `inner`: the text strictly between the two marker lines.
  | { kind: 'one'; start: number; end: number; inner: string }
  | { kind: 'broken'; reason: string };

interface Line { start: number; end: number; text: string }

// Lines with their offsets; `end` is past the line terminator, `text` has no \r or \n.
function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ start, end, text: text.slice(start, nl === -1 ? end : nl).replace(/\r$/, '') });
    start = end;
  }
  return out;
}

// A marker counts only as a line of its own (surrounding blanks allowed).
export function findBlock(text: string): FoundBlock {
  const all = lines(text);
  const begins = all.filter((l) => BEGIN_RE.test(l.text.trim()));
  const ends = all.filter((l) => l.text.trim() === BLOCK_END);
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' };
  if (begins.length === 1 && ends.length === 0) return { kind: 'broken', reason: 'a begin marker without an end marker' };
  if (begins.length === 0 && ends.length === 1) return { kind: 'broken', reason: 'an end marker without a begin marker' };
  if (begins.length !== 1 || ends.length !== 1) {
    return { kind: 'broken', reason: `${begins.length} begin and ${ends.length} end markers: expected one pair` };
  }
  const b = begins[0] as Line;
  const e = ends[0] as Line;
  if (e.start < b.start) return { kind: 'broken', reason: 'the end marker comes before the begin marker' };
  return { kind: 'one', start: b.start, end: e.end, inner: text.slice(b.end, e.start) };
}

const toLF = (text: string) => text.replace(/\r\n/g, '\n');

// The inner text of the block: the constitution, then the dev-cycle line as its own paragraph
// when asked for. LF, ends with exactly one newline.
export function blockInner(constitution: string, devCycleLine: boolean): string {
  const body = toLF(constitution).replace(/\s+$/, '') + '\n';
  return devCycleLine ? `${body}\n${DEV_CYCLE_LINE}\n` : body;
}

// The whole block, markers included, ending with a newline.
export function renderBlock(inner: string): string {
  return `${BLOCK_BEGIN}\n${inner}${BLOCK_END}\n`;
}

// Replaces the found block; every byte outside it stays as it was.
export function replaceBlock(text: string, found: { start: number; end: number }, block: string): string {
  return text.slice(0, found.start) + block + text.slice(found.end);
}

// Appends the block at the end, with a blank line before it unless the file already ends with
// one. An empty file gets the block alone.
export function appendBlock(text: string, block: string): string {
  if (text === '') return block;
  const lf = toLF(text);
  if (lf.endsWith('\n\n')) return text + block;
  if (lf.endsWith('\n')) return `${text}\n${block}`;
  return `${text}\n\n${block}`;
}

// Replaces what lies between the author markers with `line`. A text without the markers is
// returned as is; a broken pair is a defect of the shipped skill and throws.
export function replaceAuthorLine(text: string, line: string): string {
  const begins = text.split(AUTHOR_BEGIN).length - 1;
  const ends = text.split(AUTHOR_END).length - 1;
  if (begins === 0 && ends === 0) return text;
  const b = text.indexOf(AUTHOR_BEGIN);
  const e = text.indexOf(AUTHOR_END);
  if (begins !== 1 || ends !== 1 || e < b) throw new Error('detent:author markers must form exactly one pair');
  return `${text.slice(0, b)}${AUTHOR_BEGIN}\n${line}\n${text.slice(e)}`;
}
