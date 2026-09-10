import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Library } from '../src/library.js';
import { buildPack } from '../src/pack.js';
import { fixture } from './helpers.js';
const selection = { pack: 'manual', version: '1.0' };

describe('local knowledge library', () => {
  it('imports atomically, preserves versions, and rejects conflicting immutable imports', () => {
    const f = fixture(); const db = new Library(f.library);
    try {
      expect(db.import(f.pack).imported).toBe(true);
      expect(db.import(f.pack).imported).toBe(false);
      const changed = buildPack({ ...f.config, sourceRevision: 'other' }, f.input);
      expect(() => db.import(changed)).toThrow('Immutable version conflict');
      expect(db.export(selection)).toEqual(f.pack);
      db.import(buildPack({ ...f.config, version: '2.0' }, f.input));
      expect(db.list({ limit: 1 }).nextOffset).toBe(1);
      expect(db.list({ offset: 1 }).packs[0].version).toBe('2.0');
    } finally { db.close(); }
  });
  it('searches exact versions and returns recoverable Unicode evidence with provenance', () => {
    const f = fixture(); const db = new Library(f.library);
    try {
      db.import(f.pack);
      const result = db.search({ ...selection, query: 'parseConfig' }).results[0]!;
      expect(result.path).toBe('guide.md'); expect(result.text).toContain('pinned version');
      expect(result.sourceRevision).toBe('fixture-revision'); expect(result.digest).toBe(f.pack.digest);
      expect(result.citation).toBe('synpack:manual@1.0/guide.md#L1');
      const first = db.read({ ...selection, path: 'guide.md', length: 3 });
      expect(first.text).toBe('α😀\n'); expect(first.nextOffset).toBe(3); expect(first.endLine).toBe(1);
      const rest = db.read({ ...selection, path: 'guide.md', offset: first.nextOffset });
      expect(rest.startLine).toBe(2); expect(rest.text).toMatch(/^beta/); expect(rest.nextOffset).toBeNull();
      expect(db.read({ ...selection, path: 'empty.txt' }).text).toBe('');
      expect(db.search({ ...selection, query: 'guide.md' }).results[0]!.path).toBe('guide.md');
      expect(() => db.search({ ...selection, version: 'missing', query: 'parseConfig' })).toThrow('not found');
    } finally { db.close(); }
  });
  it('requires exact identities and bounded closed queries', () => {
    const f = fixture(); const db = new Library(f.library);
    try {
      db.import(f.pack);
      expect(() => db.search({ pack: 'manual', query: 'version' })).toThrow();
      expect(() => db.read({ ...selection, path: '../secret' })).toThrow();
      expect(() => db.read({ ...selection, path: 'guide.md', offset: 90000 })).toThrow('offset');
      expect(() => db.read({ ...selection, path: 'guide.md', length: 16001 })).toThrow();
      expect(() => db.search({ ...selection, query: 'x', principal: 'admin' })).toThrow();
      expect(() => db.search({ ...selection, query: Array.from({ length: 33 }, (_, i) => `word${i}`).join(' ') })).toThrow('32');
      expect(db.search({ ...selection, query: '" OR * ( - : ;' }).results).toEqual([]);
      expect(db.sources({ ...selection, limit: 1 }).nextOffset).toBe(1);
    } finally { db.close(); }
  });
  it('keeps filenames with URI punctuation unambiguous in citations', () => {
    const f = fixture(); const db = new Library(f.library);
    const path = 'guide #1?.md'; writeFileSync(join(f.input, path), 'Pinned evidence.');
    try {
      db.import(buildPack({ ...f.config, files: [path] }, f.input));
      const evidence = db.read({ ...selection, path });
      expect(evidence.path).toBe(path);
      expect(evidence.citation).toBe('synpack:manual@1.0/guide%20%231%3F.md#L1');
    } finally { db.close(); }
  });
  it('keeps original evidence pinned after the source changes', () => {
    const f = fixture(); const db = new Library(f.library);
    try {
      db.import(f.pack);
      writeFileSync(join(f.input, 'guide.md'), 'A changed source revision.\n');
      db.import(buildPack({ ...f.config, version: '2.0' }, f.input));
      expect(db.read({ ...selection, path: 'guide.md' }).text).toContain('parseConfig');
      expect(db.read({ ...selection, version: '2.0', path: 'guide.md' }).text).toBe('A changed source revision.\n');
    } finally { db.close(); }
  });
  it('does not mix source identities with concurrent deletion and row reuse', async () => {
    const f = fixture(); let db = new Library(f.library); db.import(f.pack); db.close();
    writeFileSync(join(f.input, 'other.txt'), 'Unrelated source evidence.');
    const other = buildPack({ ...f.config, id: 'other', files: ['other.txt'] }, f.input);
    const worker = new Worker(new URL('./concurrent-writer.mjs', import.meta.url), { workerData: { library: f.library, pack: f.pack, other } });
    try {
      const [ready] = await once(worker, 'message'); expect(ready.ready).toBe(true);
      db = new Library(f.library, true);
      const finished = once(worker, 'message'); worker.postMessage('start');
      for (let i = 0; i < 400; i++) {
        try {
          const rows = db.sources(selection);
          expect(rows.sources.map(row => row.path)).toEqual(['empty.txt', 'guide.md']);
          expect(rows.digest).toBe(f.pack.digest);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Pack version not found') throw error;
        }
      }
      const [result] = await finished; expect(result).toEqual({ done: true });
    } finally { await worker.terminate(); db.close(); }
  }, 10000);
  it('reopens read-only without a writer, rebuilds indexes and deletes all active evidence', () => {
    const f = fixture(); let db = new Library(f.library);
    db.import(f.pack); db.rebuild(); db.close();
    db = new Library(f.library, true);
    try {
      expect(db.search({ ...selection, query: 'parseConfig' }).results.length).toBeGreaterThan(0);
      expect(() => db.delete(selection)).toThrow('read-only'); expect(() => db.import(f.pack)).toThrow('read-only');
    } finally { db.close(); }
    db = new Library(f.library);
    try {
      db.delete(selection); expect(db.list().packs).toEqual([]);
      expect(() => db.export(selection)).toThrow('not found');
      expect(() => db.import(buildPack({ ...f.config, sourceRevision: 'changed-after-delete' }, f.input))).toThrow('Immutable version conflict');
      db.import(f.pack); expect(db.search({ ...selection, query: 'parseConfig' }).results).toHaveLength(1);
    } finally { db.close(); }
  });
  it('backs up and restores a complete library without model or network dependencies', async () => {
    const f = fixture(); const db = new Library(f.library);
    const destination = join(f.root, 'backup.sqlite');
    try { db.import(f.pack); await db.backup(destination); await expect(db.backup(destination)).rejects.toThrow(); }
    finally { db.close(); }
    const restored = join(f.root, 'restored'); mkdirSync(restored, { mode: 0o700 }); copyFileSync(destination, join(restored, 'library.sqlite'));
    const reader = new Library(restored, true);
    try { expect(reader.export(selection)).toEqual(f.pack); } finally { reader.close(); }
  });
  it('rejects implicit cwd libraries and symlinked library files', () => {
    const f = fixture(); expect(() => new Library('.')).toThrow('absolute');
    mkdirSync(f.library, { mode: 0o700 }); symlinkSync(join(f.input, 'guide.md'), join(f.library, 'library.sqlite'));
    expect(() => new Library(f.library)).toThrow('regular files');
  });
});
