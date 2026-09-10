#!/usr/bin/env node
import { mkdirSync, writeFileSync, lstatSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Library, buildPack, loadPack, writePack } from '../packages/synesis-mcp/dist/index.js';
import { canonical, decodeUtf8, readBounded, sha256 } from '../packages/synesis-mcp/dist/pack.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repo, 'packages/synesis-mcp/dist/cli.js');
const readJson = path => JSON.parse(decodeUtf8(readBounded(path, 1024 * 1024)));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const check = (condition, message) => { if (!condition) throw new Error(message); };

function implementation() {
  const files = ['scripts/trial.mjs', 'package-lock.json', ...['cli', 'index', 'library', 'pack'].map(name => `packages/synesis-mcp/dist/${name}.js`)];
  const checksums = files.map(path => [path, sha256(readBounded(join(repo, path), 4 * 1024 * 1024))]);
  return {
    packageVersion: readJson(join(repo, 'packages/synesis-mcp/package.json')).version,
    node: process.version,
    sha256: sha256(canonical(Object.fromEntries(checksums))),
  };
}

function mcpConfig(directory) {
  return { mcpServers: { 'synesis-trial': {
    command: process.execPath, args: [cli, 'mcp', '--library', join(directory, 'library')],
  } } };
}

function snapshotConfig(pack) {
  return {
    id: pack.id, version: pack.version, title: pack.title, sourceRevision: pack.sourceRevision,
    attribution: pack.attribution, license: pack.license, redistribution: pack.redistribution,
    files: pack.sources.map(({ path, symbols, url }) => ({ path, symbols, ...(url ? { url } : {}) })),
  };
}

function privateDirectory(path) {
  const stat = lstatSync(path);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a regular trial directory');
  check((stat.mode & 0o077) === 0, 'Trial directories must be private to their OS user');
}

function verifySnapshot(directory, pack) {
  const files = new Set(pack.sources.map(source => source.path));
  const directories = new Set(['']);
  for (const path of files) {
    const parts = path.split('/');
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
  }
  const pending = [''];
  while (pending.length) {
    const prefix = pending.pop();
    privateDirectory(join(directory, prefix));
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(path)) pending.push(path);
      else check(entry.isFile() && files.has(path), 'Native snapshot contains unexpected entries or symlinks');
    }
  }
  check(buildPack(snapshotConfig(pack), directory).digest === pack.digest, 'Native snapshot differs from the source pack');
}

async function verify(directory) {
  check(isAbsolute(directory), '--trial must be absolute');
  privateDirectory(directory);
  directory = realpathSync(directory);
  const record = readJson(join(directory, 'trial.json'));
  check(record.format === 'synesis.trial' && record.formatVersion === 1, 'Invalid trial metadata');
  check(canonical(record.implementation) === canonical(implementation()), 'Runtime or build changed; use the original build or prepare a new trial');
  check(canonical(readJson(join(directory, 'mcp.json'))) === canonical(mcpConfig(directory)), 'MCP launch configuration changed or moved; prepare a new trial');
  const pack = loadPack(join(directory, 'sources.synpack'));
  const selection = { pack: pack.id, version: pack.version };
  check(record.digest === pack.digest && record.pack === pack.id && record.version === pack.version &&
    record.sourceRevision === pack.sourceRevision && record.sources === pack.sources.length, 'Trial source identity changed');
  verifySnapshot(join(directory, 'native-sources'), pack);
  const library = new Library(join(directory, 'library'), true);
  try {
    const installed = library.list({});
    check(installed.packs.length === 1 && installed.nextOffset === null, 'Trial library must contain only its selected pack');
    check(library.export(selection).digest === pack.digest, 'Library differs from the source pack');
  } finally { library.close(); }

  // Launch only this checkout's known CLI. Never execute commands from trial data.
  const client = new Client({ name: 'synesis-trial-preflight', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp', '--library', join(directory, 'library')],
    cwd: join(directory, 'native-sources'), stderr: 'pipe',
  });
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
    check(!result.isError, `MCP preflight failed: ${name}`);
    const content = result.content.filter(part => part.type === 'text');
    check(content.length === 1, `Unexpected MCP result: ${name}`);
    return JSON.parse(content[0].text);
  }
  try {
    await client.connect(transport, { timeout: 10000 });
    transport.stderr?.resume();
    const tools = (await client.listTools({}, { timeout: 10000 })).tools;
    check(canonical(tools.map(tool => tool.name).sort()) === canonical(['knowledge_packs', 'knowledge_read', 'knowledge_search', 'knowledge_sources']), 'Unexpected MCP tool set');
    check(tools.every(tool => tool.annotations?.readOnlyHint === true), 'Expected read-only tools');
    const packs = await call('knowledge_packs', {});
    check(packs.packs.length === 1 && packs.packs[0].digest === pack.digest, 'Unexpected MCP library');
    const sources = await call('knowledge_sources', { ...selection, limit: 1 });
    check(sources.digest === pack.digest && sources.sources[0]?.path === pack.sources[0].path, 'Unexpected MCP source listing');
    const source = pack.sources.find(item => item.text.length) ?? pack.sources[0];
    const read = await call('knowledge_read', { ...selection, path: source.path, length: 128 });
    check(read.digest === pack.digest && read.sha256 === source.sha256 && read.text === Array.from(source.text).slice(0, 128).join(''), 'Unexpected MCP evidence');
    const query = (source.path.match(/[\p{L}\p{N}_]+/u)?.[0] ?? 'source').slice(0, 100);
    const search = await call('knowledge_search', { ...selection, query, limit: 1 });
    check(search.digest === pack.digest && Array.isArray(search.results), 'Unexpected MCP search response');
  } finally { await client.close(); }
  return { status: 'preflight-passed', trial: directory, ...selection, digest: pack.digest, sources: pack.sources.length, modelCalls: 0 };
}

async function prepare(configPath, root, output) {
  check(isAbsolute(output), '--output must be absolute');
  // Validate every selected input before creating the trial directory.
  const pack = buildPack(readJson(configPath), root);
  check(pack.sources.some(source => source.text.trim()), 'Select at least one nonempty source for the trial');
  const directory = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
  mkdirSync(directory, { mode: 0o700 }); // Exclusive: never reuse or overwrite a trial.
  try {
    const native = join(directory, 'native-sources');
    mkdirSync(native, { mode: 0o700 });
    for (const source of pack.sources) {
      const path = join(native, source.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, source.text, { flag: 'wx', mode: 0o600 });
    }
    writePack(join(directory, 'sources.synpack'), pack);
    const library = new Library(join(directory, 'library'));
    try { library.import(pack); } finally { library.close(); }
    writeJson(join(directory, 'trial.json'), {
      format: 'synesis.trial', formatVersion: 1, createdAt: new Date().toISOString(),
      implementation: implementation(), pack: pack.id, version: pack.version, digest: pack.digest,
      sourceRevision: pack.sourceRevision, sources: pack.sources.length,
    });
    writeJson(join(directory, 'mcp.json'), mcpConfig(directory));
    writeFileSync(join(directory, 'notes.md'), readBounded(join(repo, 'trials/worksheet.md'), 64 * 1024), { flag: 'wx', mode: 0o600 });
    return await verify(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true }); // Only the directory exclusively created above.
    throw error;
  }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    root: { type: 'string' }, output: { type: 'string' }, trial: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('node scripts/trial.mjs prepare CONFIG --root DIRECTORY --output /absolute/new-trial\nnode scripts/trial.mjs verify --trial /absolute/trial\nNo model calls or network acquisition. Trial directories must be new; their parent must exist.\n');
    return;
  }
  check(process.platform !== 'win32', 'The trial kit currently requires POSIX filesystem permissions');
  let result;
  if (positionals[0] === 'prepare' && positionals.length === 2 && values.root && values.output && !values.trial) {
    result = await prepare(positionals[1], values.root, values.output);
  } else if (positionals[0] === 'verify' && positionals.length === 1 && values.trial && !values.root && !values.output) {
    result = await verify(values.trial);
  } else throw new Error('Use --help for required arguments');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => { process.stderr.write(`synesis-trial: ${error.message}\n`); process.exitCode = 1; });
