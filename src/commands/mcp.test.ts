import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { mcp } from './mcp.js';

describe('detent mcp command', () => {
  test('help and invalid arguments return before package or registration I/O', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const out: string[] = [];
    const errors: string[] = [];
    output.on('data', (chunk) => out.push(chunk.toString()));
    expect(await mcp(['--help'], { cwd: process.cwd(), input, output, err: (line) => errors.push(line) })).toBe(0);
    expect(await mcp(['--registration', 'relative.json'], { cwd: process.cwd(), input, output, err: (line) => errors.push(line) })).toBe(2);
    expect(out.join('')).toContain('Usage: detent mcp');
    expect(errors).toHaveLength(1);
  });
});
