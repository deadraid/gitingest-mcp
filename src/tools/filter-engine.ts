import { promises as fs } from "fs";
import { join } from "path";
import { minimatch } from "minimatch";

export interface FilterOptions {
  includeGitignored?: boolean;
  useGitignore?: boolean;
  useGitingestignore?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
  excludePatterns?: string[];
  includePatterns?: string[];
  allowedExtensions?: string[];
  blockedExtensions?: string[];
  allowedMimeTypes?: string[];
  blockedMimeTypes?: string[];
}

export interface FilterResult {
  shouldInclude: boolean;
  reason?: string;
}

export class FilterEngine {
  private patterns: {
    exclude: string[];
    include: string[];
    gitignore: string[];
    gitingestignore: string[];
  };

  private options: FilterOptions;

  constructor(options: FilterOptions = {}) {
    this.options = {
      includeGitignored: false,
      useGitignore: true,
      useGitingestignore: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 1000,
      excludePatterns: [],
      includePatterns: [],
      allowedExtensions: [],
      blockedExtensions: [],
      allowedMimeTypes: [],
      blockedMimeTypes: [],
      ...options,
    };

    this.patterns = {
      exclude: [...(this.options.excludePatterns || [])],
      include: [...(this.options.includePatterns || [])],
      gitignore: [],
      gitingestignore: [],
    };
  }

  async loadIgnorePatterns(repoPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    
    if (!this.options.includeGitignored) {
      if (this.options.useGitignore) {
        await this.loadGitignore(repoPath, signal);
      }
      
      if (this.options.useGitingestignore) {
        await this.loadGitingestignore(repoPath, signal);
      }
    }

    // Always exclude .git directory
    this.patterns.exclude.push(".git", ".git/**");
  }

  private async loadGitignore(repoPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    
    const gitignorePath = join(repoPath, ".gitignore");
    try {
      const content = await fs.readFile(gitignorePath, "utf-8");
      this.patterns.gitignore = this.parseIgnoreFile(content);
    } catch {
      // .gitignore doesn't exist
    }
  }

  private async loadGitingestignore(repoPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    
    const gitingestignorePath = join(repoPath, ".gitingestignore");
    try {
      const content = await fs.readFile(gitingestignorePath, "utf-8");
      this.patterns.gitingestignore = this.parseIgnoreFile(content);
    } catch {
      // .gitingestignore doesn't exist
    }
  }

  private parseIgnoreFile(content: string): string[] {
    return content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => {
        // Handle directory patterns
        if (line.endsWith("/")) {
          return line + "**";
        }
        return line;
      });
  }

  shouldIncludeFile(filePath: string, fileSize: number, mimeType?: string, signal?: AbortSignal): FilterResult {
    // Check for abort signal
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    
    // Check file size
    if (this.options.maxFileSize && fileSize > this.options.maxFileSize) {
      return {
        shouldInclude: false,
        reason: `File size ${fileSize} exceeds maximum ${this.options.maxFileSize}`,
      };
    }

    // Check extension filters
    const extension = this.getFileExtension(filePath);
    
    if (this.options.allowedExtensions?.length && !this.options.allowedExtensions.includes(extension)) {
      return {
        shouldInclude: false,
        reason: `Extension ${extension} not in allowed extensions`,
      };
    }
    
    if (this.options.blockedExtensions?.includes(extension)) {
      return {
        shouldInclude: false,
        reason: `Extension ${extension} is blocked`,
      };
    }

    // Check MIME type filters
    if (mimeType) {
      if (this.options.allowedMimeTypes?.length && !this.options.allowedMimeTypes.includes(mimeType)) {
        return {
          shouldInclude: false,
          reason: `MIME type ${mimeType} not in allowed types`,
        };
      }
      
      if (this.options.blockedMimeTypes?.includes(mimeType)) {
        return {
          shouldInclude: false,
          reason: `MIME type ${mimeType} is blocked`,
        };
      }
    }

    // Check ignore patterns
    if (this.shouldIgnore(filePath)) {
      return {
        shouldInclude: false,
        reason: "File matches ignore pattern",
      };
    }

    // Check include patterns
    if (this.options.includePatterns?.length && !this.shouldInclude(filePath)) {
      return {
        shouldInclude: false,
        reason: "File does not match include patterns",
      };
    }

    return { shouldInclude: true };
  }

  private shouldIgnore(filePath: string): boolean {
    const allIgnorePatterns = [
      ...this.patterns.exclude,
      ...this.patterns.gitignore,
      ...this.patterns.gitingestignore,
    ];

    for (const pattern of allIgnorePatterns) {
      if (pattern.startsWith("!")) {
        // Negation pattern
        const negatedPattern = pattern.slice(1);
        if (minimatch(filePath, negatedPattern)) {
          return false;
        }
      } else if (minimatch(filePath, pattern)) {
        return true;
      }
    }

    return false;
  }

  private shouldInclude(filePath: string): boolean {
    if (this.options.includePatterns?.length === 0) {
      return true;
    }

    return this.options.includePatterns!.some(pattern => 
      minimatch(filePath, pattern)
    );
  }

  private getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf(".");
    return lastDot !== -1 ? filePath.slice(lastDot + 1).toLowerCase() : "";
  }

  // Utility methods for common filters
  static createDefaultFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 1000,
      excludePatterns: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.env*",
        "**/*.log",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/.nuxt/**",
        "**/coverage/**",
        "**/.cache/**",
        "**/tmp/**",
        "**/temp/**",
      ],
      blockedExtensions: [
        "exe", "dll", "so", "dylib", "bin", "o", "obj", "pyc", "pyo", "class",
        "jar", "war", "ear", "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "mp4", "mp3",
        "avi", "mov", "wmv", "flv", "wav", "flac", "pdf", "doc", "docx", "xls",
        "xlsx", "ppt", "pptx",
      ],
    });
  }

  static createMinimalFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 1 * 1024 * 1024, // 1MB
      maxFiles: 100,
      excludePatterns: [
        "**/node_modules/**",
        "**/.git/**",
      ],
    });
  }

  static createComprehensiveFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 5 * 1024 * 1024, // 5MB
      maxFiles: 500,
      excludePatterns: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.env*",
        "**/*.log",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/.nuxt/**",
        "**/coverage/**",
        "**/.cache/**",
        "**/tmp/**",
        "**/temp/**",
        "**/__pycache__/**",
        "**/.pytest_cache/**",
        "**/.mypy_cache/**",
        "**/.tox/**",
        "**/.venv/**",
        "**/venv/**",
        "**/.DS_Store",
        "**/Thumbs.db",
      ],
      allowedExtensions: [
        "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cc", "cxx", "h",
        "hpp", "hxx", "cs", "php", "rb", "go", "rs", "swift", "kt", "scala",
        "html", "htm", "css", "scss", "sass", "less", "xml", "json", "yaml",
        "yml", "toml", "ini", "cfg", "conf", "md", "rst", "txt", "sql", "sh",
        "bash", "zsh", "fish", "ps1", "bat", "cmd", "dockerfile", "makefile",
      ],
    });
  }
}