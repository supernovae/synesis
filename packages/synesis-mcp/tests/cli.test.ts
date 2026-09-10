import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function run(cwd: string, ...args: string[]) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000 }); }
function populate(f: ReturnType<typeof fixture>) {
  const config = join(f.root, 'build.json'); writeFileSync(config, JSON.stringify(f.config));
  const artifact = join(f.root, 'manual.synpack');
  const built = run(f.root, 'build', config, '--root', f.input, '--output', artifact);
  expect(built.status, built.stderr).toBe(0);
  const imported = run(f.root, 'import', artifact, '--library', f.library);
  expect(imported.status, imported.stderr).toBe(0);
}

describe('standalone CLI and real MCP subprocess', () => {
  it('builds/imports/reads from another cwd without backend credentials', () => {
    const f = fixture(); populate(f);
    const result = run(resolve(f.input), 'read', '--library', f.library, '--pack', 'manual', '--version', '1.0', '--path', 'guide.md');
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).text).toContain('parseConfig');
    expect(run(f.root, 'mcp').stderr).toContain('--library is required');
    expect(run(f.root, 'packs', '--library', f.library, '--root', f.input).status).toBe(1);
  });
  it('negotiates MCP, lists only read tools and enforces arguments through the real client', async () => {
    const f = fixture(); populate(f);
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--library', f.library], cwd: f.input, stderr: 'pipe' });
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(['knowledge_packs', 'knowledge_read', 'knowledge_search', 'knowledge_sources']);
      expect(tools.tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
      const packs = await client.callTool({ name: 'knowledge_packs', arguments: {} });
      expect(JSON.parse((packs.content as Array<{ text: string }>)[0]!.text).packs[0].id).toBe('manual');
      const search = await client.callTool({ name: 'knowledge_search', arguments: { pack: 'manual', version: '1.0', query: 'parseConfig' } });
      expect(JSON.stringify(search)).toContain('parseConfig');
      const denied = await client.callTool({ name: 'knowledge_read', arguments: { pack: 'manual', version: '1.0', path: '../../secret' } });
      expect(denied.isError).toBe(true);
      const unknown = await client.callTool({ name: 'knowledge_packs', arguments: { library: f.root } });
      expect(unknown.isError).toBe(true);
    } finally { await client.close(); }
  });
  it('exits cleanly on stdin close and emits no non-protocol stdout', async () => {
    const f = fixture(); populate(f);
    const child = spawn(process.execPath, [cli, 'mcp', '--library', f.library], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', part => { output += part; });
    const closed = once(child, 'close'); child.stdin.end();
    const [code] = await closed;
    expect(code).toBe(0); expect(output).toBe('');
  });
});
