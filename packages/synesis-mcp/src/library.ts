import { existsSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync, mkdtempSync, linkSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical, Id, SourcePath, validatePack, Version, type SourcePack } from './pack.js';

export const Selection = z.object({ pack: Id, version: Version }).strict();
export const Page = z.object({ offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict();
export const SourcesQuery = Selection.extend(Page.shape).strict();
export const SearchQuery = Selection.extend({ query: z.string().trim().min(1).max(1024), limit: z.number().int().min(1).max(10).default(5) }).strict();
export const ReadQuery = Selection.extend({ path: SourcePath, offset: z.number().int().min(0).max(2_097_152).default(0), length: z.number().int().min(1).max(16000).default(8000) }).strict();
const APP_ID = 0x53594e50;
const SCHEMA = 1;
type Row = Record<string, import('node:sqlite').SQLOutputValue>;

function privateFile(path: string, create: boolean): void {
  if (create && !existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Library files must be regular files');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Library files must be private (mode 0600)');
}
function chunks(text: string): Array<{ offset: number; line: number; text: string }> {
  const characters = Array.from(text);
  const output: Array<{ offset: number; line: number; text: string }> = [];
  let line = 1;
  for (let offset = 0; offset < characters.length; offset += 2600) {
    if (offset) line += characters.slice(offset - 2600, offset).filter(char => char === '\n').length;
    output.push({ offset, line, text: characters.slice(offset, offset + 2800).join('') });
  }
  return output;
}

/** A local user's explicitly selected library. Remote identity/ACL handling is not implied. */
export class Library {
  private readonly db: DatabaseSync;
  constructor(directory: string, private readonly readOnly = false) {
    if (!isAbsolute(directory)) throw new Error('Library directory must be an absolute path');
    if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Library must be a regular directory');
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Library directory must be private (mode 0700)');
    const path = join(realpathSync(directory), 'library.sqlite');
    privateFile(path, !readOnly);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) privateFile(path + suffix, false);
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000, allowExtension: false, enableDoubleQuotedStringLiterals: false, defensive: true });
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      const app = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
      if (!readOnly && version === 0 && app === 0 && !this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) this.initialize();
      else if (version !== SCHEMA || app !== APP_ID) throw new Error('Unsupported library schema; rebuild from source packs');
      if (!readOnly) this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    } catch (error) { this.db.close(); throw error; }
  }
  private initialize(): void {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE versions (name TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(name,version)) STRICT;
      CREATE TABLE packs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, manifest TEXT NOT NULL, UNIQUE(name,version)) STRICT;
      CREATE TABLE sources (id INTEGER PRIMARY KEY, pack_id INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
        path TEXT NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL, url TEXT, symbols TEXT NOT NULL, characters INTEGER NOT NULL, UNIQUE(pack_id,path)) STRICT;
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, pack_id INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, path TEXT NOT NULL, offset INTEGER NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
      CREATE INDEX chunk_pack ON chunks(pack_id);
      CREATE VIRTUAL TABLE search_index USING fts5(text, path, content='chunks', content_rowid='id', tokenize='unicode61');
      PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA}; COMMIT;`);
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
  private writable(): void { if (this.readOnly) throw new Error('This library is read-only'); }
  private selected(input: unknown): Row {
    const query = Selection.parse(input);
    const pack = this.db.prepare('SELECT * FROM packs WHERE name=? AND version=?').get(query.pack, query.version);
    if (!pack) throw new Error('Pack version not found');
    return pack;
  }
  private transaction<T>(work: () => T): T {
    this.writable(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private snapshot<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN');
    try { return work(); } finally { this.db.exec('ROLLBACK'); }
  }
  import(input: unknown): { imported: boolean; digest: string } {
    const pack = validatePack(input);
    return this.transaction(() => {
      const identity = this.db.prepare('SELECT digest FROM versions WHERE name=? AND version=?').get(pack.id, pack.version);
      if (identity && identity.digest !== pack.digest) throw new Error('Immutable version conflict: choose a new version');
      const existing = this.db.prepare('SELECT digest FROM packs WHERE name=? AND version=?').get(pack.id, pack.version);
      if (existing) {
        if (existing.digest !== pack.digest) throw new Error('Immutable version conflict: choose a new version');
        return { imported: false, digest: pack.digest };
      }
      this.db.prepare('INSERT OR IGNORE INTO versions(name,version,digest) VALUES (?,?,?)').run(pack.id, pack.version, pack.digest);
      const { sources, ...manifest } = pack;
      const inserted = this.db.prepare('INSERT INTO packs(name,version,digest,manifest) VALUES (?,?,?,?)').run(pack.id, pack.version, pack.digest, canonical(manifest));
      const packId = Number(inserted.lastInsertRowid);
      const sourceInsert = this.db.prepare('INSERT INTO sources(pack_id,path,text,sha256,url,symbols,characters) VALUES (?,?,?,?,?,?,?)');
      const chunkInsert = this.db.prepare('INSERT INTO chunks(pack_id,source_id,path,offset,line,text) VALUES (?,?,?,?,?,?)');
      for (const source of sources) {
        const row = sourceInsert.run(packId, source.path, source.text, source.sha256, source.url ?? null, JSON.stringify(source.symbols), Array.from(source.text).length);
        for (const chunk of chunks(source.text)) chunkInsert.run(packId, Number(row.lastInsertRowid), source.path, chunk.offset, chunk.line, chunk.text);
      }
      this.db.prepare('INSERT INTO search_index(rowid,text,path) SELECT id,text,path FROM chunks WHERE pack_id=?').run(packId);
      return { imported: true, digest: pack.digest };
    });
  }
  list(input: unknown = {}) {
    const query = Page.parse(input);
    const rows = this.db.prepare('SELECT manifest FROM packs ORDER BY name,version LIMIT ? OFFSET ?').all(query.limit + 1, query.offset);
    return { packs: rows.slice(0, query.limit).map(row => JSON.parse(String(row.manifest))), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  }
  sources(input: unknown) {
    return this.snapshot(() => {
      const query = SourcesQuery.parse(input);
      const pack = this.selected({ pack: query.pack, version: query.version });
      const rows = this.db.prepare('SELECT path,sha256,url,symbols,characters FROM sources WHERE pack_id=? ORDER BY path LIMIT ? OFFSET ?').all(Number(pack.id), query.limit + 1, query.offset);
      return { pack: query.pack, version: query.version, digest: pack.digest, sources: rows.slice(0, query.limit).map(row => ({ ...row, symbols: JSON.parse(String(row.symbols)) })), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
    });
  }
  search(input: unknown) {
    return this.snapshot(() => {
      const query = SearchQuery.parse(input);
      const pack = this.selected({ pack: query.pack, version: query.version });
      const terms = [...new Set(query.query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
      if (terms.length > 32) throw new Error('Search supports at most 32 distinct terms');
      const exact = this.db.prepare(`SELECT path,0 AS offset FROM sources WHERE pack_id=? AND
      (path=? OR EXISTS(SELECT 1 FROM json_each(sources.symbols) WHERE value=?)) ORDER BY path LIMIT ?`).all(Number(pack.id), query.query, query.query, query.limit);
      const matches = terms.length ? this.db.prepare(`SELECT c.path,c.offset FROM search_index JOIN chunks c ON c.id=search_index.rowid
      WHERE search_index MATCH ? AND c.pack_id=? ORDER BY rank,c.id LIMIT ?`).all(terms.map(term => '"' + term + '"').join(' OR '), Number(pack.id), query.limit) : [];
      const seen = new Set<string>();
      return {
        pack: query.pack, version: query.version, digest: pack.digest, results: [...exact, ...matches].filter(row => {
          const key = JSON.stringify([row.path, row.offset]); if (seen.has(key)) return false; seen.add(key); return true;
        }).slice(0, query.limit).map(row => this.read({ pack: query.pack, version: query.version, path: row.path, offset: row.offset, length: 2800 }))
      };
    });
  }
  read(input: unknown) {
    return this.snapshot(() => {
      const query = ReadQuery.parse(input);
      const pack = this.selected({ pack: query.pack, version: query.version });
      const row = this.db.prepare(`SELECT path,sha256,url,characters,substr(text,?,?) AS text,
      length(substr(text,1,?))-length(replace(substr(text,1,?),char(10),''))+1 AS start_line
      FROM sources WHERE pack_id=? AND path=?`).get(query.offset + 1, query.length, query.offset, query.offset, Number(pack.id), query.path);
      if (!row) throw new Error('Source not found');
      if (query.offset > Number(row.characters)) throw new Error('Read offset exceeds source length');
      const text = String(row.text);
      const end = query.offset + Array.from(text).length;
      const startLine = Number(row.start_line);
      const endLine = startLine + (text.match(/\n/g)?.length ?? 0) - (text.endsWith('\n') ? 1 : 0);
      const metadata = JSON.parse(String(pack.manifest)) as Omit<SourcePack, 'sources'>;
      return {
        pack: query.pack, version: query.version, digest: pack.digest, path: query.path, sha256: row.sha256,
        sourceRevision: metadata.sourceRevision, attribution: metadata.attribution, license: metadata.license,
        url: row.url, text, offset: query.offset, nextOffset: end < Number(row.characters) ? end : null,
        startLine, endLine, citation: `synpack:${query.pack}@${query.version}/${query.path.split('/').map(encodeURIComponent).join('/')}#L${startLine}`
      };
    });
  }
  export(input: unknown): SourcePack {
    // One read transaction keeps manifest and sources consistent with concurrent deletion.
    return this.snapshot(() => {
      const pack = this.selected(input);
      const sources = this.db.prepare('SELECT path,text,sha256,url,symbols FROM sources WHERE pack_id=? ORDER BY path').all(Number(pack.id)).map(row => ({
        path: row.path, text: row.text, sha256: row.sha256, ...(row.url ? { url: row.url } : {}), symbols: JSON.parse(String(row.symbols)),
      }));
      return validatePack({ ...JSON.parse(String(pack.manifest)), sources });
    });
  }
  delete(input: unknown): void {
    this.transaction(() => {
      const pack = this.selected(input);
      this.db.prepare("INSERT INTO search_index(search_index,rowid,text,path) SELECT 'delete',id,text,path FROM chunks WHERE pack_id=?").run(Number(pack.id));
      this.db.prepare('DELETE FROM packs WHERE id=?').run(Number(pack.id));
    });
  }
  rebuild(): void { this.transaction(() => { this.db.exec("INSERT INTO search_index(search_index) VALUES ('rebuild')"); }); }
  async backup(destination: string): Promise<void> {
    const target = resolve(destination);
    const staging = mkdtempSync(join(dirname(target), '.synesis-backup-'));
    const temporary = join(staging, 'library.sqlite');
    try {
      closeSync(openSync(temporary, 'wx', 0o600));
      await backup(this.db, temporary);
      linkSync(temporary, target);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
}
