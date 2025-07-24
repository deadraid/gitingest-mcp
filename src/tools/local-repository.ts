import { promises as fs } from "fs";
import { join, relative, resolve } from "path";
import { GitCloneTool } from "./git-clone.js";

export interface LocalRepositoryOptions {
  path: string;
  includeGitignored?: boolean;
  useGitignore?: boolean;
  useGitingestignore?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
  excludePatterns?: string[];
  includePatterns?: string[];
}

export interface LocalRepositoryResult {
  path: string;
  files: RepositoryFile[];
  tree: TreeNode;
  summary: RepositorySummary;
}

export interface RepositoryFile {
  path: string;
  content: string;
  size: number;
  type: "file" | "directory" | "symlink";
}

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  children?: TreeNode[];
}

export interface RepositorySummary {
  path: string;
  branch: string;
  commit: string;
  fileCount: number;
  directoryCount: number;
  totalSize: number;
  tokenCount: number;
  createdAt: string;
}

export class LocalRepositoryTool {
  private static readonly DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly DEFAULT_MAX_FILES = 1000;

  static async analyze(options: LocalRepositoryOptions, signal?: AbortSignal): Promise<LocalRepositoryResult> {
    const {
      path,
      includeGitignored = false,
      useGitignore = true,
      useGitingestignore = true,
      maxFileSize = this.DEFAULT_MAX_FILE_SIZE,
      maxFiles = this.DEFAULT_MAX_FILES,
      excludePatterns = [],
      includePatterns = [],
    } = options;

    // Resolve absolute path
    const absolutePath = resolve(path);
    
    // Check if path exists
    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`Local repository path does not exist: ${path}`);
    }

    // Get repository info
    const repoInfo = await this.getRepositoryInfo(absolutePath);
    
    // Get ignore patterns
    const ignorePatterns = await this.getIgnorePatterns(
      absolutePath,
      includeGitignored,
      useGitignore,
      useGitingestignore,
      excludePatterns
    );

    // Collect files
    const files = await this.collectFiles(
      absolutePath,
      ignorePatterns,
      includePatterns,
      maxFileSize,
      maxFiles,
      signal
    );

    // Build tree structure
    const tree = this.buildTree(files, absolutePath);

    // Calculate summary
    const summary = await this.calculateSummary(
      absolutePath,
      files,
      repoInfo
    );

    return {
      path: absolutePath,
      files,
      tree,
      summary,
    };
  }

  private static async getRepositoryInfo(repoPath: string): Promise<{
    branch: string;
    commit: string;
  }> {
    try {
      const branch = await GitCloneTool.getCurrentBranch(repoPath);
      const commit = await GitCloneTool.getCurrentCommit(repoPath);
      return { branch, commit };
    } catch {
      return { branch: "main", commit: "unknown" };
    }
  }

  private static async getIgnorePatterns(
    repoPath: string,
    includeGitignored: boolean,
    useGitignore: boolean,
    useGitingestignore: boolean,
    excludePatterns: string[]
  ): Promise<string[]> {
    const patterns: string[] = [];

    // Add exclude patterns
    patterns.push(...excludePatterns);

    if (!includeGitignored) {
      // Add .gitignore patterns
      if (useGitignore) {
        const gitignorePath = join(repoPath, ".gitignore");
        try {
          const gitignore = await fs.readFile(gitignorePath, "utf-8");
          patterns.push(...this.parseIgnoreFile(gitignore));
        } catch {
          // .gitignore doesn't exist, ignore
        }
      }

      // Add .gitingestignore patterns
      if (useGitingestignore) {
        const gitingestignorePath = join(repoPath, ".gitingestignore");
        try {
          const gitingestignore = await fs.readFile(gitingestignorePath, "utf-8");
          patterns.push(...this.parseIgnoreFile(gitingestignore));
        } catch {
          // .gitingestignore doesn't exist, ignore
        }
      }
    }

    // Always ignore .git directory
    patterns.push(".git", ".git/**");

    return patterns;
  }

  private static parseIgnoreFile(content: string): string[] {
    return content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => {
        // Handle negation patterns
        if (line.startsWith("!")) {
          return line;
        }
        return line;
      });
  }

  private static async collectFiles(
    repoPath: string,
    ignorePatterns: string[],
    includePatterns: string[],
    maxFileSize: number,
    maxFiles: number,
    signal?: AbortSignal
  ): Promise<RepositoryFile[]> {
    const files: RepositoryFile[] = [];
    
    const walk = async (dir: string): Promise<void> => {
      if (signal?.aborted) {
        throw new Error('Operation aborted');
      }
      
      if (files.length >= maxFiles) {
        return;
      }

      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= maxFiles) {
          break;
        }

        const fullPath = join(dir, entry.name);
        const relativePath = relative(repoPath, fullPath);

        // Check ignore patterns
        if (this.shouldIgnore(relativePath, ignorePatterns)) {
          continue;
        }

        // Check include patterns
        if (includePatterns.length > 0 && !this.shouldInclude(relativePath, includePatterns)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          
          if (stats.size > maxFileSize) {
            continue;
          }

          try {
            const content = await fs.readFile(fullPath, "utf-8");
            files.push({
              path: relativePath,
              content,
              size: stats.size,
              type: "file",
            });
          } catch {
            // Skip binary files or files that can't be read as text
          }
        }
      }
    };

    await walk(repoPath);
    return files;
  }

  private static shouldIgnore(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern.startsWith("!")) {
        // Negation pattern
        const negatedPattern = pattern.slice(1);
        if (this.matchesPattern(path, negatedPattern)) {
          return false;
        }
      } else if (this.matchesPattern(path, pattern)) {
        return true;
      }
    }
    return false;
  }

  private static shouldInclude(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.matchesPattern(path, pattern)) {
        return true;
      }
    }
    return patterns.length === 0;
  }

  private static matchesPattern(path: string, pattern: string): boolean {
    // Simple glob matching
    const regex = pattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    
    return new RegExp(`^${regex}$`).test(path);
  }

  private static buildTree(files: RepositoryFile[], repoPath: string): TreeNode {
    const root: TreeNode = {
      name: "",
      type: "directory",
      children: [],
    };

    for (const file of files) {
      const parts = file.path.split("/");
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;

        if (isFile) {
          current.children = current.children || [];
          current.children.push({
            name: part,
            type: "file",
            size: file.size,
          });
        } else {
          let dir = current.children?.find(
            child => child.name === part && child.type === "directory"
          );

          if (!dir) {
            dir = {
              name: part,
              type: "directory",
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

  private static async calculateSummary(
    repoPath: string,
    files: RepositoryFile[],
    repoInfo: { branch: string; commit: string }
  ): Promise<RepositorySummary> {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const tokenCount = files.reduce((sum, file) => sum + this.estimateTokens(file.content), 0);
    
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        directories.add(parts.slice(0, i + 1).join("/"));
      }
    }

    return {
      path: repoPath,
      branch: repoInfo.branch,
      commit: repoInfo.commit,
      fileCount: files.length,
      directoryCount: directories.size,
      totalSize,
      tokenCount,
      createdAt: new Date().toISOString(),
    };
  }

  private static estimateTokens(content: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(content.length / 4);
  }
}