import type { Readable, Writable } from 'node:stream';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readAdmission as readAdmissionDefault, type RuntimeIdentity } from './registration.js';
import { parseReviewRequest, prepareReview as prepareReviewDefault, type PreparedReview, type ReviewRequest } from './input.js';
import { ClaudeReportValidationError, IndeterminateProviderOutcomeError, runClaudeReview as runClaudeReviewDefault, type ClaudeReviewResult } from './claude.js';
import { ADAPTERS, familyOfAuthor } from '../review/adapters.js';
import { classifyResult, markerLine, successBody } from '../review/protocol.js';

export interface McpServerOptions {
  registrationPath: string;
  cwd: string;
  identity: RuntimeIdentity;
  neutralCwd: string;
  packageRoot?: string;
  input: Readable;
  output: Writable;
  err?: (message: string) => void;
}
export interface McpServerIO {
  readAdmission?: typeof readAdmissionDefault;
  prepareReview?: typeof prepareReviewDefault;
  runClaudeReview?: typeof runClaudeReviewDefault;
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = '2024-11-05';
const tool = {
  name: 'cross_review',
  description: 'Review committed spec or code text using the admitted text-only reviewer.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      author: { type: 'string', enum: ['codex', 'claude', 'agy'] },
      kind: { type: 'string', enum: ['spec', 'code'] },
      path: { type: 'string' }, revision: { type: 'string' },
      base: { type: 'string' }, head: { type: 'string' },
      contextPaths: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    }, required: ['author', 'kind'],
    allOf: [
      { if: { properties: { kind: { const: 'spec' } }, required: ['kind'] }, then: { required: ['path', 'revision'], not: { anyOf: [{ required: ['base'] }, { required: ['head'] }] } } },
      { if: { properties: { kind: { const: 'code' } }, required: ['kind'] }, then: { required: ['base', 'head'], not: { anyOf: [{ required: ['path'] }, { required: ['revision'] }] } } },
    ],
  },
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
const contains = (parent: string, target: string): boolean => {
  const child = relative(parent, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
async function canonicalStoredPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalStoredPath(parent), basename(path));
  }
}

export async function assertMcpDirectory(admission: Awaited<ReturnType<typeof readAdmissionDefault>>, path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be a canonical absolute directory`);
  const canonical = await realpath(path);
  if (pathKey(canonical) !== pathKey(path) || !(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a canonical directory`);
  const roots = await Promise.all(admission.registration.worktrees.map((worktree) => canonicalStoredPath(worktree.root)));
  const protectedRoots = [...roots, await realpath(admission.registration.gitCommonDir)];
  if (protectedRoots.some((root) => contains(root, canonical))) throw new Error(`${label} is inside a registered worktree or Git metadata`);
  return canonical;
}

export async function serveMcp(options: McpServerOptions, io: McpServerIO = {}): Promise<void> {
  const readAdmission = io.readAdmission ?? readAdmissionDefault;
  const prepareReview = io.prepareReview ?? prepareReviewDefault;
  const runReview = io.runClaudeReview ?? runClaudeReviewDefault;
  const startupAdmission = await readAdmission(options.registrationPath, options.cwd, options.identity);
  await assertMcpDirectory(startupAdmission, options.neutralCwd, 'neutral reviewer cwd');
  if (options.packageRoot) await assertMcpDirectory(startupAdmission, options.packageRoot, 'installed package root');
  let buffer = Buffer.alloc(0);
  let discardingOversize = false;
  let initialized = false;
  let ready = false;
  let closed = false;
  const active = new Map<string, AbortController>();
  const cancelled = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const send = (message: unknown): void => {
    if (!closed) options.output.write(`${JSON.stringify(message)}\n`);
  };
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    for (const controller of active.values()) controller.abort();
    options.input.destroy();
  };
  options.output.on('error', shutdown);
  options.output.on('close', shutdown);
  options.input.on('error', shutdown);
  options.input.on('close', shutdown);

  const handle = async (value: unknown): Promise<void> => {
    if (!record(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
      send({ jsonrpc: '2.0', id: record(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const hasId = Object.hasOwn(value, 'id');
    if (hasId && !(typeof value.id === 'string' || (typeof value.id === 'number' && Number.isFinite(value.id)))) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (!hasId) {
      if (value.method === 'notifications/initialized' && initialized) {
        ready = true;
      } else if (value.method === 'notifications/cancelled' && record(value.params)) {
        const requestId = value.params.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          const cancelledKey = `${typeof requestId}:${requestId}`;
          const pending = active.get(cancelledKey);
          if (pending) { cancelled.add(cancelledKey); pending.abort(); }
        }
      }
      return;
    }
    const id = value.id as string | number;
    const key = `${typeof id}:${id}`;
    if (active.has(key)) {
      send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Duplicate active request id' } });
      return;
    }
    if (value.method === 'initialize') {
      if (initialized) {
        send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Server is already initialized' } });
        return;
      }
      const params = record(value.params) ? value.params : {};
      const versions = params.protocolVersion;
      if (typeof versions !== 'string') {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'initialize requires protocolVersion' } });
        return;
      }
      initialized = true;
      send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'detent', version: options.identity.version } } });
      return;
    }
    if (value.method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (!ready) { send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'Server not initialized' } }); return; }
    if (value.method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: [tool] } }); return; }
    if (value.method !== 'tools/call') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    const controller = new AbortController();
    const deadline = Date.now() + 900_000;
    const deadlineTimer = setTimeout(() => controller.abort(), 900_000);
    active.set(key, controller);
    const job = (async () => {
      let stage: 'input' | 'admission' | 'eligibility' | 'prepare' | 'review' = 'input';
      try {
        if (!record(value.params) || value.params.name !== 'cross_review') throw new Error('unknown tool');
        const request: ReviewRequest = parseReviewRequest(value.params.arguments);
        stage = 'admission';
        const current = await readAdmission(options.registrationPath, options.cwd, options.identity, { signal: controller.signal, deadline });
        if (controller.signal.aborted) throw new Error('review cancelled or deadline expired during admission');
        await assertMcpDirectory(current, options.neutralCwd, 'neutral reviewer cwd');
        if (options.packageRoot) await assertMcpDirectory(current, options.packageRoot, 'installed package root');
        if (controller.signal.aborted) throw new Error('review cancelled or deadline expired during admission');
        const reviewer = current.capability.reviewers.find((item) => item.id === 'claude');
        if (!reviewer) throw new Error('no eligible text-only reviewer is admitted');
        if (familyOfAuthor(request.author) === ADAPTERS.claude.family) {
          stage = 'eligibility';
          throw new Error('no eligible reviewer from another model family');
        }
        stage = 'prepare';
        const prepared: PreparedReview = await prepareReview(current.root, current.gitExecutable, request, { signal: controller.signal, deadline });
        if (controller.signal.aborted) throw new Error('review cancelled or deadline expired during preparation');
        stage = 'review';
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) throw new Error('review deadline expired before reviewer start');
        const result: ClaudeReviewResult = await runReview({ reviewer, text: prepared.text, coverage: prepared.coverage, mode: prepared.mode, cwd: options.neutralCwd, signal: controller.signal, timeoutMs });
        if (controller.signal.aborted) throw new Error('review cancelled');
        const verdict = classifyResult(result.report);
        if (verdict.kind !== 'ok' || verdict.findings !== result.findings || result.tools.length !== 0 || result.mcpServers.length !== 0 || result.toolUseCount !== 0) throw new Error('reviewer returned an invalid or non-text-only result');
        const body = successBody({ reviewer: 'claude', model: result.model, sha7: prepared.commits.head.slice(0, 7), author: request.author, findings: result.findings, fallbacks: [] });
        const prefix = prepared.mode === 'spec' ? 'Spec marker: ' : 'PR marker: ';
        const marker = markerLine(prepared.mode, body).slice(prefix.length);
        const receipt = {
          status: 'completed', report: result.report, findings: result.findings, marker, authorDeclared: request.author,
          reviewer: { id: 'claude', model: result.model, family: ADAPTERS.claude.family }, commits: prepared.commits,
          coverage: prepared.coverage, inputSha256: prepared.inputSha256, effectiveRoot: current.root,
          projectId: current.registration.projectId, revision: current.registration.revision,
          runtimeIdentity: options.identity,
          noTools: { tools: result.tools, mcpServers: result.mcpServers, toolUseCount: result.toolUseCount },
        };
        if (!cancelled.has(key)) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.report }, { type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt } });
      } catch (error) {
        const reason = messageOf(error);
        const status = stage === 'admission' ? 'needs-action' : 'failed';
        if (!cancelled.has(key)) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: reason }], structuredContent: { status, reason, ...(error instanceof ClaudeReportValidationError ? { diagnostics: { mode: error.mode, expectedChecks: error.expectedChecks, untrustedReportTail: error.untrustedReportTail } } : {}), ...(error instanceof IndeterminateProviderOutcomeError ? { providerOutcome: error.providerOutcome } : {}) }, isError: true } });
      } finally {
        clearTimeout(deadlineTimer);
        active.delete(key);
        cancelled.delete(key);
      }
    })();
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };

  try {
    for await (const chunk of options.input) {
      if (closed) break;
      const bytes = Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        if (discardingOversize) {
          const newline = bytes.indexOf(0x0a, offset);
          if (newline < 0) break;
          discardingOversize = false;
          offset = newline + 1;
          continue;
        }
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const piece = bytes.subarray(offset, end);
        if (buffer.length + piece.length > MAX_MESSAGE_BYTES) {
          buffer = Buffer.alloc(0);
          send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP message exceeds 1 MiB' } });
          if (newline < 0) { discardingOversize = true; break; }
          offset = newline + 1;
          continue;
        }
        buffer = Buffer.concat([buffer, piece]);
        if (newline < 0) break;
        const line = buffer;
        buffer = Buffer.alloc(0);
        try { await handle(JSON.parse(line.toString('utf8')) as unknown); }
        catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        offset = newline + 1;
      }
    }
  } catch (error) {
    if (!closed) throw error;
  } finally {
    shutdown();
    await Promise.allSettled([...jobs]);
  }
}
