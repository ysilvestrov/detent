import { describe, test, expect } from 'vitest';
import {
  AGENTS_AUTHOR_LINE, BLOCK_BEGIN, BLOCK_END, DEV_CYCLE_LINE,
  appendBlock, blockInner, findBlock, renderBlock, replaceAuthorLine, replaceBlock,
} from './blocks.js';

const B = '<!-- detent:constitution v1 begin — edit outside these markers; `npx detent install` rewrites this block -->';
const E = '<!-- detent:constitution end -->';

describe('marker and line texts', () => {
  test('the begin marker is the spec line', () => {
    expect(BLOCK_BEGIN).toBe(B);
  });
  test('the end marker is the spec line', () => {
    expect(BLOCK_END).toBe(E);
  });
  test('the dev-cycle line is the spec line', () => {
    expect(DEV_CYCLE_LINE).toBe('Without Superpowers, start any behaviour change with `detent-dev-cycle`');
  });
  test('the .agents/ author line', () => {
    expect(AGENTS_AUTHOR_LINE).toBe(
      'You are Codex or Antigravity: pass --author codex in Codex and --author agy in Antigravity on a Gemini model; if Antigravity runs you on a Claude model, pass --author claude, because the rule is about the model family that wrote the work.',
    );
  });
});

describe('findBlock', () => {
  test('an empty text has no block', () => {
    expect(findBlock('')).toEqual({ kind: 'none' });
  });
  test('a text without markers has no block', () => {
    expect(findBlock('# Project\n\nnotes\n')).toEqual({ kind: 'none' });
  });
  test('one pair: offsets cover both marker lines, inner is between them', () => {
    const text = `top\n${B}\ninside\n${E}\nbottom\n`;
    expect(findBlock(text)).toEqual({ kind: 'one', start: 4, end: 4 + B.length + 1 + 7 + E.length + 1, inner: 'inside\n' });
  });
  test('CRLF lines: the markers are found and the inner keeps its CRLF', () => {
    const text = `${B}\r\na\r\n${E}\r\n`;
    expect(findBlock(text)).toEqual({ kind: 'one', start: 0, end: text.length, inner: 'a\r\n' });
  });
  test('an end marker on the last line without a newline', () => {
    const text = `${B}\na\n${E}`;
    expect(findBlock(text)).toEqual({ kind: 'one', start: 0, end: text.length, inner: 'a\n' });
  });
  test('an empty block', () => {
    expect(findBlock(`${B}\n${E}\n`)).toEqual({ kind: 'one', start: 0, end: B.length + E.length + 2, inner: '' });
  });
  test('a begin marker of another version is recognised', () => {
    const text = `<!-- detent:constitution v2 begin — anything -->\nx\n${E}\n`;
    expect(findBlock(text)).toEqual({ kind: 'one', start: 0, end: text.length, inner: 'x\n' });
  });
  test('a marker quoted inside a line is not a marker', () => {
    expect(findBlock(`see \`${B}\` and \`${E}\`\n`)).toEqual({ kind: 'none' });
  });
  test('only a begin marker', () => {
    expect(findBlock(`${B}\ntext\n`)).toEqual({ kind: 'broken', reason: 'a begin marker without an end marker' });
  });
  test('only an end marker', () => {
    expect(findBlock(`text\n${E}\n`)).toEqual({ kind: 'broken', reason: 'an end marker without a begin marker' });
  });
  test('end before begin', () => {
    expect(findBlock(`${E}\n${B}\n`)).toEqual({ kind: 'broken', reason: 'the end marker comes before the begin marker' });
  });
  test('two pairs', () => {
    expect(findBlock(`${B}\n${E}\n${B}\n${E}\n`)).toEqual({ kind: 'broken', reason: '2 begin and 2 end markers: expected one pair' });
  });
  test('two begins and one end', () => {
    expect(findBlock(`${B}\n${B}\n${E}\n`)).toEqual({ kind: 'broken', reason: '2 begin and 1 end markers: expected one pair' });
  });
});

describe('blockInner and renderBlock', () => {
  test('without the dev-cycle line: the constitution with one final newline', () => {
    expect(blockInner('## Rules\n\n1. One.\n\n\n', false)).toBe('## Rules\n\n1. One.\n');
  });
  test('with the dev-cycle line: last, as its own paragraph', () => {
    expect(blockInner('## Rules\n\n1. One.', true)).toBe(`## Rules\n\n1. One.\n\n${DEV_CYCLE_LINE}\n`);
  });
  test('a CRLF constitution comes out LF', () => {
    expect(blockInner('a\r\nb\r\n', false)).toBe('a\nb\n');
  });
  test('the block wraps the inner text in the markers', () => {
    expect(renderBlock('x\n')).toBe(`${B}\nx\n${E}\n`);
  });
});

describe('replaceBlock', () => {
  test('only the block changes; CRLF text outside stays byte for byte', () => {
    const text = `top\r\n${B}\r\nold\r\n${E}\r\nbottom\r\n`;
    expect(replaceBlock(text, { start: 5, end: text.length - 8 }, `${B}\nnew\n${E}\n`)).toBe(`top\r\n${B}\nnew\n${E}\nbottom\r\n`);
  });
});

describe('appendBlock', () => {
  const block = `${B}\nx\n${E}\n`;
  test('an empty file gets the block alone', () => {
    expect(appendBlock('', block)).toBe(block);
  });
  test('a file without a final newline gets a newline and a blank line', () => {
    expect(appendBlock('# P', block)).toBe(`# P\n\n${block}`);
  });
  test('a file ending with one newline gets a blank line', () => {
    expect(appendBlock('# P\n', block)).toBe(`# P\n\n${block}`);
  });
  test('a file already ending with a blank line gets nothing more', () => {
    expect(appendBlock('# P\n\n', block)).toBe(`# P\n\n${block}`);
  });
  test('a CRLF file ending with a blank line gets nothing more', () => {
    expect(appendBlock('# P\r\n\r\n', block)).toBe(`# P\r\n\r\n${block}`);
  });
  test('a CRLF file ending with one newline gets a blank line', () => {
    expect(appendBlock('# P\r\n', block)).toBe(`# P\r\n\n${block}`);
  });
});

describe('replaceAuthorLine', () => {
  const skill = '# x\n<!-- detent:author begin -->\nYou are Claude: pass --author claude.\n<!-- detent:author end -->\nend\n';
  test('replaces the inner line', () => {
    expect(replaceAuthorLine(skill, 'NEW')).toBe('# x\n<!-- detent:author begin -->\nNEW\n<!-- detent:author end -->\nend\n');
  });
  test('an empty pair gets the line', () => {
    expect(replaceAuthorLine('<!-- detent:author begin --><!-- detent:author end -->', 'NEW')).toBe(
      '<!-- detent:author begin -->\nNEW\n<!-- detent:author end -->',
    );
  });
  test('a text without the markers is returned as is', () => {
    expect(replaceAuthorLine('plain\n', 'NEW')).toBe('plain\n');
  });
  test('only a begin marker throws', () => {
    expect(() => replaceAuthorLine('<!-- detent:author begin -->\nx\n', 'NEW')).toThrow('detent:author markers must form exactly one pair');
  });
  test('two pairs throw', () => {
    expect(() => replaceAuthorLine(skill + skill, 'NEW')).toThrow('detent:author markers must form exactly one pair');
  });
  test('end before begin throws', () => {
    expect(() => replaceAuthorLine('<!-- detent:author end -->\n<!-- detent:author begin -->\n', 'NEW')).toThrow(
      'detent:author markers must form exactly one pair',
    );
  });
});
