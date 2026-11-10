import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const scenarioPath = process.argv[2];
assert(scenarioPath && process.argv.length === 3, 'usage: node scripts/smoke-mcp-live.mjs <scenario.json>');
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
assert(process.platform === 'win32', 'live MCP smoke requires Windows for the installed Claude adapter and owned-process cleanup');
const modes = Object.hasOwn(scenario, 'modes') ? scenario.modes : ['spec', 'code'];
assert(Array.isArray(modes) && modes.length >= 1 && modes.length <= 2 && modes.every((mode) => mode === 'spec' || mode === 'code') && new Set(modes).size === modes.length, 'modes must be a nonempty, unique subset of [spec, code]');
const required = ['packageRoot', 'repoRoot', 'mainRoot', 'gitCommonDir', 'gitExecutable', 'claudeExecutable', 'head', 'outputDir', ...(modes.includes('spec') ? ['spec'] : []), ...(modes.includes('code') ? ['base'] : [])];
for (const key of required) assert(typeof scenario[key] === 'string' && scenario[key].length, `scenario requires ${key}`);
for (const key of ['packageRoot', 'repoRoot', 'mainRoot', 'gitCommonDir', 'gitExecutable', 'claudeExecutable', 'outputDir']) assert(isAbsolute(scenario[key]), `scenario ${key} must be absolute`);
assert(Array.isArray(scenario.contextPaths) && scenario.contextPaths.every((p) => typeof p === 'string'), 'contextPaths must be an array of repository paths');

const { contract: identity } = (await import(pathToFileURL(join(scenario.packageRoot, 'dist/runtime/contract.js')))).snapshotPackage(scenario.packageRoot);
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
for (const root of [scenario.repoRoot, scenario.mainRoot]) assert(!inside(root, tmpdir()), 'os.tmpdir must be outside the registered worktrees');
const assertions = [];
const results = {};
await mkdir(scenario.outputDir, { recursive: true });
const evidencePath = join(scenario.outputDir, 'live-mcp-evidence.json');
const evidence = { status: 'running', requestedModes: [...modes], createdAt: new Date().toISOString(), installedPackage: { root: scenario.packageRoot, version: identity.version, digest: identity.digest }, sourceCommit: scenario.head, assertions, results };
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const safeToolResult = (result) => ({
  isError: result?.isError === true,
  structuredContent: result?.structuredContent,
  content: Array.isArray(result?.content) ? result.content.map((item) => item?.type === 'text' ? { type: 'text', text: item.text } : { type: item?.type ?? 'unknown' }) : [],
});
let phase = 'initialize', activeCall;
await persist();
const tempRoot = await mkdtemp(join(tmpdir(), 'detent-mcp-live-'));
const roots = [...new Set([scenario.mainRoot, scenario.repoRoot])];
const registration = {
  schemaVersion: 1, projectId: 'detent-mcp-live', revision: 1, enabled: true,
  mainRoot: scenario.mainRoot, gitCommonDir: scenario.gitCommonDir, gitExecutable: scenario.gitExecutable,
  capabilities: [{ version: identity.version, digest: identity.digest, reviewers: [{ id: 'claude', executable: scenario.claudeExecutable, model: 'claude-haiku-5-5' }] }],
  worktrees: roots.map((root) => ({ root, configPath: join(root, '.codex', 'config.toml'), version: identity.version, digest: identity.digest, state: root === scenario.repoRoot ? 'active' : 'pending' })),
};
const registrationPath = join(tempRoot, 'registration.json');
await writeFile(registrationPath, JSON.stringify(registration));

const env = { ...process.env };
for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) delete env[key];
const child = spawn(process.execPath, [join(scenario.packageRoot, 'dist/cli.js'), 'mcp', '--registration', registrationPath], {
  cwd: scenario.repoRoot, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', lines = '', closed = false, exitInfo;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdin.on('error', (error) => failRun(error, true));
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { failRun(new Error('stdout exceeded 4 MiB')); return; }
  lines += chunk;
  let end;
  while ((end = lines.indexOf('\n')) >= 0) {
    const line = lines.slice(0, end); lines = lines.slice(end + 1);
    if (!line) { failRun(new Error('empty stdout line')); return; }
    let message;
    try { message = JSON.parse(line); } catch { failRun(new Error('stdout contained non-JSON data')); return; }
    if (message.jsonrpc !== '2.0') { failRun(new Error('stdout contained a non-JSON-RPC 2.0 message')); return; }
    if (message.id !== undefined && pending.has(message.id)) { const waiter = pending.get(message.id); pending.delete(message.id); waiter.resolve(message); }
    else if (message.id !== undefined && message.method === undefined) failRun(new Error('unsolicited JSON-RPC response'));
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 64 * 1024) failRun(new Error('stderr exceeded 64 KiB')); });
child.on('error', (error) => failRun(error));
child.on('close', (code, signal) => { closed = true; exitInfo = { code, signal }; if (pending.size || !child.stdin.writableEnded) failRun(new Error(`child exited before normal shutdown: ${code ?? signal}`)); });
let activeId;
let runFailure;
function failRun(error, stdinBroken = false) { const firstFailure = runFailure === undefined; runFailure ??= error; if (firstFailure && !stdinBroken && !closed && activeId !== undefined && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: activeId, reason: 'harness failure' } })}\n`); if (!stdinBroken && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(runFailure); } pending.clear(); }
function checkRun() { if (runFailure !== undefined) throw runFailure; }
function response(id, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out waiting for response ${id}`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject, timer });
  });
}
function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
async function request(id, method, params, timeout) {
  checkRun();
  activeId = id;
  const waiting = response(id, timeout);
  send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const result = await waiting; activeId = undefined;
  checkRun();
  if (result.error) fail(`${method} returned JSON-RPC error: ${result.error.message}`);
  return result.result;
}
const callTimeout = 930_000;
try {
  checkRun();
  const initialized = await request(0, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'detent-live-smoke', version: '1' } });
  assert(initialized.protocolVersion === '2024-11-05', 'unexpected MCP protocol version'); assertions.push('initialize protocol 2024-11-05'); await persist();
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  phase = 'tools/list';
  const listed = await request(1, 'tools/list');
  assert(listed.tools?.length === 1 && listed.tools[0].name === 'cross_review', 'tools/list did not return exactly cross_review'); assertions.push('tools/list exactly cross_review'); await persist();
  let callId = 2;
  for (const mode of modes) {
    phase = `${mode} review`; activeCall = mode;
    results[mode] = { status: 'running' }; await persist();
    const args = mode === 'spec'
      ? { author: 'codex', kind: 'spec', path: scenario.spec, revision: scenario.head, contextPaths: scenario.contextPaths }
      : { author: 'codex', kind: 'code', base: scenario.base, head: scenario.head, contextPaths: scenario.contextPaths };
    const result = await request(callId++, 'tools/call', { name: 'cross_review', arguments: args }, callTimeout);
    results[mode] = { status: 'received', toolResult: safeToolResult(result) }; await persist();
    checkRun();
    const expected = mode === 'spec'
      ? { author: 'codex', head: scenario.head, root: scenario.repoRoot, identity, markerPrefix: 'Spec-review:' }
      : { author: 'codex', head: scenario.head, base: scenario.base, root: scenario.repoRoot, identity, markerPrefix: 'Cross-review:' };
    const receipt = checkReceipt(result, expected);
    results[mode] = { status: 'completed', assertions: ['completed', 'claude/Anthropic haiku', 'no tools', 'effective root', mode === 'spec' ? 'head' : 'base/head', 'marker', 'legacy receipt provenance'], receipt, report: result.content[0].text };
    assertions.push(`${mode} review completed with matching provenance`);
    await persist();
    activeCall = undefined;
  }
  phase = 'shutdown';
  child.stdin.end();
  await waitForClose(10_000);
  checkRun();
  assert(exitInfo?.code === 0 && !stderr && !lines, `child exit/stderr invalid: ${JSON.stringify(exitInfo)} ${stderr}`);
  evidence.status = 'completed'; await persist();
  console.log(`live MCP acceptance: passed modes=${modes.join(',')}; evidence: ${evidencePath}`);
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = { phase, reason: error instanceof Error ? error.name : 'Error' };
  if (activeCall && results[activeCall]?.status === 'running') results[activeCall].status = 'failed-before-response';
  if (activeCall && results[activeCall]?.status === 'received') results[activeCall].status = 'failed-checks';
  try { await persist(); } catch { /* Preserve cleanup and the original failure if evidence storage also fails. */ }
  if (activeId !== undefined && !closed && !runFailure && !child.stdin.destroyed && child.stdin.writable) {
    try { send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: activeId, reason: 'harness failure' } }); } catch { /* Cleanup below still targets only the owned child. */ }
  }
  child.stdin.end();
  await waitForClose(5_000).catch(async () => {
    if (closed) return;
    if (process.platform === 'win32' && child.pid) {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error('cannot locate taskkill for owned-child cleanup');
      await new Promise((resolve, reject) => {
        const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); reject(new Error('taskkill timed out during owned-child cleanup')); }, 5_000);
        killer.once('error', (failure) => { clearTimeout(timer); reject(failure); });
        killer.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)); });
      });
      await waitForClose(5_000);
    }
  });
  throw runFailure ?? error;
}

function checkReceipt(result, expected) {
  assert(result?.isError !== true, `review returned error: ${result?.structuredContent?.reason ?? 'unknown'}`);
  const receipt = result?.structuredContent;
  assert(receipt?.status === 'completed', 'review did not complete');
  assert(receipt.authorDeclared === expected.author && receipt.reviewer?.id === 'claude' && receipt.reviewer?.family === 'anthropic' && /^claude-haiku-/.test(receipt.reviewer.model), 'reviewer provenance mismatch');
  assert(receipt.noTools?.tools?.length === 0 && receipt.noTools?.mcpServers?.length === 0 && receipt.noTools?.toolUseCount === 0, 'reviewer used tools or MCP servers');
  assert(receipt.effectiveRoot === expected.root && receipt.commits?.head === expected.head, 'effective root or requested head mismatch');
  assert(receipt.runtimeIdentity?.version === expected.identity.version && receipt.runtimeIdentity?.digest === expected.identity.digest, 'receipt runtime identity mismatch');
  if (expected.base !== undefined) assert(receipt.commits?.base === expected.base, 'code review base mismatch');
  assert(typeof receipt.marker === 'string' && receipt.marker.includes(expected.markerPrefix), 'receipt marker missing expected provenance');
  const legacy = result.content?.[1]?.text;
  const legacyReceipt = typeof legacy === 'string' ? JSON.parse(legacy) : undefined;
  assert(legacyReceipt?.status === 'completed' && legacyReceipt.inputSha256 === receipt.inputSha256 && legacyReceipt.marker === receipt.marker
    && legacyReceipt.authorDeclared === receipt.authorDeclared && legacyReceipt.reviewer?.id === receipt.reviewer?.id
    && legacyReceipt.reviewer?.model === receipt.reviewer?.model && legacyReceipt.effectiveRoot === receipt.effectiveRoot
    && legacyReceipt.commits?.head === receipt.commits?.head && legacyReceipt.commits?.base === receipt.commits?.base,
  'legacy receipt does not match structured provenance');
  return receipt;
}
function waitForClose(timeout) {
  if (closed) return Promise.resolve();
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('child did not exit')), timeout); child.once('close', () => { clearTimeout(timer); resolve(); }); });
}
