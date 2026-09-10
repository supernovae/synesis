import { gzipSync } from 'node:zlib';
import { symlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPack, canonical, decodePack, encodePack, LIMITS, loadPack, packDigest, validatePack, writePack } from '../src/pack.js';
import { fixture } from './helpers.js';

describe('portable source packs', () => {
  it('builds deterministically, defaults to private, and round-trips attribution and source bytes', () => {
    const f = fixture();
    const again = buildPack({ ...f.config, files: [...f.config.files].reverse() }, f.input);
    expect(encodePack(again)).toEqual(encodePack(f.pack));
    expect(decodePack(encodePack(f.pack))).toEqual(f.pack);
    expect(f.pack.redistribution).toBe('private');
    const output = join(f.root, 'manual.synpack');
    writePack(output, f.pack);
    expect(loadPack(output)).toEqual(f.pack);
    if (process.platform !== 'win32') expect(statSync(output).mode & 0o077).toBe(0);
    expect(() => writePack(output, again)).toThrow();
    expect(loadPack(output)).toEqual(f.pack);
  });
  it('rejects path traversal, absolute paths, duplicate paths and symlinked inputs', () => {
    const f = fixture();
    for (const path of ['../guide.md', '/etc/passwd', 'C:\\secret.txt', 'x/../guide.md']) {
      expect(() => buildPack({ ...f.config, files: [path] }, f.input)).toThrow();
    }
    expect(() => buildPack({ ...f.config, files: ['guide.md', 'guide.md'] }, f.input)).toThrow('unique');
    symlinkSync(f.input, join(f.input, 'linked'));
    expect(() => buildPack({ ...f.config, files: ['linked/guide.md'] }, f.input)).toThrow('Symlinks');
    symlinkSync(join(f.input, 'guide.md'), join(f.input, 'link.md'));
    expect(() => buildPack({ ...f.config, files: ['link.md'] }, f.input)).toThrow('Symlinks');
  });
  it('rejects corrupt checksums, old formats, duplicate JSON keys and unknown fields', () => {
    const f = fixture();
    const corrupt = structuredClone(f.pack); corrupt.sources[0]!.text = 'changed';
    expect(() => validatePack(corrupt)).toThrow('integrity');
    expect(() => validatePack({ ...f.pack, digest: '0'.repeat(64) })).toThrow('digest');
    expect(() => validatePack({ ...f.pack, format: 'synesis-architecture-experiment' })).toThrow();
    expect(() => validatePack({ ...f.pack, principal: 'admin' })).toThrow();
    const raw = canonical(f.pack).replace('{', '{"format":"discarded",');
    expect(() => decodePack(gzipSync(raw))).toThrow('canonical');
    expect(() => decodePack(Buffer.from('PK old zip'))).toThrow();
    expect(() => validatePack({ ...f.pack, sources: [{ ...f.pack.sources[0], path: '../../private' }] })).toThrow();
  });
  it('bounds decompression and rejects non-text input', () => {
    const f = fixture();
    expect(() => decodePack(gzipSync(Buffer.alloc(LIMITS.jsonBytes + 1, 32)))).toThrow();
    writeFileSync(join(f.input, 'binary.txt'), Buffer.from([0xff, 0x00]));
    expect(() => buildPack({ ...f.config, files: ['binary.txt'] }, f.input)).toThrow();
  });
  it('includes attribution and revision in immutable identity', () => {
    const f = fixture();
    const changed = { ...f.pack, sourceRevision: 'another-revision' };
    expect(packDigest(changed)).not.toBe(f.pack.digest);
  });
});
