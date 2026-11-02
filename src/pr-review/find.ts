import { callStructured, type OpenAiDeps } from './openai.js';
import type { RawFinding } from './types.js';
import type { Usage } from './usage.js';
import { isFindings } from './validate.js';

export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'start_line',
          'end_line',
          'quote',
          'claim',
          'why_it_breaks',
          'severity',
          'confidence',
        ],
        properties: {
          file: { type: 'string', description: 'repo-relative path, exactly as shown' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          quote: {
            type: 'string',
            description: 'verbatim copy of the offending code, exactly as it appears',
          },
          claim: { type: 'string', description: 'one sentence: what is wrong' },
          why_it_breaks: {
            type: 'string',
            description: 'concrete failure path: input or state -> wrong result',
          },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

export async function runFind(
  deps: OpenAiDeps,
  p: { instructions: string; context: string; prTitle: string; prBody: string },
): Promise<{ findings: RawFinding[]; usage: Usage }> {
  const user = [
    '# Pull request',
    `Title: ${p.prTitle}`,
    '',
    '## Body',
    p.prBody || '(no description)',
    '',
    p.context,
  ].join('\n');

  const { content: raw, usage } = await callStructured(
    deps,
    [
      { role: 'system', content: p.instructions },
      { role: 'user', content: user },
    ],
    { name: 'review_findings', schema: FINDINGS_SCHEMA },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // No raw text and no parser message (V8 quotes the input): this reaches the public failure comment.
    throw new Error('Pass-1 output could not be parsed as JSON');
  }

  if (!isFindings(parsed)) {
    throw new Error('Pass-1 output did not match the schema');
  }
  // Only the known fields, as zod.object returned them: a stray key from the model stays out.
  const findings: RawFinding[] = parsed.findings.map((f) => ({
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    quote: f.quote,
    claim: f.claim,
    why_it_breaks: f.why_it_breaks,
    severity: f.severity,
    confidence: f.confidence,
  }));
  return { findings, usage };
}
