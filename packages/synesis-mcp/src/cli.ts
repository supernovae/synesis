#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Library } from './library.js';
import { buildPack, decodeUtf8, loadPack, readBounded, writePack } from './pack.js';
import { createSynesisMcpServer } from './index.js';

const HELP = `Synesis source packs and local knowledge tools

  synesis build CONFIG --root DIRECTORY --output FILE.synpack
  synesis validate FILE.synpack
  synesis import FILE.synpack --library /absolute/library
  synesis packs --library /absolute/library [--offset N --limit N]
  synesis sources --library /absolute/library --pack ID --version VERSION
  synesis search QUERY --library /absolute/library --pack ID --version VERSION
  synesis read --library /absolute/library --pack ID --version VERSION --path SOURCE [--offset N --length N]
  synesis export --library /absolute/library --pack ID --version VERSION --output FILE.synpack
  synesis delete --library /absolute/library --pack ID --version VERSION
  synesis rebuild --library /absolute/library
  synesis backup --library /absolute/library --output FILE.sqlite
  synesis mcp --library /absolute/library

Builds use only explicit files inside --root. New files never overwrite existing files.
MCP tools read only this library; use a separate library for each client trust boundary.
No running services, model calls or provider tokens are required.
`;
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, root: { type: 'string' }, output: { type: 'string' },
      library: { type: 'string' }, pack: { type: 'string' }, version: { type: 'string' }, path: { type: 'string' },
      offset: { type: 'string' }, limit: { type: 'string' }, length: { type: 'string' },
    }
  });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, argument] = positionals;
  const commands = ['build', 'validate', 'import', 'packs', 'sources', 'search', 'read', 'export', 'delete', 'rebuild', 'backup', 'mcp'];
  if (!command || !commands.includes(command)) throw new Error('Unknown command; use --help');
  const needsArgument = ['build', 'validate', 'import', 'search'].includes(command);
  if (positionals.length !== (needsArgument ? 2 : 1)) throw new Error('Unexpected or missing argument; use --help');
  const allowed: Record<string, string[]> = {
    build: ['root', 'output'], validate: [], import: ['library'], packs: ['library', 'offset', 'limit'],
    sources: ['library', 'pack', 'version', 'offset', 'limit'], search: ['library', 'pack', 'version', 'limit'],
    read: ['library', 'pack', 'version', 'path', 'offset', 'length'], export: ['library', 'pack', 'version', 'output'],
    delete: ['library', 'pack', 'version'], rebuild: ['library'], backup: ['library', 'output'], mcp: ['library'],
  };
  for (const option of Object.keys(values)) if (!allowed[command]?.includes(option)) throw new Error(`Option --${option} is not valid for ${command}`);
  const required = (key: 'root' | 'output' | 'library' | 'pack' | 'version' | 'path'): string => {
    const value = values[key]; if (!value) throw new Error(`--${key} is required`); return value;
  };
  const numbers = () => Object.fromEntries(['offset', 'limit', 'length'].filter(key => values[key as 'offset'] !== undefined)
    .map(key => [key, Number(values[key as 'offset'])]));
  const selection = () => ({ pack: required('pack'), version: required('version') });
  const print = (value: unknown) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };
  if (command === 'build') {
    const pack = buildPack(JSON.parse(decodeUtf8(readBounded(argument!, 1024 * 1024))), required('root'));
    writePack(required('output'), pack);
    print({ pack: pack.id, version: pack.version, digest: pack.digest, sources: pack.sources.length }); return;
  }
  if (command === 'validate') {
    const pack = loadPack(argument!);
    print({ valid: true, pack: pack.id, version: pack.version, digest: pack.digest, sources: pack.sources.length }); return;
  }
  const library = new Library(required('library'), !['import', 'delete', 'rebuild'].includes(command));
  let attached = false;
  try {
    switch (command) {
      case 'import': print(library.import(loadPack(argument!))); break;
      case 'packs': print(library.list(numbers())); break;
      case 'sources': print(library.sources({ ...selection(), ...numbers() })); break;
      case 'search': print(library.search({ ...selection(), query: argument, ...numbers() })); break;
      case 'read': print(library.read({ ...selection(), path: required('path'), ...numbers() })); break;
      case 'export': writePack(required('output'), library.export(selection())); print({ exported: true }); break;
      case 'delete': library.delete(selection()); print({ deleted: true }); break;
      case 'rebuild': library.rebuild(); print({ rebuilt: true }); break;
      case 'backup': await library.backup(required('output')); print({ backedUp: true }); break;
      case 'mcp': {
        const server = createSynesisMcpServer(library);
        let closed = false;
        server.server.onclose = () => { if (!closed) { closed = true; library.close(); } };
        const stop = () => { void server.close(); };
        process.stdin.once('end', stop);
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
        await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }));
        attached = true;
        break;
      }
    }
  } finally { if (!attached) library.close(); }
}
main().catch((error: unknown) => {
  // Diagnostic output must never contaminate the MCP JSON-RPC stream.
  process.stderr.write(`synesis: ${error instanceof Error ? error.message : 'operation failed'}\n`);
  process.exitCode = 1;
});
