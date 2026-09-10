import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildPack, Library, loadPack, writePack } from '../../packages/synesis-mcp/dist/index.js';

// One public, pinned capability trial. No provider adapter, background service or model judge.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('./pack-trial.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { output: { type: 'string' }, 'filesystem-server': { type: 'string' } } });
if (!values.output || !values['filesystem-server'] || !isAbsolute(values['filesystem-server'])) {
  throw new Error('Usage: node evals/architecture/pack-trial.mjs --filesystem-server /absolute/install/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js --output /absolute/result.json');
}
const filesystemServer = realpathSync(values['filesystem-server']);
const alternative = JSON.parse(readFileSync(join(dirname(dirname(filesystemServer)), 'package.json'), 'utf8'));
assert.equal(alternative.name, '@modelcontextprotocol/server-filesystem');
assert.equal(alternative.version, '2026.8.31', 'This trial pins the alternative; review a new version explicitly');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'synesis-pack-trial-')));
const clients = [];
let library;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (program, args, cwd = root) => execFileSync(program, args, { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
const measure = work => { const start = performance.now(); const value = work(); return { value, ms: performance.now() - start }; };
const diskBytes = directory => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total +
  (entry.isDirectory() ? diskBytes(join(directory, entry.name)) : statSync(join(directory, entry.name)).size), 0);
async function connect(script, args, cwd, name) {
  const client = new Client({ name, version: '1.0.0' }); // No client roots capability: explicit server directories stay selected.
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [script, ...args], cwd, stderr: 'pipe' });
  const started = performance.now(); await client.connect(transport);
  transport.stderr?.resume();
  return { client, startupMs: performance.now() - started, tools: (await client.listTools()).tools };
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  assert(!result.isError, `${name} returned a tool error`);
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
async function source(client, selection, path) {
  let offset = 0; let text = ''; let calls = 0; let first;
  do {
    const part = JSON.parse(await call(client, 'knowledge_read', { ...selection, path, offset, length: 16000 }));
    first ??= part; text += part.text; offset = part.nextOffset; calls++;
  } while (offset !== null);
  assert.equal(hash(text), first.sha256);
  return { text, calls, citation: first.citation, digest: first.digest, sha256: first.sha256, sourceRevision: first.sourceRevision };
}
try {
  const revisions = fixture.revisions.map(revision => {
    assert.match(revision, /^[a-f0-9]{40}$/);
    assert.equal(command('git', ['rev-parse', `${revision}^{commit}`]).toString().trim(), revision);
    const snapshot = join(scratch, revision); mkdirSync(snapshot);
    // Archive only these known regular files from this repository; no untrusted archive input.
    for (const path of fixture.files) assert.match(command('git', ['ls-tree', revision, '--', path]).toString(), /^100644 blob /);
    const packed = measure(() => command('git', ['archive', '--format=tar.gz', revision, '--', ...fixture.files]));
    const archive = join(scratch, `${revision}.tar.gz`); writeFileSync(archive, packed.value, { mode: 0o600 });
    const unpacked = measure(() => command('tar', ['-xzf', archive, '-C', snapshot]));
    const built = measure(() => buildPack({ id: 'synesis-project', version: revision, title: 'Synesis project knowledge',
      sourceRevision: revision, attribution: 'Synesis contributors', license: 'Apache-2.0', redistribution: 'permitted', files: fixture.files }, snapshot));
    const artifact = join(scratch, `${revision}.synpack`);
    const encoded = measure(() => writePack(artifact, built.value));
    return { revision, snapshot, artifact, digest: built.value.digest, sourceBytes: diskBytes(snapshot),
      gitArchiveBytes: packed.value.length, gitArchiveBuildMs: packed.ms, gitExtractMs: unpacked.ms,
      packBytes: statSync(artifact).size, packBuildMs: built.ms + encoded.ms };
  });
  const libraryPath = join(scratch, 'library'); library = new Library(libraryPath);
  for (const row of revisions) {
    row.packImportMs = measure(() => library.import(loadPack(row.artifact))).ms;
    row.packFromGitTotalMs = row.gitArchiveBuildMs + row.gitExtractMs + row.packBuildMs + row.packImportMs;
  }
  library.close(); library = undefined;
  const cli = join(root, 'packages/synesis-mcp/dist/cli.js');
  const cwdA = join(scratch, 'client-a'); const cwdB = join(scratch, 'client-b'); mkdirSync(cwdA); mkdirSync(cwdB);
  const synesisA = await connect(cli, ['mcp', '--library', libraryPath], cwdA, 'trial-client-a');
  const synesisB = await connect(cli, ['mcp', '--library', libraryPath], cwdB, 'trial-client-b');
  const filesA = await connect(filesystemServer, revisions.map(row => row.snapshot), cwdA, 'trial-files-a');
  const filesB = await connect(filesystemServer, revisions.map(row => row.snapshot), cwdB, 'trial-files-b');
  const results = [];
  for (const task of fixture.tasks) {
    const row = revisions[task.revision]; const selection = { pack: 'synesis-project', version: row.revision };
    const original = command('git', ['show', `${row.revision}:${task.path}`]).toString('utf8');
    assert(original.includes(task.expected), `Stale trial expectation: ${task.id}`);
    const queryTerms = [...new Set(task.query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
    const rg = spawnSync('rg', ['--files-with-matches', '--ignore-case', '--fixed-strings', ...queryTerms.flatMap(term => ['-e', term]), '--', ...fixture.files],
      { cwd: row.snapshot, encoding: 'utf8', timeout: 10000 });
    assert(rg.status === 0 || rg.status === 1, rg.stderr);
    const nativePaths = rg.stdout.trim().split('\n').filter(Boolean);
    const search = JSON.parse(await call(synesisA.client, 'knowledge_search', { ...selection, query: task.query, limit: 10 }));
    const evidenceA = await source(synesisA.client, selection, task.path);
    const evidenceB = await source(synesisB.client, selection, task.path);
    const path = join(row.snapshot, task.path);
    const fileA = await call(filesA.client, 'read_text_file', { path });
    const fileB = await call(filesB.client, 'read_text_file', { path });
    assert.equal(evidenceA.text, original); assert.equal(evidenceB.text, original);
    assert.equal(fileA, original); assert.equal(fileB, original);
    assert.equal(evidenceA.sourceRevision, row.revision); assert.equal(evidenceA.digest, row.digest);
    results.push({ id: task.id, question: task.question, revision: row.revision, sourcePath: task.path,
      nativeSearch: { expectedSourceFound: nativePaths.includes(task.path), matchedSources: nativePaths.length },
      synesisSearch: { expectedSourceFound: search.results.some(part => part.path === task.path), excerpts: search.results.length,
        expectedEvidencePresent: search.results.some(part => part.path === task.path && part.text.includes(task.expected)) },
      sourceRecovery: { expectedPathSupplied: true, nativeGitMatches: true, filesystemMcpBothSessionsMatch: true, synesisBothSessionsMatch: true,
        synesisCallsPerSession: evidenceA.calls, sourceSha256: evidenceA.sha256, citation: evidenceA.citation } });
  }
  const required = { pack: 'synesis-project', path: 'docs/clients/MCP_QUICKSTART.md' };
  const missingVersion = await synesisA.client.callTool({ name: 'knowledge_read', arguments: required });
  assert(missingVersion.isError);
  const outsidePath = join(scratch, 'outside.txt'); writeFileSync(outsidePath, 'Boundary check; no private content.', { mode: 0o600 });
  const outside = await filesA.client.callTool({ name: 'read_text_file', arguments: { path: outsidePath } });
  assert(outside.isError);
  const result = { kind: fixture.kind, date: new Date().toISOString(), implementationRevision: command('git', ['rev-parse', 'HEAD']).toString().trim(),
    runtime: process.version, git: command('git', ['--version']).toString().trim(), ripgrep: command('rg', ['--version']).toString().split('\n')[0],
    fixtureSha256: hash(readFileSync(new URL('./pack-trial.json', import.meta.url))),
    runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    alternative: { name: alternative.name, version: alternative.version, entryPointSha256: hash(readFileSync(filesystemServer)), tools: filesA.tools.map(tool => tool.name), startupMs: filesA.startupMs },
    synesis: { tools: synesisA.tools.map(tool => tool.name), startupMs: synesisA.startupMs, libraryBytes: diskBytes(libraryPath) },
    revisions: revisions.map(({ snapshot: _snapshot, artifact: _artifact, ...row }) => row), results,
    boundaries: { synesisMissingVersionRejected: true, filesystemOutsideConfiguredRootsRejected: true },
    modelCalls: 0, privateDocuments: 0, actualCodingOrChatHarnesses: 0,
    limitations: ['Five authored public-repository probes, not held-out user tasks or measured model success',
      'Two official SDK sessions test cwd-independent transport reuse, not two actual agent harnesses',
      'Recovery uses expected source paths; finding and selecting evidence is not scored as completed reasoning',
      'Native rg returns file matches; Synesis returns ranked overlapping excerpts, so hit counts are not comparable recall scores',
      'Git snapshots already preserve both versions and filesystem MCP reads them; these capabilities are not unique to Synesis',
      'Startup and file-size observations exclude npm installation, child peak RAM and realistic corpus capacity',
      'The filesystem alternative advertises write tools; only read operations on disposable snapshots were exercised',
      'No private authorization, user corrections, hosted service or paid knowledge-provider comparison was performed'] };
  writeFileSync(resolve(values.output), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Recorded ${results.length} public probes. Both alternatives recover both versions across two SDK sessions. No model-quality claim.`);
} finally {
  for (const client of clients.reverse()) await client.close();
  library?.close(); rmSync(scratch, { recursive: true, force: true });
}
