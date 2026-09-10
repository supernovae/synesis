import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildPack, encodePack, decodePack, Library } from '../../packages/synesis-mcp/dist/index.js';

const [output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node evals/architecture/local-smoke.mjs result.json');
const files = readFileSync('evals/architecture/source-files.txt', 'utf8').trim().split('\n');
const directory = mkdtempSync(join(tmpdir(), 'synesis-local-smoke-'));
let library;
try {
  const started = performance.now();
  const pack = buildPack({ id: 'synesis-source-navigation', version: 'screen', title: 'Source navigation screen',
    sourceRevision: 'working-tree-content-identified-by-digest', attribution: 'Synesis contributors', license: 'Apache-2.0', files }, process.cwd());
  const archive = encodePack(pack);
  const buildMs = performance.now() - started;
  library = new Library(join(directory, 'library'));
  const beforeImport = performance.now(); library.import(decodePack(archive));
  const importMs = performance.now() - beforeImport;
  const tasks = [
    { query: 'canonical', path: 'packages/synesis-mcp/src/pack.ts', expected: 'canonical' },
    { query: 'nextOffset', path: 'packages/synesis-mcp/src/library.ts', expected: 'nextOffset' },
    { query: 'knowledge_sources', path: 'packages/synesis-mcp/src/index.ts', expected: 'knowledge_sources' },
  ];
  const results = tasks.map(task => {
    const before = performance.now();
    const selected = { pack: pack.id, version: pack.version };
    const found = library.search({ ...selected, query: task.query, limit: 10 });
    const source = library.read({ ...selected, path: task.path, length: 16000 });
    const nativeContains = readFileSync(task.path, 'utf8').includes(task.expected);
    return { ...task, nativeFileContainsExpected: nativeContains, searchFoundExpectedSource: found.results.some(result => result.path === task.path),
      pinnedReadContainsExpected: source.text.includes(task.expected), elapsedMs: performance.now() - before };
  });
  const result = { kind: 'local-source-navigation-smoke', date: new Date().toISOString(), runtime: process.version,
    sourceCount: pack.sources.length, digest: pack.digest, archiveBytes: archive.length, buildMs, importMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, results, modelCalls: 0, databaseDaemons: 0,
    limitations: ['Selected repository questions; native file tools also locate this evidence', 'No demonstrated model-quality benefit, private ACL coverage, semantic recall or hosted resource acceptance', 'Cross-client immutable packaging is a capability under evaluation, not a benchmark superiority claim'] };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  if (results.some(row => !row.pinnedReadContainsExpected || !row.searchFoundExpectedSource)) process.exitCode = 1;
} finally { library?.close(); rmSync(directory, { recursive: true, force: true }); }
