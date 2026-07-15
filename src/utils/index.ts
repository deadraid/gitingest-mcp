import { TreeNode, RepositoryFile } from '../types/index.js';

/**
 * Estimate the number of tokens in a text content
 * Rough estimation: 1 token ≈ 4 characters
 * @param content - Text content to estimate tokens for
 * @returns Estimated number of tokens
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Format bytes into human-readable format
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Build a tree structure from an array of files
 * @param files - Array of repository files
 * @returns Root node of the tree structure
 */
export function buildTree(files: RepositoryFile[]): TreeNode {
  const root: TreeNode = {
    name: '',
    type: 'directory',
    children: [],
  };
  const childDirectories = new WeakMap<TreeNode, Map<string, TreeNode>>();
  childDirectories.set(root, new Map());

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const directoryName = parts[index];
      if (directoryName === undefined) continue;
      const directories = childDirectories.get(current)!;
      let directory = directories.get(directoryName);
      if (!directory) {
        directory = {
          name: directoryName,
          type: 'directory',
          children: [],
        };
        current.children ??= [];
        current.children.push(directory);
        directories.set(directoryName, directory);
        childDirectories.set(directory, new Map());
      }
      current = directory;
    }

    current.children ??= [];
    current.children.push({
      name: parts.at(-1) ?? file.path,
      type: 'file',
      size: file.size,
    });
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeNode): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    current.children?.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });

    for (const child of current.children ?? []) {
      if (child.type === 'directory') {
        pending.push(child);
      }
    }
  }
}

/**
 * Count the number of directories in a tree structure
 * @param node - Root node of the tree
 * @returns Number of directories
 */
export function countDirectories(node: TreeNode): number {
  let count = 0;
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of current.children ?? []) {
      if (child.type === 'directory') {
        count += 1;
        pending.push(child);
      }
    }
  }
  return count;
}

/**
 * Parse ignore file content into an array of patterns
 * @param content - Content of the ignore file
 * @returns Array of ignore patterns
 */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Render a tree structure as a string
 * @param node - Root node of the tree
 * @param prefix - Prefix for current level (used for recursion)
 * @param isLast - Whether current node is the last child (used for recursion)
 * @returns String representation of the tree
 */
export function renderTree(
  node: TreeNode,
  prefix = '',
  maximumCharacters = Number.POSITIVE_INFINITY
): string {
  if (!node.children || node.children.length === 0) return '';

  const lines: string[] = [];
  const stack = [{ node, prefix, childIndex: 0 }];
  let renderedCharacters = 0;

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const children = frame.node.children ?? [];
    if (frame.childIndex >= children.length) {
      stack.pop();
      continue;
    }

    const child = children[frame.childIndex];
    frame.childIndex += 1;
    if (!child) continue;
    const isLastChild = frame.childIndex === children.length;
    const connector = isLastChild ? '└── ' : '├── ';
    const newPrefix = frame.prefix + (isLastChild ? '    ' : '│   ');
    const line = `${frame.prefix}${connector}${sanitizeTreeName(child.name)}${child.type === 'directory' ? '/' : ''}${child.size ? ` (${formatBytes(child.size)})` : ''}`;
    const separatorLength = lines.length === 0 ? 0 : 1;
    if (
      renderedCharacters + separatorLength + line.length >
      maximumCharacters
    ) {
      let marker = `${frame.prefix}... [tree truncated]`;
      if (marker.length > maximumCharacters) {
        marker = '... [tree truncated]';
      }
      while (
        lines.length > 0 &&
        renderedCharacters + (lines.length === 0 ? 0 : 1) + marker.length >
          maximumCharacters
      ) {
        const removedLine = lines.pop()!;
        renderedCharacters -= removedLine.length + (lines.length === 0 ? 0 : 1);
      }
      if (
        renderedCharacters + (lines.length === 0 ? 0 : 1) + marker.length <=
        maximumCharacters
      ) {
        lines.push(marker);
      }
      break;
    }

    lines.push(line);
    renderedCharacters += separatorLength + line.length;
    if (child.type === 'directory' && child.children) {
      stack.push({ node: child, prefix: newPrefix, childIndex: 0 });
    }
  }

  return lines.join('\n');
}

function sanitizeTreeName(name: string): string {
  return [...name]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? '�' : character;
    })
    .join('');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation aborted', 'AbortError');
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Operation aborted')
  );
}

export function abortableDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation aborted', 'AbortError')
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
