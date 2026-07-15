import { constants, promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { RepositoryFile } from '../types/index.js';
import { throwIfAborted } from '../utils/index.js';
import type { FilterEngine } from './filter-engine.js';

export interface RepositoryReadLimits {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
  maxEntries: number;
  maxDepth: number;
  expectedCanonicalPath?: string;
}

export interface RepositoryReadResult {
  files: RepositoryFile[];
  totalSize: number;
  skippedBinaryFiles: number;
  skippedByTotalSize: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export async function collectRepositoryFiles(
  repositoryPath: string,
  filterEngine: FilterEngine,
  limits: RepositoryReadLimits,
  signal?: AbortSignal
): Promise<RepositoryReadResult> {
  const canonicalRepositoryPath = await fs.realpath(repositoryPath);
  if (
    limits.expectedCanonicalPath !== undefined &&
    canonicalRepositoryPath !== limits.expectedCanonicalPath
  ) {
    throw new Error('Repository path changed after access validation');
  }
  const files: RepositoryFile[] = [];
  let totalSize = 0;
  let skippedBinaryFiles = 0;
  let skippedByTotalSize = 0;
  let scannedEntries = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    throwIfAborted(signal);

    if (depth > limits.maxDepth) {
      throw new Error(`Repository exceeds maximum depth of ${limits.maxDepth}`);
    }

    if (files.length >= limits.maxFiles || totalSize >= limits.maxTotalSize) {
      return;
    }

    const canonicalDirectory = await fs.realpath(directory);
    if (!isPathInside(canonicalDirectory, canonicalRepositoryPath)) {
      throw new Error('Repository directory escaped its configured root');
    }

    const relativeDirectoryPath = relative(
      canonicalRepositoryPath,
      canonicalDirectory
    )
      .split(sep)
      .join('/');
    await filterEngine.loadDirectoryIgnorePatterns(
      canonicalDirectory,
      relativeDirectoryPath,
      signal
    );

    const entries: Dirent[] = [];
    const directoryHandle = await fs.opendir(canonicalDirectory);
    for await (const entry of directoryHandle) {
      scannedEntries += 1;
      if (scannedEntries > limits.maxEntries) {
        throw new Error(
          `Repository scan exceeds maximum of ${limits.maxEntries} entries`
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => comparePathNames(left.name, right.name));

    for (const entry of entries) {
      throwIfAborted(signal);

      if (files.length >= limits.maxFiles || totalSize >= limits.maxTotalSize) {
        break;
      }

      const fullPath = join(canonicalDirectory, entry.name);
      const relativePath = relative(canonicalRepositoryPath, fullPath)
        .split(sep)
        .join('/');

      if (entry.isDirectory()) {
        if (filterEngine.shouldTraverseDirectory(relativePath, signal)) {
          await walk(fullPath, depth + 1);
        }
        continue;
      }

      // Symlinks and special files are intentionally ignored so a repository
      // cannot make the reader escape its root or block on a device/FIFO.
      if (!entry.isFile()) {
        continue;
      }

      let fileHandle: FileHandle | undefined;
      try {
        fileHandle = await fs.open(
          fullPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const stats = await fileHandle.stat();
        if (!stats.isFile()) {
          continue;
        }

        const filterResult = filterEngine.shouldIncludeFile(
          relativePath,
          stats.size,
          undefined,
          signal
        );
        if (!filterResult.shouldInclude) {
          continue;
        }

        const [pathStats, canonicalFilePath] = await Promise.all([
          fs.lstat(fullPath),
          fs.realpath(fullPath),
        ]);
        if (
          !pathStats.isFile() ||
          pathStats.dev !== stats.dev ||
          pathStats.ino !== stats.ino ||
          !isPathInside(canonicalFilePath, canonicalRepositoryPath)
        ) {
          continue;
        }

        if (totalSize + stats.size > limits.maxTotalSize) {
          skippedByTotalSize += 1;
          continue;
        }

        const buffer = await readFileWithinLimit(
          fileHandle,
          stats.size,
          Math.min(limits.maxFileSize, limits.maxTotalSize - totalSize),
          signal
        );
        throwIfAborted(signal);
        if (!buffer) {
          skippedByTotalSize += 1;
          continue;
        }

        const actualSizeFilter = filterEngine.shouldIncludeFile(
          relativePath,
          buffer.byteLength,
          undefined,
          signal
        );
        if (!actualSizeFilter.shouldInclude) {
          continue;
        }

        const content = decodeTextFile(buffer);
        if (content === undefined) {
          skippedBinaryFiles += 1;
          continue;
        }

        if (totalSize + buffer.byteLength > limits.maxTotalSize) {
          skippedByTotalSize += 1;
          continue;
        }

        files.push({
          path: relativePath,
          content,
          size: buffer.byteLength,
          type: 'file',
        });
        totalSize += buffer.byteLength;
      } catch (error) {
        if (signal?.aborted) {
          throwIfAborted(signal);
        }

        // A file can disappear or become unreadable while the repository is
        // being scanned. Skipping it keeps ingestion useful and deterministic.
        if (isExpectedFileReadError(error)) {
          continue;
        }
        throw error;
      } finally {
        await fileHandle?.close().catch(() => undefined);
      }
    }
  };

  await walk(canonicalRepositoryPath, 0);

  return {
    files,
    totalSize,
    skippedBinaryFiles,
    skippedByTotalSize,
  };
}

function decodeTextFile(buffer: Buffer): string | undefined {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return undefined;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return undefined;
  }
}

function isExpectedFileReadError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  return ['EACCES', 'ELOOP', 'ENOENT', 'ENXIO', 'EISDIR', 'EPERM'].includes(
    String((error as NodeJS.ErrnoException).code)
  );
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

function comparePathNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readFileWithinLimit(
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
