import { z } from "zod";
import fetch, { Response as FetchResponse } from "node-fetch";

// Schema for ingest tool input
export const ingestSchema = z.object({
  repository: z.string().describe("Git repository URL or local path"),
  token: z
    .string()
    .optional()
    .describe("GitHub Personal Access Token for private repositories"),
  includeSubmodules: z
    .boolean()
    .default(false)
    .describe("Include repository submodules in the digest"),
  includeGitignored: z
    .boolean()
    .default(false)
    .describe("Include files listed in .gitignore"),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe('Glob patterns to exclude files (e.g., "*.md", "test/*")'),
  maxFileSize: z
    .number()
    .optional()
    .describe("Maximum file size in bytes to include (default: unlimited)"),
  maxRetries: z.number().default(3).describe("Maximum retry attempts"),
  retryDelay: z
    .number()
    .default(1000)
    .describe("Base delay in milliseconds between retry attempts"),
});

export type IngestInput = z.infer<typeof ingestSchema>;

// Schema for repository file
export interface RepositoryFile {
  path: string;
  content: string;
  size: number;
}

// Schema for repository tree node
export interface TreeNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  children?: TreeNode[];
}

// Schema for repository summary
export interface RepositorySummary {
  url: string;
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
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}> {
  try {
    // Validate input
    const parsedInput = ingestSchema.parse(input);

    // Extract repository information
    const { owner, repo, branch, subdirectory } = parseRepositoryUrl(
      parsedInput.repository,
    );
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

    // Set up headers with authentication if token provided
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "gitingest-mcp/1.0.0",
    };

    if (parsedInput.token) {
      headers["Authorization"] = `Bearer ${parsedInput.token}`;
    }

    // Fetch repository metadata
    const repoResponse = await fetchWithRetry(`${baseUrl}`, {
      headers,
      maxRetries: parsedInput.maxRetries,
      retryDelay: parsedInput.retryDelay,
    });

    if (!repoResponse.ok) {
      throw new Error(
        `Failed to fetch repository: ${repoResponse.status} ${repoResponse.statusText}`,
      );
    }

    const repoData = (await repoResponse.json()) as {
      default_branch: string;
      [key: string]: unknown;
    };

    // Fetch repository tree
    const treeUrl = subdirectory
      ? `${baseUrl}/contents/${subdirectory}?ref=${branch}&recursive=1`
      : `${baseUrl}/git/trees/${branch}?recursive=1`;

    const treeResponse = await fetchWithRetry(treeUrl, {
      headers,
      maxRetries: parsedInput.maxRetries,
      retryDelay: parsedInput.retryDelay,
    });

    if (!treeResponse.ok) {
      throw new Error(
        `Failed to fetch repository tree: ${treeResponse.status} ${treeResponse.statusText}`,
      );
    }

    const treeData = (await treeResponse.json()) as {
      items?: Array<{
        type: string;
        path: string;
        size: number;
        download_url: string;
      }>;
      tree?: Array<{
        type: string;
        path: string;
        size: number;
        url: string;
      }>;
    };

    // Process tree and fetch file contents
    const files: RepositoryFile[] = [];
    const excludePatterns = parsedInput.excludePatterns || [];

    for (const item of treeData.items || treeData.tree || []) {
      // Skip directories
      if (item.type === "dir") continue;

      // Skip gitignored files unless explicitly included
      if (!parsedInput.includeGitignored && isGitignored(item.path)) continue;

      // Skip excluded patterns
      if (matchesPattern(item.path, excludePatterns)) continue;

      // Skip files larger than maxFileSize
      if (parsedInput.maxFileSize && item.size > parsedInput.maxFileSize)
        continue;

      // Fetch file content
      const contentResponse = await fetchWithRetry(
        "download_url" in item ? item.download_url : item.url,
        {
          headers,
          maxRetries: parsedInput.maxRetries,
          retryDelay: parsedInput.retryDelay,
        },
      );

      if (!contentResponse.ok) {
        console.warn(
          `Failed to fetch file ${item.path}: ${contentResponse.status} ${contentResponse.statusText}`,
        );
        continue;
      }

      const content = await contentResponse.text();

      files.push({
        path: item.path,
        content,
        size: item.size,
      });
    }

    // Build directory tree structure
    const tree = buildTree(files);

    // Generate repository summary
    const summary: RepositorySummary = {
      url: parsedInput.repository,
      branch: branch,
      commit:
        repoData.default_branch === branch ? repoData.default_branch : branch,
      fileCount: files.length,
      directoryCount: countDirectories(tree),
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      tokenCount: estimateTokenCount(files),
      createdAt: new Date().toISOString(),
    };

    // Generate text digest
    const digest = generateTextDigest(summary, tree, files);

    return {
      content: [
        {
          type: "text",
          text: digest,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error ingesting repository: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Parse repository URL to extract owner, repo, branch, and subdirectory
 */
function parseRepositoryUrl(url: string): {
  owner: string;
  repo: string;
  branch: string;
  subdirectory: string | null;
} {
  // Handle local paths
  if (url.startsWith("/") || url.startsWith(".")) {
    throw new Error(
      "Local repository paths are not supported in this implementation",
    );
  }

  // Handle GitHub URLs
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?/,
  );
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      branch: match[3] || "main",
      subdirectory: match[4] || null,
    };
  }

  throw new Error("Invalid repository URL. Must be a GitHub repository URL");
}

/**
 * Check if a file path is in .gitignore
 */
function isGitignored(path: string): boolean {
  // This is a simplified implementation
  // In a complete implementation, we would fetch and parse the .gitignore file
  const gitignorePatterns = [
    ".git",
    ".gitignore",
    ".gitmodules",
    ".DS_Store",
    "node_modules",
    "package-lock.json",
    "yarn.lock",
    "npm-debug.log",
    "*.log",
    "*.tmp",
    "*.temp",
    "*~",
    "#*#",
    ".#*",
    ".*.swp",
    ".*.swo",
    ".vscode",
    ".idea",
    ".env",
    ".env.local",
  ];

  return gitignorePatterns.some((pattern) => {
    if (pattern.startsWith("*.") && path.endsWith(pattern.substring(1))) {
      return true;
    }
    if (
      pattern.endsWith("/*") &&
      path.startsWith(pattern.substring(0, pattern.length - 1))
    ) {
      return true;
    }
    return path === pattern;
  });
}

/**
 * Check if a file path matches any of the exclude patterns
 */
function matchesPattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.") && path.endsWith(pattern.substring(1))) {
      return true;
    }
    if (
      pattern.endsWith("/*") &&
      path.startsWith(pattern.substring(0, pattern.length - 1))
    ) {
      return true;
    }
    if (
      pattern.includes("*") &&
      !pattern.startsWith("*.") &&
      !pattern.endsWith("/*")
    ) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      return regex.test(path);
    }
    return path === pattern;
  });
}

/**
 * Build a tree structure from a list of files
 */
function buildTree(files: RepositoryFile[]): TreeNode {
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

      if (i === parts.length - 1) {
        // This is a file
        if (!current.children) current.children = [];
        current.children.push({
          name: part,
          type: "file",
          size: file.size,
        });
      } else {
        // This is a directory
        let child = current.children?.find(
          (c) => c.name === part && c.type === "directory",
        );
        if (!child) {
          child = {
            name: part,
            type: "directory",
            children: [],
          };
          if (!current.children) current.children = [];
          current.children.push(child);
        }
        current = child;
      }
    }
  }

  return root;
}

/**
 * Count the number of directories in a tree
 */
function countDirectories(node: TreeNode): number {
  let count = 0;
  if (node.children) {
    for (const child of node.children) {
      if (child.type === "directory") {
        count++;
        count += countDirectories(child);
      }
    }
  }
  return count;
}

/**
 * Estimate token count for a list of files
 * This is a simplified estimation based on characters
 */
function estimateTokenCount(files: RepositoryFile[]): number {
  // Rough estimation: 1 token ~= 4 characters for code
  const totalChars = files.reduce((sum, file) => sum + file.content.length, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Generate a text digest from repository data
 */
function generateTextDigest(
  summary: RepositorySummary,
  tree: TreeNode,
  files: RepositoryFile[],
): string {
  const lines: string[] = [];

  lines.push("# Repository Summary");
  lines.push("");
  lines.push(`- **URL**: ${summary.url}`);
  lines.push(`- **Branch**: ${summary.branch}`);
  lines.push(`- **Files**: ${summary.fileCount}`);
  lines.push(`- **Directories**: ${summary.directoryCount}`);
  lines.push(`- **Size**: ${formatBytes(summary.totalSize)}`);
  lines.push(`- **Estimated Tokens**: ${summary.tokenCount.toLocaleString()}`);
  lines.push(
    `- **Generated**: ${new Date(summary.createdAt).toLocaleString()}`,
  );
  lines.push("");
  lines.push("# Directory Structure");
  lines.push("");
  lines.push("```\n" + renderTree(tree) + "\n```");
  lines.push("");
  lines.push("# File Contents");
  lines.push("");

  for (const file of files) {
    const extension = file.path.split(".").pop() || "";
    lines.push(`## ${file.path}`);
    lines.push("");
    lines.push(`\`\`\`${extension}\n${file.content}\n\`\`\``);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render a tree structure as text
 */
function renderTree(node: TreeNode, prefix = "", isLast = true): string {
  if (!node.children || node.children.length === 0) return "";

  const lines: string[] = [];
  const connector = isLast ? "└── " : "├── ";

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLastChild = i === node.children.length - 1;
    const newPrefix = prefix + (isLast ? "    " : "│   ");

    lines.push(
      `${prefix}${connector}${child.name}${child.type === "directory" ? "/" : ""}${child.size ? ` (${formatBytes(child.size)})` : ""}`,
    );

    if (child.type === "directory" && child.children) {
      lines.push(renderTree(child, newPrefix, isLastChild));
    }
  }

  return lines.join("\n");
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Fetch with retry logic
 */
async function fetchWithRetry(
  url: string,
  options: {
    headers: Record<string, string>;
    maxRetries: number;
    retryDelay: number;
  },
): Promise<FetchResponse> {
  let lastError: Error | null = null;

  for (let i = 0; i <= options.maxRetries; i++) {
    try {
      const response = await fetch(url, { headers: options.headers });
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < options.maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.retryDelay * Math.pow(2, i)),
        );
      }
    }
  }

  throw lastError;
}
