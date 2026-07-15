#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { delimiter } from 'node:path';
import { domainToASCII } from 'node:url';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { createMcpServer } from './create-server.js';
import { isMainModule } from './is-main-module.js';
import { OperationLimiter } from './operation-limiter.js';

const DEFAULT_REMOTE_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

export interface HttpServerConfig {
  host: string;
  port: number;
  apiKey?: string;
  allowUnauthenticated: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  localRepositoryRoots: string[];
  remoteRepositoryHosts: string[];
  allowSubmodules: boolean;
  maxSessions: number;
  sessionTtlMs: number;
  maxConcurrentIngestions: number;
  rateLimitPerMinute: number;
  bodyLimit: number;
  logger?: boolean;
}

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: Server;
  activeRequests: number;
  expiresAt: number;
  expirationTimer: NodeJS.Timeout;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function loadHttpServerConfig(
  environment: NodeJS.ProcessEnv = process.env
): HttpServerConfig {
  const host = normalizeServerHost(
    environment.GITINGEST_MCP_HOST ?? '127.0.0.1'
  );
  const port = parseInteger(environment.GITINGEST_MCP_PORT, 3000, 1, 65_535);
  const apiKey = environment.GITINGEST_MCP_API_KEY?.trim() || undefined;
  const allowUnauthenticated =
    environment.GITINGEST_MCP_ALLOW_UNAUTHENTICATED === 'true';

  if (!apiKey && !allowUnauthenticated) {
    throw new Error(
      'GITINGEST_MCP_API_KEY is required for HTTP transport. Set GITINGEST_MCP_ALLOW_UNAUTHENTICATED=true only for local development.'
    );
  }
  if (!apiKey && !isLoopbackHost(host)) {
    throw new Error('Unauthenticated HTTP transport may bind only to loopback');
  }

  const allowedHosts = parseList(environment.GITINGEST_MCP_ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    const hostHeader = isIP(host) === 6 ? `[${host}]` : host;
    allowedHosts.push(hostHeader, `${hostHeader}:${port}`);
    if (isLoopbackHost(host)) {
      allowedHosts.push(
        'localhost',
        `localhost:${port}`,
        '127.0.0.1',
        `127.0.0.1:${port}`,
        '[::1]',
        `[::1]:${port}`
      );
    }
  }

  const configuredRemoteHosts = environment.GITINGEST_MCP_REMOTE_HOSTS;

  return {
    host,
    port,
    apiKey,
    allowUnauthenticated,
    allowedHosts: [...new Set(allowedHosts)],
    allowedOrigins: parseList(environment.GITINGEST_MCP_ALLOWED_ORIGINS),
    localRepositoryRoots: parseList(
      environment.GITINGEST_MCP_LOCAL_ROOTS,
      delimiter
    ),
    remoteRepositoryHosts:
      configuredRemoteHosts === undefined
        ? [...DEFAULT_REMOTE_HOSTS]
        : parseRemoteHosts(configuredRemoteHosts),
    allowSubmodules: environment.GITINGEST_MCP_ALLOW_SUBMODULES === 'true',
    maxSessions: parseInteger(
      environment.GITINGEST_MCP_MAX_SESSIONS,
      100,
      1,
      10_000
    ),
    sessionTtlMs: parseInteger(
      environment.GITINGEST_MCP_SESSION_TTL,
      15 * 60_000,
      1000,
      24 * 60 * 60_000
    ),
    maxConcurrentIngestions: parseInteger(
      environment.GITINGEST_MCP_MAX_CONCURRENT_INGESTIONS,
      4,
      1,
      1000
    ),
    rateLimitPerMinute: parseInteger(
      environment.GITINGEST_MCP_RATE_LIMIT,
      120,
      1,
      100_000
    ),
    bodyLimit: parseInteger(
      environment.GITINGEST_MCP_BODY_LIMIT,
      1024 * 1024,
      1024,
      10 * 1024 * 1024
    ),
    logger: true,
  };
}

export function createHttpApp(config: HttpServerConfig): FastifyInstance {
  const app = fastify({
    bodyLimit: config.bodyLimit,
    logger:
      config.logger === false
        ? false
        : {
            redact: ['req.headers.authorization', 'req.headers.x-api-key'],
          },
  });
  const sessions = new Map<string, SessionRecord>();
  const rateLimits = new Map<string, RateLimitRecord>();
  const operationLimiter = new OperationLimiter(config.maxConcurrentIngestions);
  let pendingInitializations = 0;

  const removeSession = (sessionId: string): SessionRecord | undefined => {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    sessions.delete(sessionId);
    clearTimeout(session.expirationTimer);
    return session;
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = removeSession(sessionId);
    if (!session) return;
    await session.transport.close().catch(() => undefined);
  };

  const scheduleSessionExpiration = (
    sessionId: string,
    session: Omit<SessionRecord, 'expiresAt' | 'expirationTimer'>
  ): SessionRecord => {
    const expiresAt = Date.now() + config.sessionTtlMs;
    const expirationTimer = setTimeout(() => {
      void closeSession(sessionId);
    }, config.sessionTtlMs);
    expirationTimer.unref();
    if (session.activeRequests > 0) {
      clearTimeout(expirationTimer);
    }
    return { ...session, expiresAt, expirationTimer };
  };

  const touchSession = (sessionId: string, session: SessionRecord): void => {
    clearTimeout(session.expirationTimer);
    sessions.set(
      sessionId,
      scheduleSessionExpiration(sessionId, {
        transport: session.transport,
        server: session.server,
        activeRequests: session.activeRequests,
      })
    );
  };

  const getActiveSession = async (
    sessionId: string
  ): Promise<SessionRecord | undefined> => {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    if (session.activeRequests === 0 && session.expiresAt <= Date.now()) {
      await closeSession(sessionId);
      return undefined;
    }
    return session;
  };

  const handleActiveSessionRequest = async (
    sessionId: string,
    session: SessionRecord,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    clearTimeout(session.expirationTimer);
    session.activeRequests += 1;
    try {
      await handleTransportRequest(session.transport, request, reply);
    } finally {
      const activeSession = sessions.get(sessionId);
      if (activeSession === session) {
        activeSession.activeRequests = Math.max(
          0,
          activeSession.activeRequests - 1
        );
        if (activeSession.activeRequests === 0) {
          touchSession(sessionId, activeSession);
        }
      }
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    const rateLimit = consumeRateLimit(
      rateLimits,
      request.ip,
      config.rateLimitPerMinute,
      Date.now()
    );
    if (!rateLimit.allowed) {
      reply.header('retry-after', String(rateLimit.retryAfterSeconds));
      return reply.status(429).send({ error: 'Rate limit exceeded' });
    }

    if (isAuthorized(request, config)) return;

    reply.header('www-authenticate', 'Bearer realm="gitingest-mcp"');
    return reply.status(401).send({ error: 'Unauthorized' });
  });

  app.post('/mcp', async (request, reply) => {
    const sessionId = getSessionId(request);
    if (sessionId) {
      const session = await getActiveSession(sessionId);
      if (!session) {
        await reply.status(404).send({ error: 'Unknown MCP session' });
        return;
      }
      await handleActiveSessionRequest(sessionId, session, request, reply);
      return;
    }

    if (!isInitializeRequest(request.body)) {
      await reply.status(400).send({ error: 'Expected an initialize request' });
      return;
    }

    if (sessions.size + pendingInitializations >= config.maxSessions) {
      await reply.status(503).send({ error: 'MCP session limit reached' });
      return;
    }

    pendingInitializations += 1;
    let registeredSessionId: string | undefined;
    const server = createMcpServer({
      allowUnrestrictedLocalRepositories: false,
      allowedLocalRoots: config.localRepositoryRoots,
      allowUnrestrictedRemoteRepositories: false,
      allowedRemoteHosts: config.remoteRepositoryHosts,
      allowInsecureRemoteRepositories: false,
      allowSubmodules: config.allowSubmodules,
      operationLimiter,
    });
    const transportOptions: StreamableHTTPServerTransportOptions = {
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      allowedHosts: config.allowedHosts,
      allowedOrigins:
        config.allowedOrigins.length > 0 ? config.allowedOrigins : undefined,
      enableDnsRebindingProtection: true,
      onsessioninitialized: (initializedSessionId) => {
        registeredSessionId = initializedSessionId;
        sessions.set(
          initializedSessionId,
          scheduleSessionExpiration(initializedSessionId, {
            transport,
            server,
            activeRequests: 1,
          })
        );
      },
    };
    const transport = new StreamableHTTPServerTransport(transportOptions);
    transport.onclose = () => {
      if (registeredSessionId) {
        removeSession(registeredSessionId);
      }
    };

    try {
      await server.connect(transport);
      await handleTransportRequest(transport, request, reply);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      pendingInitializations -= 1;
      if (!registeredSessionId) {
        await transport.close().catch(() => undefined);
      } else {
        const session = sessions.get(registeredSessionId);
        if (session) {
          session.activeRequests = Math.max(0, session.activeRequests - 1);
          if (session.activeRequests === 0) {
            touchSession(registeredSessionId, session);
          }
        }
      }
    }
  });

  app.get('/mcp', async (request, reply) => {
    await handleExistingSession(
      getActiveSession,
      handleActiveSessionRequest,
      request,
      reply
    );
  });

  app.delete('/mcp', async (request, reply) => {
    await handleExistingSession(
      getActiveSession,
      handleActiveSessionRequest,
      request,
      reply
    );
  });

  app.addHook('onClose', async () => {
    const sessionIds = [...sessions.keys()];
    await Promise.all(sessionIds.map((sessionId) => closeSession(sessionId)));
    sessions.clear();
    rateLimits.clear();
  });

  return app;
}

export async function startHttpServer(
  config = loadHttpServerConfig()
): Promise<void> {
  const app = createHttpApp(config);
  await app.listen({ host: config.host, port: config.port });
}

async function handleExistingSession(
  getActiveSession: (sessionId: string) => Promise<SessionRecord | undefined>,
  handleActiveSessionRequest: (
    sessionId: string,
    session: SessionRecord,
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<void>,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const sessionId = getSessionId(request);
  if (!sessionId) {
    await reply.status(400).send({ error: 'Missing MCP session ID' });
    return;
  }

  const session = await getActiveSession(sessionId);
  if (!session) {
    await reply.status(404).send({ error: 'Unknown MCP session' });
    return;
  }

  await handleActiveSessionRequest(sessionId, session, request, reply);
}

async function handleTransportRequest(
  transport: StreamableHTTPServerTransport,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw, request.body);
}

function getSessionId(request: FastifyRequest): string | undefined {
  const value = request.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(
  request: FastifyRequest,
  config: HttpServerConfig
): boolean {
  if (!config.apiKey) {
    return config.allowUnauthenticated;
  }

  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
  const apiKeyHeader = request.headers['x-api-key'];
  const provided =
    bearer ?? (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader);

  return provided ? safeEqual(provided, config.apiKey) : false;
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function consumeRateLimit(
  records: Map<string, RateLimitRecord>,
  key: string,
  maximumRequests: number,
  now: number
): { allowed: boolean; retryAfterSeconds: number } {
  let record = records.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + 60_000 };
    records.set(key, record);
  }

  if (record.count >= maximumRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
  }

  record.count += 1;
  if (records.size > 10_000) {
    const oldestKey = records.keys().next().value as string | undefined;
    if (oldestKey !== undefined) records.delete(oldestKey);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function parseList(value?: string, separator = ','): string[] {
  return (value ?? '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRemoteHosts(value: string): string[] {
  return parseList(value).map((host) => {
    const wildcard = host.startsWith('*.');
    const rawHost = (wildcard ? host.slice(2) : host)
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    const normalizedHost = domainToASCII(rawHost).toLowerCase();
    const validDomain = isValidDomain(normalizedHost);
    if (
      (!validDomain && isIP(rawHost) === 0) ||
      (wildcard && isIP(rawHost) > 0)
    ) {
      throw new Error(`Invalid remote repository host: ${host}`);
    }
    return `${wildcard ? '*.' : ''}${isIP(rawHost) > 0 ? rawHost.toLowerCase() : normalizedHost}`;
  });
}

function normalizeServerHost(value: string): string {
  const rawHost = value
    .trim()
    .replace(/^\[([^\]]+)\]$/, '$1')
    .replace(/\.$/, '');
  if (isIP(rawHost) > 0) return rawHost.toLowerCase();

  const normalizedHost = domainToASCII(rawHost).toLowerCase();
  if (!isValidDomain(normalizedHost)) {
    throw new Error(`Invalid HTTP server host: ${value}`);
  }
  return normalizedHost;
}

function isValidDomain(host: string): boolean {
  return (
    host.length <= 253 &&
    host
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      )
  );
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(
    host.toLowerCase()
  );
}

if (isMainModule(import.meta.url)) {
  startHttpServer().catch((error) => {
    console.error('HTTP server error:', error);
    process.exitCode = 1;
  });
}
