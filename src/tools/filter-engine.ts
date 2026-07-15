import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import createIgnore from 'ignore';
import { braceExpand, Minimatch, type MinimatchOptions } from 'minimatch';

import { throwIfAborted } from '../utils/index.js';

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

interface CompiledPattern {
  negated: boolean;
  matcher: Minimatch;
}

interface ScopedIgnoreMatcher {
  matcher: ReturnType<typeof createIgnore>;
}

export class FilterEngine {
  private static readonly MAX_IGNORE_FILE_SIZE = 1024 * 1024;
  private static readonly MAX_IGNORE_FILES = 1024;
  private static readonly MAX_TOTAL_IGNORE_SIZE = 4 * 1024 * 1024;
  private static readonly MAX_IGNORE_RULES = 50_000;
  private static readonly MAX_BRACE_EXPANSIONS = 32;

  private readonly excludePatterns: CompiledPattern[];
  private readonly includePatterns: Minimatch[];
  private readonly scopedIgnoreMatchers = new Map<
    string,
    ScopedIgnoreMatcher[]
  >();
  private readonly loadedIgnoreDirectories = new Set<string>();
  private ignoreFileCount = 0;
  private totalIgnoreSize = 0;
  private totalIgnoreRules = 0;

  private readonly options: FilterOptions;

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

    this.excludePatterns = (this.options.excludePatterns || []).map(
      (pattern) => {
        const negated = pattern.startsWith('!');
        return {
          negated,
          matcher: this.compilePattern(negated ? pattern.slice(1) : pattern),
        };
      }
    );
    this.includePatterns = (this.options.includePatterns || []).map((pattern) =>
      this.compilePattern(pattern)
    );
  }

  async loadIgnorePatterns(
    repoPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.loadDirectoryIgnorePatterns(repoPath, '', signal);
  }

  async loadDirectoryIgnorePatterns(
    directoryPath: string,
    relativeDirectoryPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const basePath = this.normalizePath(relativeDirectoryPath).replace(
      /\/$/,
      ''
    );
    if (this.loadedIgnoreDirectories.has(basePath)) return;
    this.loadedIgnoreDirectories.add(basePath);

    if (!this.options.includeGitignored && this.options.useGitignore) {
      await this.loadIgnoreFile(
        join(directoryPath, '.gitignore'),
        basePath,
        signal
      );
    }

    if (this.options.useGitingestignore) {
      await this.loadIgnoreFile(
        join(directoryPath, '.gitingestignore'),
        basePath,
        signal
      );
    }
  }

  private async loadIgnoreFile(
    ignoreFilePath: string,
    basePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    let fileHandle: FileHandle | undefined;
    try {
      fileHandle = await fs.open(
        ignoreFilePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const stats = await fileHandle.stat();
      if (!stats.isFile()) return;
      if (stats.size > FilterEngine.MAX_IGNORE_FILE_SIZE) {
        throw new Error(
          `Ignore file exceeds ${FilterEngine.MAX_IGNORE_FILE_SIZE} bytes: ${ignoreFilePath}`
        );
      }
      if (this.ignoreFileCount >= FilterEngine.MAX_IGNORE_FILES) {
        throw new Error(
          `Repository exceeds the maximum of ${FilterEngine.MAX_IGNORE_FILES} ignore files`
        );
      }
      if (
        this.totalIgnoreSize + stats.size >
        FilterEngine.MAX_TOTAL_IGNORE_SIZE
      ) {
        throw new Error(
          `Repository ignore files exceed ${FilterEngine.MAX_TOTAL_IGNORE_SIZE} bytes in total`
        );
      }

      const contentBuffer = await readWithinLimit(
        fileHandle,
        stats.size,
        FilterEngine.MAX_IGNORE_FILE_SIZE,
        signal
      );
      if (!contentBuffer) {
        throw new Error(
          `Ignore file changed or exceeds ${FilterEngine.MAX_IGNORE_FILE_SIZE} bytes: ${ignoreFilePath}`
        );
      }
      throwIfAborted(signal);
      if (
        this.totalIgnoreSize + contentBuffer.byteLength >
        FilterEngine.MAX_TOTAL_IGNORE_SIZE
      ) {
        throw new Error(
          `Repository ignore files exceed ${FilterEngine.MAX_TOTAL_IGNORE_SIZE} bytes in total`
        );
      }

      const content = contentBuffer.toString('utf8');
      const ignoreRuleCount = countLines(content);
      if (
        this.totalIgnoreRules + ignoreRuleCount >
        FilterEngine.MAX_IGNORE_RULES
      ) {
        throw new Error(
          `Repository ignore files exceed ${FilterEngine.MAX_IGNORE_RULES} rules in total`
        );
      }
      const matchers = this.scopedIgnoreMatchers.get(basePath) ?? [];
      matchers.push({
        matcher: createIgnore({ ignorecase: false }).add(content),
      });
      this.scopedIgnoreMatchers.set(basePath, matchers);
      this.ignoreFileCount += 1;
      this.totalIgnoreSize += contentBuffer.byteLength;
      this.totalIgnoreRules += ignoreRuleCount;
    } catch (error) {
      if (isMissingOrSymlink(error)) return;
      throw error;
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }

  shouldIncludeFile(
    filePath: string,
    fileSize: number,
    mimeType?: string,
    signal?: AbortSignal
  ): FilterResult {
    // Check for abort signal
    throwIfAborted(signal);

    // Check file size
    if (this.options.maxFileSize && fileSize > this.options.maxFileSize) {
      return {
        shouldInclude: false,
        reason: `File size ${fileSize} exceeds maximum ${this.options.maxFileSize}`,
      };
    }

    // Check extension filters
    const extension = this.getFileExtension(filePath);

    if (
      this.options.allowedExtensions?.length &&
      !this.options.allowedExtensions.includes(extension)
    ) {
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
      if (
        this.options.allowedMimeTypes?.length &&
        !this.options.allowedMimeTypes.includes(mimeType)
      ) {
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
    if (this.shouldIgnore(this.normalizePath(filePath))) {
      return {
        shouldInclude: false,
        reason: 'File matches ignore pattern',
      };
    }

    // Check include patterns
    if (this.includePatterns.length > 0 && !this.shouldInclude(filePath)) {
      return {
        shouldInclude: false,
        reason: 'File does not match include patterns',
      };
    }

    return { shouldInclude: true };
  }

  shouldTraverseDirectory(
    directoryPath: string,
    signal?: AbortSignal
  ): boolean {
    throwIfAborted(signal);

    const normalizedPath = this.normalizePath(directoryPath).replace(/\/$/, '');
    if (containsGitMetadataSegment(normalizedPath)) {
      return false;
    }

    if (!this.shouldIgnore(normalizedPath, true)) {
      return true;
    }

    return this.excludePatterns.some(
      (pattern) =>
        pattern.negated && pattern.matcher.match(normalizedPath, true)
    );
  }

  private shouldIgnore(filePath: string, isDirectory = false): boolean {
    if (containsGitMetadataSegment(filePath)) {
      return true;
    }

    let ignored = this.isIgnoredByIgnoreFiles(filePath, isDirectory);
    const candidate = isDirectory ? `${filePath}/` : filePath;

    for (const pattern of this.excludePatterns) {
      if (pattern.matcher.match(candidate)) {
        ignored = !pattern.negated;
      }
    }

    return ignored;
  }

  private isIgnoredByIgnoreFiles(
    filePath: string,
    isDirectory: boolean
  ): boolean {
    let ignored = false;

    const pathSegments = filePath.split('/');
    let basePath = '';
    for (let index = 0; index < pathSegments.length; index += 1) {
      const matchers = this.scopedIgnoreMatchers.get(basePath) ?? [];
      const scopedPath = basePath
        ? filePath.slice(basePath.length + 1)
        : filePath;

      for (const { matcher } of matchers) {
        const result = matcher.test(
          isDirectory ? `${scopedPath}/` : scopedPath
        );
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }

      const pathSegment = pathSegments[index];
      if (pathSegment === undefined) break;
      basePath = basePath ? `${basePath}/${pathSegment}` : pathSegment;
    }

    return ignored;
  }

  private shouldInclude(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    return this.includePatterns.some((pattern) =>
      pattern.match(normalizedPath)
    );
  }

  private normalizePath(filePath: string): string {
    return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  }

  private getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot !== -1 ? filePath.slice(lastDot + 1).toLowerCase() : '';
  }

  private compilePattern(pattern: string): Minimatch {
    if (!pattern || containsControlCharacter(pattern)) {
      throw new Error('Glob patterns must not be empty or contain controls');
    }
    const options: MinimatchOptions = {
      dot: true,
      nocase: false,
      nonegate: true,
      braceExpandMax: FilterEngine.MAX_BRACE_EXPANSIONS + 1,
    };
    if (
      braceExpand(pattern, options).length > FilterEngine.MAX_BRACE_EXPANSIONS
    ) {
      throw new Error(
        `Glob pattern exceeds ${FilterEngine.MAX_BRACE_EXPANSIONS} brace expansions`
      );
    }
    return new Minimatch(pattern, {
      ...options,
      braceExpandMax: FilterEngine.MAX_BRACE_EXPANSIONS,
    });
  }

  // Utility methods for common filters
  static createDefaultFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 1000,
      excludePatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.env*',
        '**/*.log',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/.cache/**',
        '**/tmp/**',
        '**/temp/**',
      ],
      blockedExtensions: [
        'exe',
        'dll',
        'so',
        'dylib',
        'bin',
        'o',
        'obj',
        'pyc',
        'pyo',
        'class',
        'jar',
        'war',
        'ear',
        'zip',
        'tar',
        'gz',
        'bz2',
        'xz',
        '7z',
        'rar',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'bmp',
        'ico',
        'svg',
        'webp',
        'mp4',
        'mp3',
        'avi',
        'mov',
        'wmv',
        'flv',
        'wav',
        'flac',
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
      ],
    });
  }

  static createMinimalFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 1 * 1024 * 1024, // 1MB
      maxFiles: 100,
      excludePatterns: ['**/node_modules/**', '**/.git/**'],
    });
  }

  static createComprehensiveFilter(): FilterEngine {
    return new FilterEngine({
      maxFileSize: 5 * 1024 * 1024, // 5MB
      maxFiles: 500,
      excludePatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.env*',
        '**/*.log',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/.cache/**',
        '**/tmp/**',
        '**/temp/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
        '**/.mypy_cache/**',
        '**/.tox/**',
        '**/.venv/**',
        '**/venv/**',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
      allowedExtensions: [
        'js',
        'jsx',
        'ts',
        'tsx',
        'py',
        'java',
        'c',
        'cpp',
        'cc',
        'cxx',
        'h',
        'hpp',
        'hxx',
        'cs',
        'php',
        'rb',
        'go',
        'rs',
        'swift',
        'kt',
        'scala',
        'html',
        'htm',
        'css',
        'scss',
        'sass',
        'less',
        'xml',
        'json',
        'yaml',
        'yml',
        'toml',
        'ini',
        'cfg',
        'conf',
        'md',
        'rst',
        'txt',
        'sql',
        'sh',
        'bash',
        'zsh',
        'fish',
        'ps1',
        'bat',
        'cmd',
        'dockerfile',
        'makefile',
      ],
    });
  }
}

function isMissingOrSymlink(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['ELOOP', 'ENOENT'].includes(
    String((error as NodeJS.ErrnoException).code)
  );
}

async function readWithinLimit(
  fileHandle: FileHandle,
  expectedSize: number,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Buffer | undefined> {
  const capacity = Math.min(expectedSize, maximumBytes) + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let offset = 0;

  while (offset < buffer.byteLength) {
    throwIfAborted(signal);
    const { bytesRead } = await fileHandle.read({
      buffer,
      offset,
      length: buffer.byteLength - offset,
      position: offset,
    });
    if (bytesRead === 0) {
      return buffer.subarray(0, offset);
    }
    offset += bytesRead;
  }

  return undefined;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;

  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x0a) lines += 1;
  }
  return lines;
}

function containsGitMetadataSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.toLowerCase() === '.git');
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
