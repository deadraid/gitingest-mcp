import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import { z } from 'zod';

export const repositorySourceSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'local',
  'git',
]);

export type RepositorySource = z.infer<typeof repositorySourceSchema>;

export const repositoryUrlSchema = z.object({
  url: z.string(),
  cloneUrl: z.string().optional(),
  type: repositorySourceSchema.optional(),
  host: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  tag: z.string().optional(),
  subpath: z.string().optional(),
  transport: z.enum(['local', 'https', 'http', 'ssh', 'git']),
  isLocal: z.boolean(),
});

export type RepositoryUrl = z.infer<typeof repositoryUrlSchema>;

type HostedSource = Exclude<RepositorySource, 'local' | 'git'>;

interface HostedProvider {
  type: HostedSource;
  host: string;
  webRoutes: string[];
}

const hostedProviders: HostedProvider[] = [
  {
    type: 'github',
    host: 'github.com',
    webRoutes: ['tree', 'blob'],
  },
  {
    type: 'gitlab',
    host: 'gitlab.com',
    webRoutes: ['tree', 'blob'],
  },
  {
    type: 'bitbucket',
    host: 'bitbucket.org',
    webRoutes: ['src', 'browse'],
  },
];

const supportedProtocols = new Set(['http:', 'https:', 'ssh:', 'git:']);
const scpLikeUrlPattern =
  /^(?<username>[a-zA-Z0-9][a-zA-Z0-9._-]*)@(?<host>(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)|\[[a-fA-F0-9:]+\]):(?<path>[^\s]+)$/;

export class GitUrlParser {
  static parse(input: string, forcedSource?: RepositorySource): RepositoryUrl {
    const value = input.trim();
    if (!value) {
      throw new Error('Repository must not be empty');
    }
    if (hasControlCharacter(value)) {
      throw new Error('Repository URLs and paths must not contain controls');
    }

    if (
      forcedSource === 'local' ||
      (!forcedSource && this.isExplicitLocalPath(value))
    ) {
      return {
        url: value,
        type: 'local',
        transport: 'local',
        isLocal: true,
      };
    }

    const shorthand = value.match(/^([^/\s:]+)\/([^/\s]+)$/);
    if (shorthand) {
      const owner = shorthand[1];
      const repository = shorthand[2];
      if (!owner || !repository) {
        throw new Error('Invalid repository shorthand');
      }
      const source: HostedSource =
        forcedSource && forcedSource !== 'git' ? forcedSource : 'github';
      return this.fromShorthand(value, source, owner, repository);
    }

    const scpMatch = value.match(scpLikeUrlPattern);
    if (scpMatch?.groups) {
      const host = scpMatch.groups.host;
      if (!host) throw new Error('Invalid SSH repository host');
      return this.fromScpLikeUrl(value, forcedSource, host);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(value);
    } catch {
      throw new Error(
        'Unsupported repository URL. Use an explicit HTTP(S), SSH, git:// URL, owner/repository shorthand, or an explicit local path'
      );
    }

    if (!supportedProtocols.has(parsedUrl.protocol)) {
      throw new Error(`Unsupported Git transport: ${parsedUrl.protocol}`);
    }
    this.assertNoEmbeddedCredentials(parsedUrl);
    if (parsedUrl.protocol === 'ssh:') {
      this.assertSafeSshPath(parsedUrl.pathname);
    }

    const host = normalizeHost(parsedUrl.hostname);
    const provider = hostedProviders.find((item) => item.host === host);
    if (provider) {
      this.assertCompatibleSource(provider.type, forcedSource);
      return this.fromHostedUrl(value, parsedUrl, provider);
    }

    if (forcedSource && forcedSource !== 'git') {
      throw new Error(
        `Repository URL does not match the requested source: ${forcedSource}`
      );
    }

    if (!host || parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
      throw new Error(
        'Generic Git URLs must include a host and repository path'
      );
    }

    return {
      url: value,
      cloneUrl: value,
      type: 'git',
      host,
      transport: parsedUrl.protocol.slice(0, -1) as
        'https' | 'http' | 'ssh' | 'git',
      isLocal: false,
    };
  }

  static toCloneUrl(parsed: RepositoryUrl): string {
    return parsed.cloneUrl ?? parsed.url;
  }

  /** @deprecated Use toCloneUrl; SSH URLs intentionally remain SSH URLs. */
  static toHttpsUrl(parsed: RepositoryUrl): string {
    return this.toCloneUrl(parsed);
  }

  static authUsername(source?: RepositorySource): string {
    switch (source) {
      case 'github':
        return 'x-access-token';
      case 'gitlab':
        return 'oauth2';
      case 'bitbucket':
        return 'x-token-auth';
      default:
        return 'oauth2';
    }
  }

  static displayUrl(parsed: RepositoryUrl): string {
    return parsed.url.replace(/[\r\n\t]/g, ' ');
  }

  static toApiUrl(parsed: RepositoryUrl): string {
    if (parsed.isLocal) return parsed.url;

    switch (parsed.type) {
      case 'github':
        return `https://api.github.com/repos/${encodeURIComponent(
          parsed.owner ?? ''
        )}/${encodeURIComponent(parsed.repo ?? '')}`;
      case 'gitlab':
        return `https://gitlab.com/api/v4/projects/${encodeURIComponent(
          `${parsed.owner}/${parsed.repo}`
        )}`;
      case 'bitbucket':
        return `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(
          parsed.owner ?? ''
        )}/${encodeURIComponent(parsed.repo ?? '')}`;
      default:
        throw new Error(`API not supported for type: ${parsed.type}`);
    }
  }

  private static fromShorthand(
    originalUrl: string,
    type: HostedSource,
    owner: string,
    repository: string
  ): RepositoryUrl {
    const provider = hostedProviders.find((item) => item.type === type)!;
    const { owner: parsedOwner, repo } = this.parseHostedRepositoryPath(
      `${owner}/${repository}`,
      provider
    );
    const encodedPath = encodeHostedPath(parsedOwner, repo);
    return {
      url: originalUrl,
      cloneUrl: `https://${provider.host}/${encodedPath}.git`,
      type,
      host: provider.host,
      owner: parsedOwner,
      repo,
      transport: 'https',
      isLocal: false,
    };
  }

  private static fromScpLikeUrl(
    originalUrl: string,
    forcedSource: RepositorySource | undefined,
    rawHost: string
  ): RepositoryUrl {
    const host = normalizeHost(rawHost.replace(/^\[|\]$/g, ''));
    const path = originalUrl.slice(originalUrl.indexOf(':') + 1);
    this.assertSafeSshPath(path);
    const provider = hostedProviders.find((item) => item.host === host);

    if (provider) {
      this.assertCompatibleSource(provider.type, forcedSource);
      const { owner, repo } = this.parseHostedRepositoryPath(path, provider);
      return {
        url: originalUrl,
        cloneUrl: originalUrl,
        type: provider.type,
        host,
        owner,
        repo,
        transport: 'ssh',
        isLocal: false,
      };
    }

    if (forcedSource && forcedSource !== 'git') {
      throw new Error(
        `Repository URL does not match the requested source: ${forcedSource}`
      );
    }

    return {
      url: originalUrl,
      cloneUrl: originalUrl,
      type: 'git',
      host,
      transport: 'ssh',
      isLocal: false,
    };
  }

  private static fromHostedUrl(
    originalUrl: string,
    parsedUrl: URL,
    provider: HostedProvider
  ): RepositoryUrl {
    if (parsedUrl.search || parsedUrl.hash) {
      throw new Error(
        'Canonical repository URLs must not contain a query string or fragment'
      );
    }
    if (parsedUrl.port) {
      throw new Error(
        'Canonical hosted repository URLs must use the provider default port'
      );
    }

    const path = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
    const pathSegments = path.split('/').filter(Boolean);
    const isBrowsingUrl =
      provider.type === 'gitlab'
        ? pathSegments.includes('-')
        : provider.webRoutes.includes(pathSegments[2] ?? '');
    if (isBrowsingUrl) {
      throw new Error(
        'Repository browsing URLs are ambiguous. Use the canonical clone URL and pass branch/tag/commit and subpath as separate arguments'
      );
    }

    const { owner, repo } = this.parseHostedRepositoryPath(path, provider);
    const isSsh = parsedUrl.protocol === 'ssh:';
    const encodedPath = encodeHostedPath(owner, repo);
    return {
      url: originalUrl,
      cloneUrl: isSsh
        ? originalUrl
        : `${parsedUrl.protocol}//${provider.host}/${encodedPath}.git`,
      type: provider.type,
      host: provider.host,
      owner,
      repo,
      transport: parsedUrl.protocol.slice(0, -1) as
        'https' | 'http' | 'ssh' | 'git',
      isLocal: false,
    };
  }

  private static parseHostedRepositoryPath(
    rawPath: string,
    provider: HostedProvider
  ): { owner: string; repo: string } {
    const segments = rawPath
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      throw new Error(`Invalid ${provider.type} repository path`);
    }
    if (provider.type !== 'gitlab' && segments.length !== 2) {
      throw new Error(`Invalid ${provider.type} repository path`);
    }

    const decodedSegments = segments.map((segment) =>
      this.decodeHostedPathSegment(segment, provider)
    );
    const repo = decodedSegments.pop()!.replace(/\.git$/, '');
    const owner = decodedSegments.join('/');
    if (!repo || !owner) {
      throw new Error(`Invalid ${provider.type} repository path`);
    }
    return { owner, repo };
  }

  private static decodeHostedPathSegment(
    segment: string,
    provider: HostedProvider
  ): string {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid ${provider.type} repository path encoding`);
    }

    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('?') ||
      decoded.includes('#') ||
      !/^[\p{L}\p{N}._+-]+$/u.test(decoded) ||
      [...decoded].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x20 || codePoint === 0x7f;
      })
    ) {
      throw new Error(`Invalid ${provider.type} repository path`);
    }

    return decoded;
  }

  private static assertCompatibleSource(
    detected: HostedSource,
    forcedSource?: RepositorySource
  ): void {
    if (forcedSource && forcedSource !== 'git' && forcedSource !== detected) {
      throw new Error(
        `Repository host is ${detected}, but source was forced to ${forcedSource}`
      );
    }
  }

  private static assertNoEmbeddedCredentials(url: URL): void {
    if (url.password || (url.protocol !== 'ssh:' && url.username)) {
      throw new Error(
        'Credentials in repository URLs are not allowed; use the token parameter instead'
      );
    }
    if (url.protocol === 'ssh:' && url.username) {
      let username: string;
      try {
        username = decodeURIComponent(url.username);
      } catch {
        throw new Error('Invalid SSH username encoding');
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(username)) {
        throw new Error('Invalid SSH username');
      }
    }
  }

  private static assertSafeSshPath(path: string): void {
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');
    if (!normalizedPath || !/^[a-zA-Z0-9._~+%/-]+$/.test(normalizedPath)) {
      throw new Error('Invalid SSH repository path');
    }

    for (const segment of normalizedPath.split('/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new Error('Invalid SSH repository path encoding');
      }
      if (
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('/') ||
        !/^[\p{L}\p{N}._~+%-]+$/u.test(decoded)
      ) {
        throw new Error('Invalid SSH repository path');
      }
    }
  }

  private static isExplicitLocalPath(path: string): boolean {
    return (
      path.startsWith('/') ||
      path === '~' ||
      path.startsWith('~/') ||
      path.startsWith('~\\') ||
      path.startsWith('./') ||
      path.startsWith('../') ||
      path === '.' ||
      path.startsWith('\\\\') ||
      /^[a-zA-Z]:[\\/]/.test(path)
    );
  }
}

function normalizeHost(host: string): string {
  const rawHost = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(rawHost) > 0) return rawHost;

  const normalizedHost = domainToASCII(rawHost).toLowerCase();
  const valid =
    normalizedHost.length <= 253 &&
    normalizedHost
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      );
  if (!valid) {
    throw new Error(`Invalid repository host: ${host}`);
  }
  return normalizedHost;
}

function encodeHostedPath(owner: string, repo: string): string {
  return [...owner.split('/'), repo].map(encodeURIComponent).join('/');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
