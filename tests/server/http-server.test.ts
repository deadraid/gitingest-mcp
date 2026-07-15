import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHttpApp,
  loadHttpServerConfig,
  type HttpServerConfig,
} from '../../src/server/http-server.js';

describe('HTTP MCP server security', () => {
  const apps: ReturnType<typeof createHttpApp>[] = [];
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((path) => fs.rm(path, { recursive: true, force: true }))
    );
  });

  it('requires authentication by default', () => {
    // Arrange
    const environment = {};

    // Act
    const act = () => loadHttpServerConfig(environment);

    // Assert
    expect(act).toThrow(/GITINGEST_MCP_API_KEY/);
  });

  it('permits unauthenticated development only on loopback', () => {
    // Arrange
    const loopbackEnvironment = {
      GITINGEST_MCP_ALLOW_UNAUTHENTICATED: 'true',
      GITINGEST_MCP_HOST: '::1',
    };
    const publicEnvironment = {
      GITINGEST_MCP_ALLOW_UNAUTHENTICATED: 'true',
      GITINGEST_MCP_HOST: '0.0.0.0',
    };
    const invalidHostEnvironment = {
      GITINGEST_MCP_API_KEY: 'test-api-key',
      GITINGEST_MCP_HOST: 'https://localhost',
    };

    // Act
    const loopbackConfig = loadHttpServerConfig(loopbackEnvironment);
    const loadPublicConfig = () => loadHttpServerConfig(publicEnvironment);
    const loadInvalidHostConfig = () =>
      loadHttpServerConfig(invalidHostEnvironment);

    // Assert
    expect(loopbackConfig.allowUnauthenticated).toBe(true);
    expect(loadPublicConfig).toThrow(/loopback/);
    expect(loadInvalidHostConfig).toThrow(/Invalid HTTP server host/);
  });

  it('loads secure resource and egress defaults', () => {
    // Arrange
    const environment = { GITINGEST_MCP_API_KEY: 'test-api-key' };

    // Act
    const config = loadHttpServerConfig(environment);

    // Assert
    expect(config.remoteRepositoryHosts).toEqual([
      'github.com',
      'gitlab.com',
      'bitbucket.org',
    ]);
    expect(config.sessionTtlMs).toBe(15 * 60_000);
    expect(config.maxConcurrentIngestions).toBe(4);
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.allowSubmodules).toBe(false);
  });

  it('normalizes remote host allowlists and rejects invalid entries', () => {
    // Arrange
    const validEnvironment = {
      GITINGEST_MCP_API_KEY: 'test-api-key',
      GITINGEST_MCP_REMOTE_HOSTS: '*.Example.COM.,münich.example,::1',
    };
    const invalidEnvironments = [
      {
        GITINGEST_MCP_API_KEY: 'test-api-key',
        GITINGEST_MCP_REMOTE_HOSTS: '*.*.example.com',
      },
      {
        GITINGEST_MCP_API_KEY: 'test-api-key',
        GITINGEST_MCP_REMOTE_HOSTS: '*.127.0.0.1',
      },
      {
        GITINGEST_MCP_API_KEY: 'test-api-key',
        GITINGEST_MCP_REMOTE_HOSTS: 'https://example.com',
      },
    ];

    // Act
    const validConfig = loadHttpServerConfig(validEnvironment);
    const invalidActions = invalidEnvironments.map(
      (environment) => () => loadHttpServerConfig(environment)
    );

    // Assert
    expect(validConfig.remoteRepositoryHosts).toEqual([
      '*.example.com',
      'xn--mnich-kva.example',
      '::1',
    ]);
    for (const action of invalidActions) {
      expect(action).toThrow(/Invalid remote repository host/);
    }
  });

  it('rejects invalid numeric resource configuration', () => {
    // Arrange
    const environments = [
      { GITINGEST_MCP_API_KEY: 'key', GITINGEST_MCP_MAX_SESSIONS: '0' },
      {
        GITINGEST_MCP_API_KEY: 'key',
        GITINGEST_MCP_SESSION_TTL: '999',
      },
      {
        GITINGEST_MCP_API_KEY: 'key',
        GITINGEST_MCP_MAX_CONCURRENT_INGESTIONS: '1.5',
      },
      { GITINGEST_MCP_API_KEY: 'key', GITINGEST_MCP_RATE_LIMIT: 'NaN' },
    ];

    // Act
    const actions = environments.map(
      (environment) => () => loadHttpServerConfig(environment)
    );

    // Assert
    for (const action of actions) {
      expect(action).toThrow(/Expected an integer/);
    }
  });

  it('rejects requests with no API key', async () => {
    // Arrange
    const app = createTestApp();

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {},
    });

    // Assert
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('initializes an authenticated session and publishes the complete schema', async () => {
    // Arrange
    const app = createTestApp();
    const commonHeaders = {
      authorization: 'Bearer test-api-key',
      accept: 'application/json, text/event-stream',
      host: 'localhost',
    };

    // Act
    const initializeResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: commonHeaders,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
    });
    const sessionId = initializeResponse.headers['mcp-session-id'];
    const toolsResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...commonHeaders,
        'mcp-session-id': String(sessionId),
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const toolsBody = toolsResponse.json();

    // Assert
    expect(initializeResponse.statusCode).toBe(200);
    expect(sessionId).toBeTypeOf('string');
    expect(toolsResponse.statusCode).toBe(200);
    expect(toolsBody.result.tools[0].inputSchema.properties).toHaveProperty(
      'maxTokens'
    );
    expect(toolsBody.result.tools[0].inputSchema.properties).toHaveProperty(
      'tokenizer'
    );
  });

  it('expires idle sessions', async () => {
    // Arrange
    const app = createTestApp({ sessionTtlMs: 10 });
    const initializeResponse = await initializeSession(app);
    const sessionId = String(initializeResponse.headers['mcp-session-id']);

    // Act
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: authenticatedHeaders({ 'mcp-session-id': sessionId }),
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Unknown MCP session' });
  });

  it('does not expire a session while an ingestion request is active', async () => {
    // Arrange
    const repositoryPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-http-'));
    cleanupPaths.push(repositoryPath);
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        fs.writeFile(join(repositoryPath, `file-${index}.txt`), 'content')
      )
    );
    const app = createTestApp({
      localRepositoryRoots: [repositoryPath],
      sessionTtlMs: 10,
    });
    const initializeResponse = await initializeSession(app);
    const sessionId = String(initializeResponse.headers['mcp-session-id']);
    const sessionHeaders = authenticatedHeaders({
      'mcp-session-id': sessionId,
    });

    // Act
    const ingestionResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: sessionHeaders,
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ingest_repository',
          arguments: {
            repository: repositoryPath,
            maxFiles: 200,
            maxEntries: 500,
          },
        },
      },
    });
    const followUpResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: sessionHeaders,
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });

    // Assert
    expect(ingestionResponse.statusCode).toBe(200);
    expect(ingestionResponse.json().result.isError).toBeUndefined();
    expect(followUpResponse.statusCode).toBe(200);
    expect(followUpResponse.json().result.tools).toHaveLength(1);
  });

  it('enforces the session limit', async () => {
    // Arrange
    const app = createTestApp({ maxSessions: 1 });
    const firstSession = await initializeSession(app, 1);

    // Act
    const secondSession = await initializeSession(app, 2);

    // Assert
    expect(firstSession.statusCode).toBe(200);
    expect(secondSession.statusCode).toBe(503);
    expect(secondSession.json()).toEqual({
      error: 'MCP session limit reached',
    });
  });

  it('rejects missing and unknown session identifiers consistently', async () => {
    // Arrange
    const app = createTestApp();

    // Act
    const missingSessionResponse = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: authenticatedHeaders(),
    });
    const unknownSessionResponse = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: authenticatedHeaders({
        'mcp-session-id': '00000000-0000-4000-8000-000000000000',
      }),
    });

    // Assert
    expect(missingSessionResponse.statusCode).toBe(400);
    expect(missingSessionResponse.json()).toEqual({
      error: 'Missing MCP session ID',
    });
    expect(unknownSessionResponse.statusCode).toBe(404);
    expect(unknownSessionResponse.json()).toEqual({
      error: 'Unknown MCP session',
    });
  });

  it('rate limits repeated authentication attempts', async () => {
    // Arrange
    const app = createTestApp({ rateLimitPerMinute: 1 });

    // Act
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {},
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {},
    });

    // Assert
    expect(firstResponse.statusCode).toBe(401);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers['retry-after']).toBeDefined();
  });

  function createTestApp(overrides: Partial<HttpServerConfig> = {}) {
    const config: HttpServerConfig = {
      host: '127.0.0.1',
      port: 3000,
      apiKey: 'test-api-key',
      allowUnauthenticated: false,
      allowedHosts: ['localhost'],
      allowedOrigins: [],
      localRepositoryRoots: [],
      remoteRepositoryHosts: ['github.com', 'gitlab.com', 'bitbucket.org'],
      allowSubmodules: false,
      maxSessions: 10,
      sessionTtlMs: 60_000,
      maxConcurrentIngestions: 2,
      rateLimitPerMinute: 100,
      bodyLimit: 1024 * 1024,
      logger: false,
      ...overrides,
    };
    const app = createHttpApp(config);
    apps.push(app);
    return app;
  }

  async function initializeSession(
    app: ReturnType<typeof createHttpApp>,
    id = 1
  ) {
    return await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: authenticatedHeaders(),
      payload: {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
    });
  }

  function authenticatedHeaders(
    additionalHeaders: Record<string, string> = {}
  ) {
    return {
      authorization: 'Bearer test-api-key',
      accept: 'application/json, text/event-stream',
      host: 'localhost',
      ...additionalHeaders,
    };
  }
});
