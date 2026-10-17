import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('HTTP discovery advertises attachment schema and rejects invalid args before provider calls', async () => {
  const port = String(33000 + Math.floor(Math.random() * 2000));
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { PATH: process.env.PATH, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const client = new Client({ name: 'offline-gmail-test', version: '1' });
  try {
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw Error('startup failed');
      }),
    ]);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: 'Bearer offline-not-real' },
          },
        },
      ),
    );
    const list = await client.listTools();
    assert.equal(list.tools.length, 12);
    const tool = list.tools.find((t) => t.name === 'gmail_get_attachment')!;
    assert.equal((tool.inputSchema.properties!.mode as any).default, 'text');
    const result = await client.callTool({
      name: 'gmail_get_attachment',
      arguments: { messageId: 'm' },
    });
    assert.equal(result.isError, true);
    const health = await (
      await fetch(`http://localhost:${port}/health`)
    ).json();
    assert.equal(health.version, '2.1.0');
  } finally {
    await client.close();
    child.kill();
    await once(child, 'exit');
  }
});
