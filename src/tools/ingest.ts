import { z } from 'zod';
import { GitUrlParser } from './url-parser.js';
import { GitCloneTool } from './git-clone.js';
import { LocalRepositoryTool } from './local-repository.js';
import { FilterEngine } from './filter-engine.js';
import { promises as fs } from 'fs';
import { join } from 'path';

// Schema for ingest tool input
export const ingestSchema = z.object({
  repository: z
    .string()
    .describe('Git repository URL, local path, or shorthand'),
  source: z.enum(['github', 'gitlab', 'bitbucket', 'local', 'git']).optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  tag: z.string().optional(),
  subpath: z.string().optional(),
  cloneDepth: z.number().min(1).max(1000).default(1),
  sparseCheckout: z.boolean().default(false),
  includeSubmodules: z.boolean().default(false),
  includeGitignored: z.boolean().default(false),
  useGitignore: z.boolean().default(true),
  useGitingestignore: z.boolean().default(true),
  excludePatterns: z.array(z.string()).optional(),
  includePatterns: z.array(z.string()).optional(),
  maxFileSize: z.number().optional(),
  maxFiles: z.number().default(1000),
  maxTotalSize: z.number().default(50 * 1024 * 1024), // 50MB
  maxTokens: z
    .number()
    .optional()
    .describe('Maximum number of tokens in the output digest'),
  token: z
    .string()
    .optional()
    .describe('Access token for private repositories'),
  maxRetries: z.number().default(3).describe('Maximum retry attempts'),
  retryDelay: z
    .number()
    .default(1000)
    .describe('Base delay in milliseconds between retry attempts'),
  timeout: z
    .number()
    .default(30000)
    .describe('Maximum time in milliseconds to complete the operation'),
  signal: z
    .custom<AbortSignal>()
    .optional()
    .describe('Abort signal for cancelling the operation'),
});

export type IngestInput = z.infer<typeof ingestSchema>;

// Schema for repository file
export interface RepositoryFile {
  path: string;
  content: string;
  size: number;
  type: 'file' | 'directory' | 'symlink';
}

// Schema for repository tree node
export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeNode[];
}

// Schema for repository summary
export interface RepositorySummary {
  url: string;
  source: string;
  branch: string;
  commit: string;
  fileCount: number;
  directoryCount: number;
  totalSize: number;
  tokenCount: number;
  createdAt: string;
}

/**
 * Main function to ingest a Git repository and transform it into an LLM-friendly text digest
 * @param input - Ingest input parameters
 * @returns Object containing summary, tree structure, and file contents
 */
export async function ingestTool(input: IngestInput): Promise<{
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}> {
  // Validate input
  const parsedInput = ingestSchema.parse(input);

  // Create abort controller for timeout and cancellation
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, parsedInput.timeout);

  // If external signal is provided, listen for abort events
  if (parsedInput.signal) {
    parsedInput.signal.addEventListener('abort', () => {
      abortController.abort();
    });
  }

  try {
    // Parse repository URL
    const parsedUrl = GitUrlParser.parse(parsedInput.repository);

    const filterEngine = new FilterEngine({
      includeGitignored: parsedInput.includeGitignored,
      useGitignore: parsedInput.useGitignore,
      useGitingestignore: parsedInput.useGitingestignore,
      maxFileSize: parsedInput.maxFileSize,
      maxFiles: parsedInput.maxFiles,
      excludePatterns: parsedInput.excludePatterns,
      includePatterns: parsedInput.includePatterns,
    });

    let repoPath: string;
    let repoInfo: { branch: string; commit: string };

    // Clone or analyze repository based on type
    if (parsedUrl.isLocal) {
      // Local repository
      const result = await LocalRepositoryTool.analyze(
        {
          path: parsedUrl.url,
          includeGitignored: parsedInput.includeGitignored,
          useGitignore: parsedInput.useGitignore,
          useGitingestignore: parsedInput.useGitingestignore,
          maxFileSize: parsedInput.maxFileSize,
          maxFiles: parsedInput.maxFiles,
          excludePatterns: parsedInput.excludePatterns,
          includePatterns: parsedInput.includePatterns,
        },
        abortController.signal
      );

      repoPath = result.path;
      repoInfo = {
        branch: result.summary.branch,
        commit: result.summary.commit,
      };

      // Apply filters to files
      const filteredFiles = result.files.filter((file) => {
        const filterResult = filterEngine.shouldIncludeFile(
          file.path,
          file.size,
          undefined,
          abortController.signal
        );
        return filterResult.shouldInclude;
      });

      // Generate digest
      const digest = generateTextDigest(
        {
          url: parsedInput.repository,
          source: 'local',
          branch: repoInfo.branch,
          commit: repoInfo.commit,
          fileCount: filteredFiles.length,
          directoryCount: result.tree.children?.length || 0,
          totalSize: filteredFiles.reduce((sum, file) => sum + file.size, 0),
          tokenCount: filteredFiles.reduce(
            (sum, file) => sum + estimateTokens(file.content),
            0
          ),
          createdAt: new Date().toISOString(),
        },
        result.tree,
        filteredFiles,
        parsedInput.maxTokens
      );

      return {
        content: [
          {
            type: 'text',
            text: digest,
          },
        ],
      };
    } else {
      // Remote repository - clone it
      let cloneResult:
        | { path: string; branch: string; commit: string; isShallow: boolean }
        | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt <= parsedInput.maxRetries; attempt++) {
        try {
          cloneResult = await GitCloneTool.clone(
            {
              url: GitUrlParser.toHttpsUrl(parsedUrl),
              branch: parsedInput.branch || parsedUrl.branch,
              commit: parsedInput.commit,
              tag: parsedInput.tag,
              depth: parsedInput.cloneDepth,
              sparse: parsedInput.sparseCheckout,
              subpath: parsedInput.subpath || parsedUrl.subpath,
              includeSubmodules: parsedInput.includeSubmodules,
            },
            abortController.signal
          );
          lastError = undefined;
          break; // Success, exit the loop
        } catch (error) {
          lastError = error;

          const shouldRetry =
            attempt < parsedInput.maxRetries && isRetryableError(error);

          if (!shouldRetry) {
            break; // Permanent error or max retries reached
          }

          // If retryable and we still have attempts left, wait before retrying
          const delay = Math.min(
            parsedInput.retryDelay * Math.pow(2, attempt), // Exponential backoff
            60000 // Max delay of 1 minute
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      if (lastError || !cloneResult) {
        throw lastError || new Error('Clone failed without a specific error');
      }

      const repoPath = cloneResult.path;
      const repoInfo = {
        branch: cloneResult.branch,
        commit: cloneResult.commit,
      };

      // Load ignore patterns with signal
      await filterEngine.loadIgnorePatterns(repoPath, abortController.signal);

      // Collect files with signal
      const files = await collectFiles(
        repoPath,
        filterEngine,
        abortController.signal
      );

      // Build tree structure
      const tree = buildTree(files, repoPath);

      // Generate digest
      const digest = generateTextDigest(
        {
          url: parsedInput.repository,
          source: parsedUrl.type || 'git',
          branch: repoInfo.branch,
          commit: repoInfo.commit,
          fileCount: files.length,
          directoryCount: countDirectories(tree),
          totalSize: files.reduce((sum, file) => sum + file.size, 0),
          tokenCount: files.reduce(
            (sum, file) => sum + estimateTokens(file.content),
            0
          ),
          createdAt: new Date().toISOString(),
        },
        tree,
        files,
        parsedInput.maxTokens
      );

      // Clean up
      await GitCloneTool.cleanup(repoPath);

      return {
        content: [
          {
            type: 'text',
            text: digest,
          },
        ],
      };
    }
  } catch (error) {
    // Handle timeout error
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        content: [
          {
            type: 'text',
            text: `Operation timed out after ${parsedInput.timeout}ms`,
          },
        ],
        isError: true,
      };
    }

    // Handle other errors
    return {
      content: [
        {
          type: 'text',
          text: `Error ingesting repository: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    // Ensure timeout is cleared
    clearTimeout(timeoutId);
  }
}

async function collectFiles(
  repoPath: string,
  filterEngine: FilterEngine,
  signal?: AbortSignal
): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }

    // Check maxFiles limit
    if (files.length >= (filterEngine as any).options.maxFiles) {
      return;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Check maxFiles limit
      if (files.length >= (filterEngine as any).options.maxFiles) {
        break;
      }

      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.substring(repoPath.length + 1);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath);

        const filterResult = filterEngine.shouldIncludeFile(
          relativePath,
          stats.size,
          undefined,
          signal
        );
        if (!filterResult.shouldInclude) {
          continue;
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          files.push({
            path: relativePath,
            content,
            size: stats.size,
            type: 'file',
          });
        } catch {
          // Skip binary files or files that can't be read as text
        }
      }
    }
  }

  await walk(repoPath);
  return files;
}

function buildTree(files: RepositoryFile[], repoPath: string): TreeNode {
  const root: TreeNode = {
    name: '',
    type: 'directory',
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        current.children = current.children || [];
        current.children.push({
          name: part,
          type: 'file',
          size: file.size,
        });
      } else {
        let dir = current.children?.find(
          (child) => child.name === part && child.type === 'directory'
        );

        if (!dir) {
          dir = {
            name: part,
            type: 'directory',
            children: [],
          };
          current.children = current.children || [];
          current.children.push(dir);
        }

        current = dir;
      }
    }
  }

  return root;
}

function countDirectories(node: TreeNode): number {
  let count = 0;
  if (node.children) {
    for (const child of node.children) {
      if (child.type === 'directory') {
        count++;
        count += countDirectories(child);
      }
    }
  }
  return count;
}

function estimateTokens(content: string): number {
  // Rough estimation: 1 token ≈ 4 characters
  return Math.ceil(content.length / 4);
}

/**
 * Generate a text digest from repository summary, tree structure, and files
 * @param summary - Repository summary information
 * @param tree - Repository tree structure
 * @param files - Repository files
 * @param maxTokens - Maximum number of tokens allowed in the output (optional)
 * @returns Formatted text digest
 */
function generateTextDigest(
  summary: RepositorySummary,
  tree: TreeNode,
  files: RepositoryFile[],
  maxTokens?: number
): string {
  const lines: string[] = [];

  lines.push('# Repository Summary');
  lines.push('');
  lines.push(`- **URL**: ${summary.url}`);
  lines.push(`- **Source**: ${summary.source}`);
  lines.push(`- **Branch**: ${summary.branch}`);
  lines.push(`- **Commit**: ${summary.commit}`);
  lines.push(`- **Files**: ${summary.fileCount}`);
  lines.push(`- **Directories**: ${summary.directoryCount}`);
  lines.push(`- **Size**: ${formatBytes(summary.totalSize)}`);
  lines.push(`- **Estimated Tokens**: ${summary.tokenCount.toLocaleString()}`);
  lines.push(
    `- **Generated**: ${new Date(summary.createdAt).toLocaleString()}`
  );
  lines.push('');
  lines.push('# Directory Structure');
  lines.push('');
  lines.push('```\n' + renderTree(tree) + '\n```');
  lines.push('');
  lines.push('# File Contents');
  lines.push('');

  let currentTokens = summary.tokenCount;

  for (const file of files) {
    // Skip file if we've reached the token limit
    if (maxTokens && currentTokens >= maxTokens) {
      continue;
    }

    const extension = file.path.split('.').pop() || '';
    lines.push(`## ${file.path}`);
    lines.push('');

    const fileTokens = estimateTokens(file.content);

    // If adding the entire file would exceed the limit, truncate it
    if (maxTokens && currentTokens + fileTokens > maxTokens) {
      const tokensAvailable = maxTokens - currentTokens;
      const charsAvailable = tokensAvailable * 4; // Reverse heuristic

      // Truncate file content
      const truncatedContent = file.content.substring(0, charsAvailable);
      lines.push(`\`\`\`${extension}\n${truncatedContent}...\n\`\`\``);
      currentTokens = maxTokens; // Reached the limit
    } else {
      // Add the entire file
      lines.push(`\`\`\`${extension}\n${file.content}\n\`\`\``);
      currentTokens += fileTokens;
    }

    lines.push('');
  }

  return lines.join('\n');
}

function renderTree(node: TreeNode, prefix = '', isLast = true): string {
  if (!node.children || node.children.length === 0) return '';

  const lines: string[] = [];
  const connector = isLast ? '└── ' : '├── ';

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLastChild = i === node.children.length - 1;
    const newPrefix = prefix + (isLast ? '    ' : '│   ');

    lines.push(
      `${prefix}${connector}${child.name}${child.type === 'directory' ? '/' : ''}${child.size ? ` (${formatBytes(child.size)})` : ''}`
    );

    if (child.type === 'directory' && child.children) {
      lines.push(renderTree(child, newPrefix, isLastChild));
    }
  }

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to decide whether an error is worth retrying (e.g. network issues)
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // AbortError or explicit cancellation – do not retry
  if (error.name === 'AbortError') {
    return false;
  }

  const message = error.message.toLowerCase();

  // Non-retryable messages indicating invalid input or permanent failure
  if (
    message.includes('invalid') ||
    message.includes('not found') ||
    message.includes('failed to analyze')
  ) {
    return false;
  }

  // Network-related errors are considered transient and thus retryable
  if (message.includes('network')) {
    return true;
  }

  // Default to not retrying for unknown non-network errors
  return false;
}
