import { z } from "zod";

export const repositoryUrlSchema = z.object({
  url: z.string().describe("Repository URL, local path, or shorthand"),
  type: z.enum(["github", "gitlab", "bitbucket", "local", "git"]).optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  tag: z.string().optional(),
  subpath: z.string().optional(),
  isLocal: z.boolean().optional(),
});

export type RepositoryUrl = z.infer<typeof repositoryUrlSchema>;

export class GitUrlParser {
  private static readonly GITHUB_PATTERNS = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^([^/]+)\/([^/]+)$/i, // shorthand: owner/repo
  ];

  private static readonly GITLAB_PATTERNS = [
    /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/-\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i,
    /^git@gitlab\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];

  private static readonly BITBUCKET_PATTERNS = [
    /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:src|browse)\/([^/]+)(?:\/(.*))?)?$/i,
    /^git@bitbucket\.org:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];

  static parse(url: string): RepositoryUrl {
    // Normalize URL
    url = url.trim();

    // Check if it's a local path
    if (this.isLocalPath(url)) {
      return {
        url,
        type: "local",
        isLocal: true,
      };
    }

    // Check GitHub patterns
    for (const pattern of this.GITHUB_PATTERNS) {
      const match = url.match(pattern);
      if (match) {
        return {
          url,
          type: "github",
          owner: match[1],
          repo: match[2].replace(/\.git$/, ""),
          branch: match[3] || "main",
          subpath: match[4] || undefined,
          isLocal: false,
        };
      }
    }

    // Check GitLab patterns
    for (const pattern of this.GITLAB_PATTERNS) {
      const match = url.match(pattern);
      if (match) {
        return {
          url,
          type: "gitlab",
          owner: match[1],
          repo: match[2].replace(/\.git$/, ""),
          branch: match[3] || "main",
          subpath: match[4] || undefined,
          isLocal: false,
        };
      }
    }

    // Check Bitbucket patterns
    for (const pattern of this.BITBUCKET_PATTERNS) {
      const match = url.match(pattern);
      if (match) {
        return {
          url,
          type: "bitbucket",
          owner: match[1],
          repo: match[2].replace(/\.git$/, ""),
          branch: match[3] || "main",
          subpath: match[4] || undefined,
          isLocal: false,
        };
      }
    }

    // Generic git URL
    if (url.endsWith(".git") || url.startsWith("git@") || url.includes("git")) {
      return {
        url,
        type: "git",
        isLocal: false,
      };
    }

    throw new Error(`Unsupported repository URL format: ${url}`);
  }

  private static isLocalPath(path: string): boolean {
    // Check for absolute paths
    if (path.startsWith("/") || path.startsWith("~")) {
      return true;
    }

    // Check for relative paths
    if (path.startsWith("./") || path.startsWith("../") || path === ".") {
      return true;
    }

    // Check for Windows paths
    if (/^[a-zA-Z]:[\\/]/.test(path)) {
      return true;
    }

    // Check if it's a directory that exists (would be handled by fs later)
    return false;
  }

  static toHttpsUrl(parsed: RepositoryUrl): string {
    if (parsed.isLocal) return parsed.url;

    switch (parsed.type) {
      case "github":
        return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      case "gitlab":
        return `https://gitlab.com/${parsed.owner}/${parsed.repo}.git`;
      case "bitbucket":
        return `https://bitbucket.org/${parsed.owner}/${parsed.repo}.git`;
      case "git":
        return parsed.url;
      default:
        return parsed.url;
    }
  }

  static toApiUrl(parsed: RepositoryUrl): string {
    if (parsed.isLocal) return parsed.url;

    switch (parsed.type) {
      case "github":
        return `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
      case "gitlab":
        return `https://gitlab.com/api/v4/projects/${parsed.owner}%2F${parsed.repo}`;
      case "bitbucket":
        return `https://api.bitbucket.org/2.0/repositories/${parsed.owner}/${parsed.repo}`;
      default:
        throw new Error(`API not supported for type: ${parsed.type}`);
    }
  }
}