import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Library } from '../src/library.js';
import { buildPack } from '../src/pack.js';
import { fixture } from './helpers.js';

const script = fileURLToPath(new URL('../../../scripts/trial.mjs', import.meta.url));
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 20000 });
}
function prepare(f: ReturnType<typeof fixture>) {
  const config = join(f.root, 'config.json');
  const trial = join(f.root, 'private trial');
  writeFileSync(config, JSON.stringify(f.config));
  const result = run(f.input, 'prepare', config, '--root', f.input, '--output', trial);
  expect(result.status, result.stderr).toBe(0);
  return { trial, config, report: JSON.parse(result.stdout) };
}

describe('private trial setup and real MCP preflight', () => {
  it('gives both conditions identical bytes and verifies from an unrelated cwd', () => {
    const f = fixture();
    const { trial, report } = prepare(f);
    expect(report.status).toBe('preflight-passed');
    expect(report.modelCalls).toBe(0);
    expect(report.digest).toBe(f.pack.digest);
    for (const source of f.pack.sources) {
      expect(readFileSync(join(trial, 'native-sources', source.path))).toEqual(readFileSync(join(f.input, source.path)));
      expect(statSync(join(trial, 'native-sources', source.path)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(trial).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(trial, 'notes.md'), 'utf8')).toContain('Status: not run');
    const config = JSON.parse(readFileSync(join(trial, 'mcp.json'), 'utf8'));
    expect(config.mcpServers['synesis-trial'].command).toBe(process.execPath);
    expect(config.mcpServers['synesis-trial'].args.slice(-2)).toEqual(['--library', join(realpathSync(trial), 'library')]);
    expect(run(f.root, 'verify', '--trial', trial).status).toBe(0);
  });

  it('refuses an existing trial and does not damage it on failure', () => {
    const f = fixture();
    const { trial, config } = prepare(f);
    writeFileSync(join(trial, 'notes.md'), 'User observations');
    const repeated = run(f.root, 'prepare', config, '--root', f.input, '--output', trial);
    expect(repeated.status).toBe(1);
    expect(readFileSync(join(trial, 'notes.md'), 'utf8')).toBe('User observations');
    expect(run(f.root, 'verify', '--trial', trial).status).toBe(0);
    writeFileSync(config, JSON.stringify({ ...f.config, files: ['../outside.txt'] }));
    const failedOutput = join(f.root, 'failed-trial');
    expect(run(f.root, 'prepare', config, '--root', f.input, '--output', failedOutput).status).toBe(1);
    expect(existsSync(failedOutput)).toBe(false);
  });

  it.each(['changed', 'additional'] as const)('detects %s native evidence before a comparison', change => {
    const f = fixture();
    const { trial } = prepare(f);
    writeFileSync(join(trial, 'native-sources', change === 'changed' ? 'guide.md' : 'extra.md'), 'Different evidence');
    const checked = run(f.root, 'verify', '--trial', trial);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toMatch(/snapshot/i);
    expect(readFileSync(join(f.input, 'guide.md'), 'utf8')).toContain('parseConfig');
  });

  it('detects additional library versions instead of silently broadening evidence', () => {
    const f = fixture();
    const { trial } = prepare(f);
    const library = new Library(join(trial, 'library'));
    try { library.import(buildPack({ ...f.config, version: '2.0' }, f.input)); } finally { library.close(); }
    const checked = run(f.root, 'verify', '--trial', trial);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('only its selected pack');
  });

  it('does not execute a substituted command in the generated MCP configuration', () => {
    const f = fixture();
    const { trial } = prepare(f);
    const marker = join(f.root, 'must-not-exist');
    writeFileSync(join(trial, 'mcp.json'), JSON.stringify({ mcpServers: { 'synesis-trial': {
      command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
    } } }));
    const checked = run(f.root, 'verify', '--trial', trial);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('MCP launch configuration changed');
    expect(existsSync(marker)).toBe(false);
  });
});
