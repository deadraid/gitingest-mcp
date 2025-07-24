import { spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

export interface GitCloneOptions {
  url: string;
  branch?: string;
  commit?: string;
  tag?: string;
  depth?: number;
  sparse?: boolean;
  subpath?: string;
  includeSubmodules?: boolean;
}

export interface GitCloneResult {
  path: string;
  branch: string;
  commit: string;
  isShallow: boolean;
}

export class GitCloneTool {
  private static readonly DEFAULT_DEPTH = 1;
  private static readonly MAX_DEPTH = 1000;

  static async clone(options: GitCloneOptions, signal?: AbortSignal): Promise<GitCloneResult> {
    const {
      url,
      branch,
      commit,
      tag,
      depth = this.DEFAULT_DEPTH,
      sparse = false,
      subpath,
      includeSubmodules = false,
    } = options;

    // Create temporary directory
    const tempDir = await this.createTempDir();
    
    try {
      // Clone repository
      const cloneArgs = ["clone"];
      
      // Add branch/tag/commit
      if (branch) {
        cloneArgs.push("--branch", branch);
      } else if (tag) {
        cloneArgs.push("--branch", tag);
      }
      
      // Add depth
      if (depth && depth > 0 && depth <= this.MAX_DEPTH) {
        cloneArgs.push("--depth", depth.toString());
      }
      
      // Add sparse checkout
      if (sparse && subpath) {
        cloneArgs.push("--filter=blob:none", "--sparse");
      }
      
      // Add submodules
      if (includeSubmodules) {
        cloneArgs.push("--recurse-submodules");
      }
      
      cloneArgs.push(url, tempDir);
      
      await this.executeGitCommand(cloneArgs);
      
      // If specific commit is provided, checkout it
      if (commit) {
        await this.executeGitCommand(["checkout", commit], { cwd: tempDir });
      }
      
      // If sparse checkout with subpath
      if (sparse && subpath) {
        await this.executeGitCommand(["sparse-checkout", "set", subpath], { cwd: tempDir });
      }
      
      // Get actual branch and commit
      const branchName = await this.getCurrentBranch(tempDir);
      const commitHash = await this.getCurrentCommit(tempDir);
      
      return {
        path: tempDir,
        branch: branchName,
        commit: commitHash,
        isShallow: depth !== undefined && depth > 0,
      };
    } catch (error) {
      // Clean up on error
      await this.cleanup(tempDir);
      throw error;
    }
  }

  static async getCurrentBranch(repoPath: string): Promise<string> {
    try {
      const output = await this.executeGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
      return output.trim();
    } catch {
      return "main";
    }
  }

  static async getCurrentCommit(repoPath: string): Promise<string> {
    try {
      const output = await this.executeGitCommand(["rev-parse", "HEAD"], { cwd: repoPath });
      return output.trim();
    } catch {
      return "unknown";
    }
  }

  static async getBranches(repoPath: string, remote = true): Promise<string[]> {
    try {
      const args = remote ? ["branch", "-r"] : ["branch", "-l"];
      const output = await this.executeGitCommand(args, { cwd: repoPath });
      
      return output
        .split("\n")
        .map(branch => branch.trim().replace(/^origin\//, ""))
        .filter(branch => branch && !branch.includes("HEAD"));
    } catch {
      return [];
    }
  }

  static async getTags(repoPath: string): Promise<string[]> {
    try {
      const output = await this.executeGitCommand(["tag", "-l"], { cwd: repoPath });
      return output.split("\n").filter(tag => tag.trim());
    } catch {
      return [];
    }
  }

  static async getCommits(repoPath: string, maxCount = 10): Promise<Array<{ hash: string; message: string; author: string; date: string }>> {
    try {
      const format = "%H|%s|%an|%ad";
      const output = await this.executeGitCommand(
        ["log", `--format=${format}`, `--max-count=${maxCount}`],
        { cwd: repoPath }
      );
      
      return output
        .split("\n")
        .filter(line => line.trim())
        .map(line => {
          const [hash, message, author, date] = line.split("|");
          return { hash, message, author, date };
        });
    } catch {
      return [];
    }
  }

  private static async createTempDir(): Promise<string> {
    const tempBase = tmpdir();
    const tempDir = join(tempBase, `gitingest-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    await fs.mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  private static async executeGitCommand(args: string[], options: { cwd?: string, signal?: AbortSignal } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const git = spawn("git", args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      });

      let stdout = "";
      let stderr = "";

      git.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      git.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      git.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed: ${stderr || stdout}`));
        }
      });

      git.on("error", (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    });
  }

  static async cleanup(repoPath: string): Promise<void> {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  static async isGitAvailable(): Promise<boolean> {
    try {
      await this.executeGitCommand(["--version"]);
      return true;
    } catch {
      return false;
    }
  }
}