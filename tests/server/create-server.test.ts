import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../../src/server/create-server.js';
import { OperationLimiter } from '../../src/server/operation-limiter.js';

describe('MCP server', () => {
  const clients: Client[] = [];
  const servers: Server[] = [];
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((path) => fs.rm(path, { recursive: true, force: true }))
    );
  });

  it('lists and invokes the ingestion tool over MCP', async () => {
    // Arrange
    const repositoryPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-mcp-'));
    cleanupPaths.push(repositoryPath);
    await fs.writeFile(join(repositoryPath, 'README.md'), '# MCP');
    const { client } = await connectServer(
      createMcpServer({ allowUnrestrictedLocalRepositories: true })
    );

    // Act
    const tools = await client.listTools();
    const result = await client.callTool({
      name: 'ingest_repository',
      arguments: { repository: repositoryPath, maxTokens: 1000 },
    });
    const text = result.content[0];

    // Assert
    expect(tools.tools.map((tool) => tool.name)).toContain('ingest_repository');
    expect(result.isError).toBeUndefined();
    expect(text).toMatchObject({ type: 'text' });
    expect(text).toHaveProperty(
      'text',
      expect.stringContaining('## README.md')
    );
  });

  it('returns structured tool errors for unknown, invalid, and busy calls', async () => {
    // Arrange
    const limiter = new OperationLimiter(1);
    const release = limiter.tryAcquire();
    const { client } = await connectServer(
      createMcpServer({
        allowUnrestrictedLocalRepositories: true,
        operationLimiter: limiter,
      })
    );

    // Act
    const unknownResult = await client.callTool({
      name: 'unknown_tool',
      arguments: {},
    });
    const invalidResult = await client.callTool({
      name: 'ingest_repository',
      arguments: {},
    });
    const busyResult = await client.callTool({
      name: 'ingest_repository',
      arguments: { repository: '.' },
    });
    release?.();

    // Assert
    expect(toolText(unknownResult)).toContain('Unknown tool');
    expect(unknownResult.isError).toBe(true);
    expect(toolText(invalidResult)).toContain('Invalid input');
    expect(invalidResult.isError).toBe(true);
    expect(toolText(busyResult)).toContain('maximum concurrent ingestion');
    expect(busyResult.isError).toBe(true);
    expect(limiter.activeCount).toBe(0);
  });

  async function connectServer(server: Server): Promise<{ client: Client }> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    clients.push(client);
    servers.push(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client };
  }
});

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}
