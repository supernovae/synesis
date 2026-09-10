import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { buildPack } from '../src/pack.js';
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synesis-test-')); directories.push(root);
  const input = join(root, 'input'); mkdirSync(input);
  writeFileSync(join(input, 'guide.md'), 'α😀\nbeta parseConfig returns the pinned version.\nNo automatic provider calls.\n');
  writeFileSync(join(input, 'empty.txt'), '');
  const config = {
    id: 'manual', version: '1.0', title: 'Manual', sourceRevision: 'fixture-revision', attribution: 'Test authors', license: 'Apache-2.0',
    files: [{ path: 'guide.md', symbols: ['parseConfig'] }, 'empty.txt']
  };
  return { root, input, library: join(root, 'library'), config, pack: buildPack(config, input) };
}
