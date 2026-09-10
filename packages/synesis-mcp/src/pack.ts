import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, readSync, fstatSync, realpathSync, writeFileSync, mkdtempSync, fsyncSync, linkSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';

export const LIMITS = { archiveBytes: 32 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024, sourceBytes: 2 * 1024 * 1024, files: 5000 } as const;
export const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const Version = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SourcePath = z.string().min(1).max(1024).refine(value =>
  !value.includes('\\') && !value.includes(':') && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a relative POSIX source path');
const Locator = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Source URLs must use HTTP(S) without embedded credentials');
const FileSpec = z.object({ path: SourcePath, url: Locator.optional(), symbols: z.array(z.string().min(1).max(128)).max(100).default([]) }).strict();
export const BuildConfig = z.object({
  id: Id, version: Version, title: z.string().min(1).max(256), sourceRevision: z.string().min(1).max(256),
  attribution: z.string().min(1).max(4096), license: z.string().min(1).max(256),
  redistribution: z.enum(['private', 'permitted']).default('private'),
  files: z.array(z.union([SourcePath, FileSpec])).min(1).max(LIMITS.files),
}).strict();
const Source = FileSpec.extend({ text: z.string().max(LIMITS.sourceBytes), sha256: Hash }).strict();
const PackShape = z.object({
  format: z.literal('synesis.source-pack'), formatVersion: z.literal(1),
  id: Id, version: Version, title: z.string().min(1).max(256), sourceRevision: z.string().min(1).max(256),
  attribution: z.string().min(1).max(4096), license: z.string().min(1).max(256),
  redistribution: z.enum(['private', 'permitted']), sources: z.array(Source).min(1).max(LIMITS.files), digest: Hash,
}).strict();
export type SourcePack = z.infer<typeof PackShape>;
export type SourceRecord = SourcePack['sources'][number];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Value is not JSON');
  return serialized;
}
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function packDigest(pack: Omit<SourcePack, 'digest'> | SourcePack): string {
  const { digest: _digest, ...payload } = pack as SourcePack;
  return sha256(canonical(payload));
}
export function validatePack(input: unknown): SourcePack {
  const pack = PackShape.parse(input);
  let previous = '';
  for (const source of pack.sources) {
    if (source.path <= previous) throw new Error('Sources must have unique paths in sorted order');
    previous = source.path;
    if (source.sha256 !== sha256(source.text) || Buffer.byteLength(source.text) > LIMITS.sourceBytes || source.text.includes('\0') ||
      Buffer.from(source.text).toString('utf8') !== source.text) {
      throw new Error('Source integrity or size check failed');
    }
    if (new Set(source.symbols).size !== source.symbols.length) throw new Error('Duplicate source symbols');
  }
  if (pack.digest !== packDigest(pack)) throw new Error('Pack digest mismatch');
  if (Buffer.byteLength(canonical(pack)) > LIMITS.jsonBytes) throw new Error('Pack exceeds size limit');
  return pack;
}

/** Explicit regular-file reads. No directory discovery, symlink following or unbounded reads. */
export function readBounded(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw new Error('Expected a bounded regular file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Input changed while being read');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
export function decodeUtf8(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
export function buildPack(input: unknown, sourceRoot: string): SourcePack {
  if (!sourceRoot) throw new Error('An explicit source root is required');
  const config = BuildConfig.parse(input);
  const root = realpathSync(sourceRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('Source root must be a directory');
  let total = 0;
  const sources = config.files.map(item => {
    const spec = FileSpec.parse(typeof item === 'string' ? { path: item } : item);
    let path = root;
    for (const part of spec.path.split('/')) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) throw new Error('Symlinks are not source inputs');
    }
    const rel = relative(root, realpathSync(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Source escapes the configured root');
    const bytes = readBounded(path, LIMITS.sourceBytes);
    total += bytes.length;
    if (total > LIMITS.jsonBytes) throw new Error('Pack exceeds size limit');
    return { ...spec, text: decodeUtf8(bytes), sha256: sha256(bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const { files: _files, ...metadata } = config;
  const payload = { format: 'synesis.source-pack' as const, formatVersion: 1 as const, ...metadata, sources };
  return validatePack({ ...payload, digest: packDigest(payload) });
}
export function encodePack(input: SourcePack): Buffer {
  const bytes = gzipSync(canonical(validatePack(input)), { level: 9 });
  if (bytes.length > LIMITS.archiveBytes) throw new Error('Compressed pack exceeds size limit');
  return bytes;
}
export function decodePack(bytes: Buffer): SourcePack {
  if (bytes.length > LIMITS.archiveBytes) throw new Error('Compressed pack exceeds size limit');
  const text = decodeUtf8(gunzipSync(bytes, { maxOutputLength: LIMITS.jsonBytes }));
  const parsed: unknown = JSON.parse(text);
  // Canonical input excludes duplicate JSON keys and ambiguous serializations.
  if (canonical(parsed) !== text) throw new Error('Expected canonical source-pack JSON');
  return validatePack(parsed);
}
export function loadPack(path: string): SourcePack { return decodePack(readBounded(path, LIMITS.archiveBytes)); }
export function writePack(path: string, pack: SourcePack): void {
  const target = resolve(path);
  if (!lstatSync(dirname(target)).isDirectory()) throw new Error('Output directory does not exist');
  const bytes = encodePack(pack);
  const staging = mkdtempSync(join(dirname(target), '.synesis-write-'));
  const temporary = join(staging, 'pack');
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Same-filesystem link publishes complete bytes atomically and refuses overwrite.
    linkSync(temporary, target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
