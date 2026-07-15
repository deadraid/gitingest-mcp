import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  RepositoryFile,
  RepositorySummary,
  TreeNode,
} from '../types/index.js';
import {
  buildTree,
  countDirectories,
  estimateTokens,
  throwIfAborted,
} from '../utils/index.js';
import { FilterEngine } from './filter-engine.js';
import { GitCloneTool } from './git-clone.js';
import { collectRepositoryFiles } from './repository-reader.js';

export interface LocalRepositoryOptions {
  path: string;
  includeGitignored?: boolean;
  useGitignore?: boolean;
  useGitingestignore?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
  maxTotalSize?: number;
  maxEntries?: number;
  maxDepth?: number;
  expectedCanonicalPath?: string;
  excludePatterns?: string[];
  includePatterns?: string[];
}

export interface LocalRepositoryResult {
  path: string;
  files: RepositoryFile[];
  tree: TreeNode;
  summary: RepositorySummary;
}

export class LocalRepositoryTool {
  private static readonly DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
  private static readonly DEFAULT_MAX_FILES = 1000;
  private static readonly DEFAULT_MAX_TOTAL_SIZE = 50 * 1024 * 1024;
  private static readonly DEFAULT_MAX_ENTRIES = 25_000;
  private static readonly DEFAULT_MAX_DEPTH = 128;

  static async resolvePath(path: string): Promise<string> {
    const expandedPath = expandHomeDirectory(path);
    const absolutePath = isAbsolute(expandedPath)
      ? expandedPath
      : resolve(expandedPath);

    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        throw new Error(`Local repository path is not a directory: ${path}`);
      }
      return await fs.realpath(absolutePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a directory')) {
        throw error;
      }
      const errorCode =
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : undefined;
      const message = ['ENOENT', 'ENOTDIR'].includes(errorCode ?? '')
        ? `Local repository path does not exist: ${path}`
        : `Unable to access local repository path: ${path}`;
      throw new Error(message, {
        cause: error,
      });
    }
  }

  static async analyze(
    options: LocalRepositoryOptions,
    signal?: AbortSignal
  ): Promise<LocalRepositoryResult> {
    const {
      includeGitignored = false,
      useGitignore = true,
      useGitingestignore = true,
      maxFileSize = this.DEFAULT_MAX_FILE_SIZE,
      maxFiles = this.DEFAULT_MAX_FILES,
      maxTotalSize = this.DEFAULT_MAX_TOTAL_SIZE,
      maxEntries = this.DEFAULT_MAX_ENTRIES,
      maxDepth = this.DEFAULT_MAX_DEPTH,
      excludePatterns = [],
      includePatterns = [],
    } = options;

    throwIfAborted(signal);
    const absolutePath = await this.resolvePath(options.path);
    if (
      options.expectedCanonicalPath !== undefined &&
      absolutePath !== options.expectedCanonicalPath
    ) {
      throw new Error('Repository path changed after access validation');
    }

    const filterEngine = new FilterEngine({
      includeGitignored,
      useGitignore,
      useGitingestignore,
      maxFileSize,
      maxFiles,
      excludePatterns,
      includePatterns,
    });
    await filterEngine.loadIgnorePatterns(absolutePath, signal);

    const { files } = await collectRepositoryFiles(
      absolutePath,
      filterEngine,
      {
        maxFiles,
        maxFileSize,
        maxTotalSize,
        maxEntries,
        maxDepth,
        expectedCanonicalPath: options.expectedCanonicalPath,
      },
      signal
    );
    const tree = buildTree(files);
    const repositoryInfo = await this.getRepositoryInfo(absolutePath, signal);

    const summary: RepositorySummary = {
      url: absolutePath,
      source: 'local',
      branch: repositoryInfo.branch,
      commit: repositoryInfo.commit,
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
      path: absolutePath,
      files,
      tree,
      summary,
    };
  }

  private static async getRepositoryInfo(
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<{ branch: string; commit: string }> {
    const [branch, commit] = await Promise.all([
      GitCloneTool.getCurrentBranch(repositoryPath, signal),
      GitCloneTool.getCurrentCommit(repositoryPath, signal),
    ]);
    return { branch, commit };
  }
}

function expandHomeDirectory(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
