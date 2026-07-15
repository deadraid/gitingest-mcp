import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { isAbortError, throwIfAborted } from '../utils/index.js';
import {
  isValidGitCommit,
  isValidNamedGitReference,
} from '../utils/git-reference.js';

export interface GitCloneOptions {
  url: string;
  branch?: string;
  commit?: string;
  tag?: string;
  depth?: number;
  sparse?: boolean;
  subpath?: string;
  includeSubmodules?: boolean;
  auth?: {
    token: string;
    username: string;
  };
}

export interface GitCloneResult {
  path: string;
  cleanupPath?: string;
  branch: string;
  commit: string;
  isShallow: boolean;
}

interface GitCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  secrets?: string[];
}

export class GitCloneTool {
  private static readonly DEFAULT_DEPTH = 1;
  private static readonly MAX_DEPTH = 1000;
  private static readonly MAX_COMMAND_OUTPUT = 64 * 1024;
  private static readonly MAX_ERROR_LENGTH = 16 * 1024;

  static async clone(
    options: GitCloneOptions,
    signal?: AbortSignal
  ): Promise<GitCloneResult> {
    throwIfAborted(signal);

    if (options.auth && options.includeSubmodules) {
      throw new Error(
        'Token authentication cannot be combined with includeSubmodules because a repository can redirect credentials to an untrusted submodule host'
      );
    }

    const depth = options.depth ?? this.DEFAULT_DEPTH;
    this.validateOptions(options, depth);

    const workspacePath = await fs.mkdtemp(join(tmpdir(), 'gitingest-'));
    const repositoryPath = join(workspacePath, 'repository');
    const globalConfigPath = join(workspacePath, 'gitconfig');
    let askPassPath: string | undefined;

    try {
      await fs.writeFile(globalConfigPath, '', { mode: 0o600 });
      askPassPath = options.auth
        ? await this.createAskPassHelper(workspacePath)
        : undefined;
      const gitEnvironment = this.createGitEnvironment(
        globalConfigPath,
        options.url,
        options.auth
      );
      const commandOptions: GitCommandOptions = {
        signal,
        env: options.auth
          ? {
              ...gitEnvironment,
              GIT_ASKPASS: askPassPath,
              GIT_ASKPASS_REQUIRE: 'force',
              GITINGEST_GIT_USERNAME: options.auth.username,
              GITINGEST_GIT_TOKEN: options.auth.token,
            }
          : gitEnvironment,
        secrets: options.auth ? [options.auth.token] : [],
      };
      const cloneArgs = ['clone'];

      if (options.branch) {
        cloneArgs.push('--branch', options.branch);
      } else if (options.tag) {
        cloneArgs.push('--branch', options.tag);
      }

      if (depth > 0 && depth <= this.MAX_DEPTH) {
        cloneArgs.push('--depth', depth.toString());
      }

      if (options.sparse && options.subpath) {
        cloneArgs.push('--filter=blob:none', '--sparse');
      }

      if (options.includeSubmodules) {
        cloneArgs.push('--recurse-submodules', '--shallow-submodules');
      }

      cloneArgs.push('--', options.url, repositoryPath);
      await this.executeGitCommand(cloneArgs, commandOptions);

      const repositoryCommandOptions = {
        ...commandOptions,
        cwd: repositoryPath,
      };

      if (options.commit) {
        await this.executeGitCommand(
          ['fetch', '--depth', depth.toString(), 'origin', options.commit],
          repositoryCommandOptions
        );
        await this.executeGitCommand(
          ['checkout', '--detach', options.commit],
          repositoryCommandOptions
        );
      }

      if (options.sparse && options.subpath) {
        await this.executeGitCommand(
          ['sparse-checkout', 'set', '--', options.subpath],
          repositoryCommandOptions
        );
      }

      const metadataEnvironment = { ...commandOptions.env };
      delete metadataEnvironment.GIT_ASKPASS;
      delete metadataEnvironment.GIT_ASKPASS_REQUIRE;
      delete metadataEnvironment.GITINGEST_GIT_USERNAME;
      delete metadataEnvironment.GITINGEST_GIT_TOKEN;
      const [branch, commit, isShallow] = await Promise.all([
        this.getCurrentBranch(repositoryPath, signal, metadataEnvironment),
        this.getCurrentCommit(repositoryPath, signal, metadataEnvironment),
        this.isShallowRepository(repositoryPath, signal, metadataEnvironment),
      ]);

      return {
        path: repositoryPath,
        cleanupPath: workspacePath,
        branch,
        commit,
        isShallow,
      };
    } catch (error) {
      await this.cleanup(workspacePath);
      throw error;
    } finally {
      if (askPassPath) {
        await fs.rm(askPassPath, { force: true }).catch(() => undefined);
      }
    }
  }

  static async getCurrentBranch(
    repositoryPath: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv
  ): Promise<string> {
    try {
      const output = await this.executeGitCommand(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: repositoryPath, signal, env: environment }
      );
      return output.trim() || 'unknown';
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'unknown';
    }
  }

  static async getCurrentCommit(
    repositoryPath: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv
  ): Promise<string> {
    try {
      const output = await this.executeGitCommand(['rev-parse', 'HEAD'], {
        cwd: repositoryPath,
        signal,
        env: environment,
      });
      return output.trim() || 'unknown';
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'unknown';
    }
  }

  static async getBranches(
    repositoryPath: string,
    remote = true,
    signal?: AbortSignal
  ): Promise<string[]> {
    try {
      const output = await this.executeGitCommand(
        remote ? ['branch', '-r'] : ['branch', '-l'],
        { cwd: repositoryPath, signal }
      );
      return output
        .split('\n')
        .map((branch) => branch.trim().replace(/^origin\//, ''))
        .filter((branch) => branch && !branch.includes('HEAD'));
    } catch (error) {
      if (isAbortError(error)) throw error;
      return [];
    }
  }

  static async getTags(
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    try {
      const output = await this.executeGitCommand(['tag', '-l'], {
        cwd: repositoryPath,
        signal,
      });
      return output.split('\n').filter((tag) => tag.trim());
    } catch (error) {
      if (isAbortError(error)) throw error;
      return [];
    }
  }

  static async isShallowRepository(
    repositoryPath: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv
  ): Promise<boolean> {
    try {
      const output = await this.executeGitCommand(
        ['rev-parse', '--is-shallow-repository'],
        { cwd: repositoryPath, signal, env: environment }
      );
      return output.trim() === 'true';
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  static async cleanup(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }

  static async isGitAvailable(): Promise<boolean> {
    try {
      await this.executeGitCommand(['--version']);
      return true;
    } catch {
      return false;
    }
  }

  private static async createAskPassHelper(
    workspacePath: string
  ): Promise<string> {
    const askPassPath = join(workspacePath, 'askpass.mjs');
    const source = `#!/usr/bin/env node
const prompt = process.argv[2] ?? '';
const value = /username/i.test(prompt)
  ? process.env.GITINGEST_GIT_USERNAME
  : process.env.GITINGEST_GIT_TOKEN;
process.stdout.write(value ?? '');
`;
    await fs.writeFile(askPassPath, source, { mode: 0o700 });
    return askPassPath;
  }

  private static createGitEnvironment(
    globalConfigPath: string,
    repositoryUrl: string,
    auth?: GitCloneOptions['auth']
  ): NodeJS.ProcessEnv {
    const environment = this.createIsolatedEnvironment(globalConfigPath);

    return {
      ...environment,
      GIT_ALLOW_PROTOCOL: this.isLocalCloneSource(repositoryUrl)
        ? 'file:https:http:ssh:git'
        : 'https:http:ssh:git',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.followRedirects',
      GIT_CONFIG_VALUE_0: 'false',
      ...(auth ? { GCM_INTERACTIVE: 'Never' } : {}),
    };
  }

  private static createIsolatedEnvironment(
    globalConfigPath = devNull
  ): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GIT_')) {
        delete environment[key];
      }
    }
    delete environment.SSH_ASKPASS;
    delete environment.SSH_ASKPASS_REQUIRE;

    return {
      ...environment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfigPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PROTOCOL_FROM_USER: '0',
    };
  }

  private static isLocalCloneSource(repositoryUrl: string): boolean {
    return (
      isAbsolute(repositoryUrl) ||
      repositoryUrl.startsWith('./') ||
      repositoryUrl.startsWith('../') ||
      repositoryUrl.startsWith('file://')
    );
  }

  private static validateOptions(
    options: GitCloneOptions,
    depth: number
  ): void {
    if (!Number.isInteger(depth) || depth < 1 || depth > this.MAX_DEPTH) {
      throw new Error(`Clone depth must be between 1 and ${this.MAX_DEPTH}`);
    }

    if (
      options.auth &&
      (!options.auth.token ||
        !options.auth.username ||
        this.hasCharacterInRange(options.auth.token, 0, 0x1f) ||
        options.auth.token.includes(String.fromCodePoint(0x7f)) ||
        this.hasCharacterInRange(options.auth.username, 0, 0x20) ||
        options.auth.username.includes(String.fromCodePoint(0x7f)))
    ) {
      throw new Error('Invalid Git authentication parameters');
    }

    this.validateNamedReference(options.branch, 'branch');
    if (options.commit && !isValidGitCommit(options.commit)) {
      throw new Error('Invalid Git commit');
    }
    this.validateNamedReference(options.tag, 'tag');

    const references = [options.branch, options.commit, options.tag].filter(
      Boolean
    );
    if (references.length > 1) {
      throw new Error('Only one Git branch, commit, or tag may be specified');
    }

    if (options.sparse && !options.subpath) {
      throw new Error('Sparse checkout requires a subpath');
    }
    if (options.subpath && !options.sparse) {
      throw new Error('A sparse-checkout subpath requires sparse mode');
    }

    if (options.subpath) {
      const normalizedPath = options.subpath.replaceAll('\\', '/');
      if (
        normalizedPath.startsWith('/') ||
        normalizedPath.split('/').includes('..') ||
        this.hasCharacterInRange(normalizedPath, 0, 0x1f) ||
        normalizedPath.includes(String.fromCodePoint(0x7f))
      ) {
        throw new Error(
          'Sparse-checkout subpath must stay inside the repository'
        );
      }
    }
  }

  private static validateNamedReference(
    reference: string | undefined,
    label: string
  ): void {
    if (reference && !isValidNamedGitReference(reference)) {
      throw new Error(`Invalid Git ${label}`);
    }
  }

  private static executeGitCommand(
    args: string[],
    options: GitCommandOptions = {}
  ): Promise<string> {
    throwIfAborted(options.signal);

    return new Promise((resolve, reject) => {
      const git = spawn('git', args, {
        cwd: options.cwd,
        env: options.env ?? this.createIsolatedEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: options.signal,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let processError: Error | undefined;

      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= this.MAX_COMMAND_OUTPUT) return current;
        return (current + chunk.toString()).slice(0, this.MAX_COMMAND_OUTPUT);
      };

      git.stdout.on('data', (data: Buffer) => {
        stdout = append(stdout, data);
      });
      git.stderr.on('data', (data: Buffer) => {
        stderr = append(stderr, data);
      });

      git.on('error', (error) => {
        if (settled) return;
        processError = error;
      });

      git.on('close', (code) => {
        if (settled) return;
        settled = true;

        if (processError) {
          if (isAbortError(processError)) {
            reject(processError);
            return;
          }
          reject(new Error(`Failed to execute git: ${processError.message}`));
          return;
        }

        if (code === 0) {
          resolve(stdout);
          return;
        }

        const message = this.sanitizeGitError(
          this.redactSecrets(stderr || stdout, options.secrets)
        );
        reject(
          new Error(
            `Git command failed: ${message.trim() || 'process terminated unexpectedly'}`
          )
        );
      });
    });
  }

  private static redactSecrets(value: string, secrets: string[] = []): string {
    return secrets.reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      value
    );
  }

  private static sanitizeGitError(value: string): string {
    return [...value]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint === 0x09 ||
          codePoint === 0x0a ||
          codePoint === 0x0d ||
          (codePoint >= 0x20 && codePoint !== 0x7f)
        );
      })
      .join('')
      .slice(0, this.MAX_ERROR_LENGTH);
  }

  private static hasCharacterInRange(
    value: string,
    minimum: number,
    maximum: number
  ): boolean {
    return [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= minimum && codePoint <= maximum;
    });
  }
}
