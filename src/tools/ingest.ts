import { isAbsolute, relative, sep } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tiktoken } from 'js-tiktoken/lite';

import type {
  RepositoryFile,
  RepositorySummary,
  TreeNode,
} from '../types/index.js';
import {
  abortableDelay,
  buildTree,
  countDirectories,
  estimateTokens,
  formatBytes,
  isAbortError,
  renderTree,
  throwIfAborted,
} from '../utils/index.js';
import {
  isValidGitCommit,
  isValidNamedGitReference,
} from '../utils/git-reference.js';
import {
  countTextTokens,
  decodeCompleteTokenPrefix,
  encodeText,
  getTokenizer,
  tokenizerEncodings,
  type TokenizerEncoding,
} from '../utils/tokenizer.js';
import { FilterEngine } from './filter-engine.js';
import { GitCloneTool, type GitCloneResult } from './git-clone.js';
import { LocalRepositoryTool } from './local-repository.js';
import { collectRepositoryFiles } from './repository-reader.js';
import { GitUrlParser, repositorySourceSchema } from './url-parser.js';

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_PATTERN_COUNT = 1000;
const MAX_FILES = 10_000;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 256;
const DEFAULT_MAX_TOKENS = 250_000;
const MAX_TOKENS = 1_000_000;
const TOKENIZATION_CHUNK_SIZE = 64 * 1024;
const MAX_RENDERED_TREE_CHARACTERS = 4 * 1024 * 1024;

const patternSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (pattern) =>
      pattern !== '!' &&
      !hasCharacterInRange(pattern, 0, 0x1f) &&
      !pattern.includes(String.fromCodePoint(0x7f)),
    'Glob patterns must not be a lone negation or contain controls'
  );
const patternsSchema = z.array(patternSchema).max(MAX_PATTERN_COUNT).optional();
const gitNamedReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(isValidNamedGitReference, 'Invalid Git branch or tag name');
const gitCommitSchema = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .refine(isValidGitCommit, 'commit must be a hexadecimal object ID');
const repositorySubpathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((subpath) => {
    const normalizedPath = subpath.replaceAll('\\', '/');
    return (
      !normalizedPath.startsWith('/') &&
      !normalizedPath.split('/').includes('..') &&
      !hasCharacterInRange(normalizedPath, 0, 0x1f) &&
      !normalizedPath.includes(String.fromCodePoint(0x7f))
    );
  }, 'subpath must stay inside the repository');

const ingestShape = {
  repository: z.string().trim().min(1).max(4096),
  source: repositorySourceSchema.optional(),
  branch: gitNamedReferenceSchema.optional(),
  commit: gitCommitSchema.optional(),
  tag: gitNamedReferenceSchema.optional(),
  subpath: repositorySubpathSchema.optional(),
  cloneDepth: z.number().int().min(1).max(1000).default(1),
  sparseCheckout: z.boolean().default(false),
  includeSubmodules: z.boolean().default(false),
  includeGitignored: z.boolean().default(false),
  useGitignore: z.boolean().default(true),
  useGitingestignore: z.boolean().default(true),
  excludePatterns: patternsSchema,
  includePatterns: patternsSchema,
  maxFileSize: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE)
    .default(10 * 1024 * 1024),
  maxFiles: z.number().int().min(1).max(MAX_FILES).default(1000),
  maxEntries: z.number().int().min(1).max(MAX_ENTRIES).default(25_000),
  maxDepth: z.number().int().min(1).max(MAX_DEPTH).default(128),
  maxTotalSize: z
    .number()
    .int()
    .positive()
    .max(MAX_TOTAL_SIZE)
    .default(50 * 1024 * 1024),
  maxTokens: z
    .number()
    .int()
    .positive()
    .max(MAX_TOKENS)
    .default(DEFAULT_MAX_TOKENS),
  tokenizer: z.enum(tokenizerEncodings).default('o200k_base'),
  token: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (token) =>
        !hasCharacterInRange(token, 0, 0x1f) &&
        !token.includes(String.fromCodePoint(0x7f)),
      'token must not contain control characters'
    )
    .optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelay: z.number().int().min(0).max(60_000).default(1000),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(30 * 60_000)
    .default(30_000),
} satisfies z.ZodRawShape;

function validateIngestInput(
  value: {
    branch?: string;
    commit?: string;
    tag?: string;
    sparseCheckout: boolean;
    subpath?: string;
  },
  context: z.RefinementCtx
): void {
  const refs = [value.branch, value.commit, value.tag].filter(Boolean);
  if (refs.length > 1) {
    context.addIssue({
      code: 'custom',
      path: ['branch'],
      message: 'Only one of branch, commit, or tag may be specified',
    });
  }

  if (value.sparseCheckout && !value.subpath) {
    context.addIssue({
      code: 'custom',
      path: ['subpath'],
      message: 'subpath is required when sparseCheckout is enabled',
    });
  }

  if (value.subpath && !value.sparseCheckout) {
    context.addIssue({
      code: 'custom',
      path: ['sparseCheckout'],
      message: 'sparseCheckout must be enabled when subpath is specified',
    });
  }
}

export const ingestPublicSchema = z
  .object(ingestShape)
  .superRefine(validateIngestInput);

export const ingestSchema = z
  .object({
    ...ingestShape,
    signal: z.custom<AbortSignal>().optional(),
  })
  .superRefine(validateIngestInput);

export type IngestInput = z.input<typeof ingestSchema>;

export interface IngestRuntimeOptions {
  signal?: AbortSignal;
  allowUnrestrictedLocalRepositories?: boolean;
  allowedLocalRoots?: string[];
  allowUnrestrictedRemoteRepositories?: boolean;
  allowedRemoteHosts?: string[];
  allowInsecureRemoteRepositories?: boolean;
  allowSubmodules?: boolean;
}

export type IngestToolResult = CallToolResult;

export async function ingestTool(
  input: IngestInput,
  runtime: IngestRuntimeOptions = {}
): Promise<IngestToolResult> {
  const parsedInput = ingestSchema.parse(input);
  const abortController = new AbortController();
  const externalSignals = [parsedInput.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal)
  );
  let timedOut = false;
  let cloneResult: GitCloneResult | undefined;

  const externalAbortHandler = (event: Event) => {
    const signal = event.target as AbortSignal;
    abortController.abort(signal.reason);
  };
  for (const signal of externalSignals) {
    if (signal.aborted) {
      abortController.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', externalAbortHandler, { once: true });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort(
      new DOMException(
        `Operation timed out after ${parsedInput.timeout}ms`,
        'AbortError'
      )
    );
  }, parsedInput.timeout);

  try {
    throwIfAborted(abortController.signal);
    const parsedUrl = GitUrlParser.parse(
      parsedInput.repository,
      parsedInput.source
    );
    if (!parsedUrl.isLocal) {
      assertRemoteRepositoryAccess(parsedUrl.host, runtime);
      if (
        runtime.allowInsecureRemoteRepositories === false &&
        (parsedUrl.transport === 'http' || parsedUrl.transport === 'git')
      ) {
        throw new Error(
          'Unencrypted HTTP and git:// repository transports are disabled'
        );
      }
    } else if (
      parsedInput.branch ||
      parsedInput.commit ||
      parsedInput.tag ||
      parsedInput.subpath ||
      parsedInput.sparseCheckout ||
      parsedInput.includeSubmodules ||
      parsedInput.token ||
      parsedInput.cloneDepth !== 1 ||
      parsedInput.maxRetries !== 3 ||
      parsedInput.retryDelay !== 1000
    ) {
      throw new Error(
        'Git refs, clone, sparse-checkout, submodule, retry, and token options are available only for remote repositories'
      );
    }
    if (parsedInput.includeSubmodules && runtime.allowSubmodules === false) {
      throw new Error('Submodule cloning is disabled for this transport');
    }

    let repositoryPath: string;
    let branch: string;
    let commit: string;
    let files: RepositoryFile[];
    let tree: TreeNode;

    if (parsedUrl.isLocal) {
      repositoryPath = await LocalRepositoryTool.resolvePath(parsedUrl.url);
      await assertLocalRepositoryAccess(repositoryPath, runtime);

      const result = await LocalRepositoryTool.analyze(
        {
          path: repositoryPath,
          includeGitignored: parsedInput.includeGitignored,
          useGitignore: parsedInput.useGitignore,
          useGitingestignore: parsedInput.useGitingestignore,
          maxFileSize: parsedInput.maxFileSize,
          maxFiles: parsedInput.maxFiles,
          maxEntries: parsedInput.maxEntries,
          maxDepth: parsedInput.maxDepth,
          expectedCanonicalPath: repositoryPath,
          maxTotalSize: parsedInput.maxTotalSize,
          excludePatterns: parsedInput.excludePatterns,
          includePatterns: parsedInput.includePatterns,
        },
        abortController.signal
      );

      branch = result.summary.branch;
      commit = result.summary.commit;
      files = result.files;
      tree = result.tree;
    } else {
      const cloneUrl = GitUrlParser.toCloneUrl(parsedUrl);
      if (parsedInput.token && !/^https:\/\//i.test(cloneUrl)) {
        throw new Error(
          'The token parameter is supported only for HTTPS repositories; SSH repositories use the configured SSH agent'
        );
      }

      cloneResult = await cloneWithRetries(
        {
          url: cloneUrl,
          branch:
            parsedInput.commit || parsedInput.tag
              ? parsedInput.branch
              : (parsedInput.branch ?? parsedUrl.branch),
          commit: parsedInput.commit,
          tag: parsedInput.tag,
          depth: parsedInput.cloneDepth,
          sparse: parsedInput.sparseCheckout,
          subpath: parsedInput.subpath ?? parsedUrl.subpath,
          includeSubmodules: parsedInput.includeSubmodules,
          auth: parsedInput.token
            ? {
                token: parsedInput.token,
                username: GitUrlParser.authUsername(parsedUrl.type),
              }
            : undefined,
        },
        parsedInput.maxRetries,
        parsedInput.retryDelay,
        abortController.signal
      );

      repositoryPath = cloneResult.path;
      branch = cloneResult.branch;
      commit = cloneResult.commit;

      const filterEngine = new FilterEngine({
        includeGitignored: parsedInput.includeGitignored,
        useGitignore: parsedInput.useGitignore,
        useGitingestignore: parsedInput.useGitingestignore,
        maxFileSize: parsedInput.maxFileSize,
        maxFiles: parsedInput.maxFiles,
        excludePatterns: parsedInput.excludePatterns,
        includePatterns: parsedInput.includePatterns,
      });
      await filterEngine.loadIgnorePatterns(
        repositoryPath,
        abortController.signal
      );

      const readResult = await collectRepositoryFiles(
        repositoryPath,
        filterEngine,
        {
          maxFiles: parsedInput.maxFiles,
          maxFileSize: parsedInput.maxFileSize,
          maxTotalSize: parsedInput.maxTotalSize,
          maxEntries: parsedInput.maxEntries,
          maxDepth: parsedInput.maxDepth,
        },
        abortController.signal
      );
      files = readResult.files;
      tree = buildTree(files);
    }

    const tokenizer = await getTokenizer(parsedInput.tokenizer);
    const summary: RepositorySummary = {
      url: GitUrlParser.displayUrl(parsedUrl),
      source: parsedUrl.type ?? 'git',
      branch,
      commit,
      fileCount: files.length,
      directoryCount: countDirectories(tree),
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      tokenCount: files.reduce(
        (sum, file) => sum + estimateTokens(file.content),
        0
      ),
      createdAt: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: 'text',
          text: await generateTextDigest(
            summary,
            tree,
            files,
            parsedInput.maxTokens,
            parsedInput.tokenizer,
            tokenizer,
            abortController.signal
          ),
        },
      ],
    };
  } catch (error) {
    const message = timedOut
      ? `Operation timed out after ${parsedInput.timeout}ms`
      : isAbortError(error) || abortController.signal.aborted
        ? 'Operation cancelled'
        : `Error ingesting repository: ${error instanceof Error ? error.message : String(error)}`;

    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  } finally {
    clearTimeout(timeoutId);
    for (const signal of externalSignals) {
      signal.removeEventListener('abort', externalAbortHandler);
    }
    if (cloneResult) {
      await GitCloneTool.cleanup(cloneResult.cleanupPath ?? cloneResult.path);
    }
  }
}

function assertRemoteRepositoryAccess(
  repositoryHost: string | undefined,
  runtime: IngestRuntimeOptions
): void {
  if (runtime.allowUnrestrictedRemoteRepositories !== false) {
    return;
  }

  const host = repositoryHost?.toLowerCase().replace(/\.$/, '');
  const allowedHosts = runtime.allowedRemoteHosts ?? [];
  const allowed =
    host &&
    allowedHosts.some((entry) => {
      const allowedHost = entry.toLowerCase().replace(/\.$/, '');
      if (allowedHost.startsWith('*.')) {
        return (
          host.endsWith(allowedHost.slice(1)) && host !== allowedHost.slice(2)
        );
      }
      return host === allowedHost;
    });

  if (!allowed) {
    throw new Error(
      'Remote repository host is outside the configured allowlist'
    );
  }
}

async function cloneWithRetries(
  options: Parameters<typeof GitCloneTool.clone>[0],
  maxRetries: number,
  retryDelay: number,
  signal: AbortSignal
): Promise<GitCloneResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await GitCloneTool.clone(options, signal);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delay = Math.min(retryDelay * 2 ** attempt, 60_000);
      await abortableDelay(delay, signal);
    }
  }

  throw lastError ?? new Error('Clone failed without a specific error');
}

async function assertLocalRepositoryAccess(
  repositoryPath: string,
  runtime: IngestRuntimeOptions
): Promise<void> {
  if (runtime.allowUnrestrictedLocalRepositories !== false) {
    return;
  }

  const roots = runtime.allowedLocalRoots ?? [];
  if (roots.length === 0) {
    throw new Error('Local repository access is disabled for this transport');
  }

  const resolvedRoots = await Promise.all(
    roots.map((root) => LocalRepositoryTool.resolvePath(root))
  );
  const allowed = resolvedRoots.some((root) =>
    isPathInside(repositoryPath, root)
  );
  if (!allowed) {
    throw new Error(
      'Local repository path is outside the configured allowlist'
    );
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== '..' &&
      !isAbsolute(relativePath))
  );
}

async function generateTextDigest(
  summary: RepositorySummary,
  tree: TreeNode,
  files: RepositoryFile[],
  maxTokens: number,
  tokenizerEncoding: TokenizerEncoding,
  tokenizer: Tiktoken,
  signal?: AbortSignal
): Promise<string> {
  const prefix = [
    '# Repository Summary',
    '',
    `- **URL**: ${sanitizeInline(summary.url)}`,
    `- **Source**: ${sanitizeInline(summary.source)}`,
    `- **Branch**: ${sanitizeInline(summary.branch)}`,
    `- **Commit**: ${sanitizeInline(summary.commit)}`,
    `- **Files**: ${summary.fileCount}`,
    `- **Directories**: ${summary.directoryCount}`,
    `- **Size**: ${formatBytes(summary.totalSize)}`,
    `- **Estimated source tokens**: ${summary.tokenCount.toLocaleString('en-US')}`,
    `- **Output tokenizer**: ${tokenizerEncoding}`,
    `- **Generated**: ${summary.createdAt}`,
    '',
    '# Directory Structure',
    '',
    `\`\`\`text\n${renderTree(
      tree,
      '',
      Math.min(maxTokens * 4, MAX_RENDERED_TREE_CHARACTERS)
    )}\n\`\`\``,
    '',
    '# File Contents',
    '',
    '',
  ].join('\n');

  const prefixTokenCount = countTextTokens(tokenizer, prefix);
  if (prefixTokenCount >= maxTokens) {
    return truncateToTokenBudget(prefix, maxTokens, tokenizer);
  }

  const parts = [prefix];
  let usedTokens = prefixTokenCount;
  for (const file of files) {
    await waitForImmediate(undefined, { signal });
    throwIfAborted(signal);

    const path = sanitizeInline(file.path);
    const language = languageIdentifier(file.path);
    const fence = codeFence(file.content);
    const header = `## ${path}\n\n${fence}${language}\n`;
    const footer = `\n${fence}\n`;
    const marker = '\n... [truncated by maxTokens]';
    const headerTokens = countTextTokens(tokenizer, header);
    const footerTokens = countTextTokens(tokenizer, footer);
    const markerTokens = countTextTokens(tokenizer, marker);
    const fixedTruncatedTokens = headerTokens + footerTokens + markerTokens;
    if (usedTokens + fixedTruncatedTokens > maxTokens) {
      parts.push(marker);
      break;
    }

    parts.push(header);
    usedTokens += headerTokens;
    let truncated = false;
    for (const chunk of splitText(file.content, TOKENIZATION_CHUNK_SIZE)) {
      const chunkTokens = encodeText(tokenizer, chunk);
      const remainingContentTokens =
        maxTokens - usedTokens - footerTokens - markerTokens;

      if (chunkTokens.length <= remainingContentTokens) {
        parts.push(chunk);
        usedTokens += chunkTokens.length;
        continue;
      }

      if (remainingContentTokens > 0) {
        const decodedPrefix = decodeCompleteTokenPrefix(
          tokenizer,
          chunkTokens.slice(0, remainingContentTokens)
        );
        parts.push(decodedPrefix.text);
        usedTokens += decodedPrefix.tokenCount;
      }
      parts.push(marker);
      usedTokens += markerTokens;
      truncated = true;
      break;
    }

    parts.push(footer);
    usedTokens += footerTokens;
    if (truncated) break;
  }

  return truncateToTokenBudget(parts.join(''), maxTokens, tokenizer);
}

function truncateToTokenBudget(
  value: string,
  tokenLimit: number,
  tokenizer: Tiktoken
): string {
  const valueTokens = encodeText(tokenizer, value);
  if (valueTokens.length <= tokenLimit) return value;

  const marker = '\n... [truncated by maxTokens]';
  const markerTokens = encodeText(tokenizer, marker);
  if (markerTokens.length >= tokenLimit) {
    return decodeCompleteTokenPrefix(
      tokenizer,
      valueTokens.slice(0, tokenLimit)
    ).text;
  }

  const decodedPrefix = decodeCompleteTokenPrefix(
    tokenizer,
    valueTokens.slice(0, tokenLimit - markerTokens.length)
  );
  const candidate = decodedPrefix.text + marker;
  const candidateTokens = encodeText(tokenizer, candidate);
  return candidateTokens.length <= tokenLimit
    ? candidate
    : decodeCompleteTokenPrefix(tokenizer, candidateTokens.slice(0, tokenLimit))
        .text;
}

function* splitText(value: string, chunkSize: number): Generator<string> {
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + chunkSize, value.length);
    const finalCodeUnit = value.charCodeAt(end - 1);
    if (
      end < value.length &&
      finalCodeUnit >= 0xd800 &&
      finalCodeUnit <= 0xdbff
    ) {
      end -= 1;
    }
    yield value.slice(offset, end);
    offset = end;
  }
}

function hasCharacterInRange(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= minimum && codePoint <= maximum;
  });
}

function codeFence(content: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const character of content) {
    if (character === '`') {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function languageIdentifier(path: string): string {
  const extension = path.split('.').pop() ?? '';
  return /^[a-zA-Z0-9_+-]+$/.test(extension) ? extension : '';
}

function sanitizeInline(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error) || isAbortError(error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const permanentFailures = [
    'authentication failed',
    'repository not found',
    'not a git repository',
    'remote branch',
    'invalid repository',
    'permission denied',
  ];
  if (permanentFailures.some((value) => message.includes(value))) {
    return false;
  }

  return [
    'network',
    'timed out',
    'timeout',
    'connection reset',
    'connection refused',
    'could not resolve host',
    'temporary failure',
    'tls',
    'http 500',
    'http 502',
    'http 503',
    'http 504',
    'rpc failed',
    'early eof',
  ].some((value) => message.includes(value));
}
