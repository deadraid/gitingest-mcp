import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitCloneTool } from '../../src/tools/git-clone.js';
import { ingestTool, type IngestToolResult } from '../../src/tools/ingest.js';

describe('remote repository ingestion', () => {
  let workspacePath: string;
  let repositoryPath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(join(tmpdir(), 'gitingest-remote-test-'));
    repositoryPath = join(workspacePath, 'repository');
    await fs.mkdir(repositoryPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('passes HTTPS token authentication without placing it in output', async () => {
    // Arrange
    await fs.writeFile(join(repositoryPath, 'README.md'), '# repository');
    const clone = vi.spyOn(GitCloneTool, 'clone').mockResolvedValue({
      path: repositoryPath,
      cleanupPath: workspacePath,
      branch: 'main',
      commit: 'abc123',
      isShallow: true,
    });
    const cleanup = vi.spyOn(GitCloneTool, 'cleanup').mockResolvedValue();

    // Act
    const result = await ingestTool({
      repository: 'https://github.com/owner/repository',
      token: 'top-secret-token',
    });
    const output = resultText(result);

    // Assert
    expect(clone).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://github.com/owner/repository.git',
        auth: {
          token: 'top-secret-token',
          username: 'x-access-token',
        },
      }),
      expect.any(AbortSignal)
    );
    expect(output).toContain('## README.md');
    expect(output).not.toContain('top-secret-token');
    expect(cleanup).toHaveBeenCalledWith(workspacePath);
  });

  it('cleans a successful clone when scanning fails afterwards', async () => {
    // Arrange
    const missingPath = join(workspacePath, 'missing');
    vi.spyOn(GitCloneTool, 'clone').mockResolvedValue({
      path: missingPath,
      cleanupPath: workspacePath,
      branch: 'main',
      commit: 'abc123',
      isShallow: true,
    });
    const cleanup = vi.spyOn(GitCloneTool, 'cleanup').mockResolvedValue();

    // Act
    const result = await ingestTool({ repository: 'owner/repository' });

    // Assert
    expect(result.isError).toBe(true);
    expect(cleanup).toHaveBeenCalledWith(workspacePath);
  });

  it('preserves SSH URLs and rejects an unrelated token', async () => {
    // Arrange
    const clone = vi.spyOn(GitCloneTool, 'clone');

    // Act
    const result = await ingestTool({
      repository: 'git@github.com:owner/private.git',
      token: 'unused-token',
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('supported only for HTTPS');
    expect(clone).not.toHaveBeenCalled();
  });

  it('rejects remote hosts outside the transport allowlist', async () => {
    // Arrange
    const clone = vi.spyOn(GitCloneTool, 'clone');

    // Act
    const result = await ingestTool(
      { repository: 'https://code.example.com/team/repository.git' },
      {
        allowUnrestrictedRemoteRepositories: false,
        allowedRemoteHosts: ['github.com'],
      }
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('outside the configured allowlist');
    expect(clone).not.toHaveBeenCalled();
  });

  it('allows explicitly configured wildcard remote hosts', async () => {
    // Arrange
    await fs.writeFile(join(repositoryPath, 'README.md'), '# repository');
    const clone = vi.spyOn(GitCloneTool, 'clone').mockResolvedValue({
      path: repositoryPath,
      cleanupPath: workspacePath,
      branch: 'main',
      commit: 'abc123',
      isShallow: true,
    });
    vi.spyOn(GitCloneTool, 'cleanup').mockResolvedValue();

    // Act
    const result = await ingestTool(
      { repository: 'https://git.code.example.com/team/repository.git' },
      {
        allowUnrestrictedRemoteRepositories: false,
        allowedRemoteHosts: ['*.code.example.com'],
      }
    );

    // Assert
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('## README.md');
    expect(clone).toHaveBeenCalledOnce();
  });

  it('never sends a token over plain HTTP', async () => {
    // Arrange
    const clone = vi.spyOn(GitCloneTool, 'clone');

    // Act
    const result = await ingestTool({
      repository: 'http://code.example.com/team/repository.git',
      token: 'must-not-be-sent',
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('supported only for HTTPS');
    expect(clone).not.toHaveBeenCalled();
  });

  it('blocks unencrypted remote transports when the server requires it', async () => {
    // Arrange
    const clone = vi.spyOn(GitCloneTool, 'clone');

    // Act
    const results = await Promise.all([
      ingestTool(
        { repository: 'http://github.com/owner/repository.git' },
        { allowInsecureRemoteRepositories: false }
      ),
      ingestTool(
        { repository: 'git://github.com/owner/repository.git' },
        { allowInsecureRemoteRepositories: false }
      ),
    ]);

    // Assert
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('transports are disabled');
    }
    expect(clone).not.toHaveBeenCalled();
  });

  it('blocks submodule egress when the transport disables it', async () => {
    // Arrange
    const clone = vi.spyOn(GitCloneTool, 'clone');

    // Act
    const result = await ingestTool(
      {
        repository: 'https://github.com/owner/repository.git',
        includeSubmodules: true,
      },
      { allowSubmodules: false }
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Submodule cloning is disabled');
    expect(clone).not.toHaveBeenCalled();
  });

  it('forwards refs, sparse checkout, and submodule options precisely', async () => {
    // Arrange
    await fs.writeFile(join(repositoryPath, 'README.md'), '# repository');
    const clone = vi.spyOn(GitCloneTool, 'clone').mockResolvedValue({
      path: repositoryPath,
      cleanupPath: workspacePath,
      branch: 'main',
      commit: 'abc123',
      isShallow: true,
    });
    vi.spyOn(GitCloneTool, 'cleanup').mockResolvedValue();

    // Act
    const results = await Promise.all([
      ingestTool({ repository: 'owner/repository', branch: 'feature/topic' }),
      ingestTool({ repository: 'owner/repository', tag: 'v1.0.0' }),
      ingestTool({ repository: 'owner/repository', commit: 'abc123' }),
      ingestTool({
        repository: 'owner/repository',
        sparseCheckout: true,
        subpath: 'src',
        includeSubmodules: true,
      }),
    ]);
    const cloneOptions = clone.mock.calls.map(([options]) => options);

    // Assert
    expect(results.every((result) => result.isError === undefined)).toBe(true);
    expect(cloneOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: 'feature/topic',
          commit: undefined,
          tag: undefined,
        }),
        expect.objectContaining({
          branch: undefined,
          commit: undefined,
          tag: 'v1.0.0',
        }),
        expect.objectContaining({
          branch: undefined,
          commit: 'abc123',
          tag: undefined,
        }),
        expect.objectContaining({
          sparse: true,
          subpath: 'src',
          includeSubmodules: true,
        }),
      ])
    );
  });

  it('retries only transient clone failures and eventually succeeds', async () => {
    // Arrange
    await fs.writeFile(join(repositoryPath, 'README.md'), '# repository');
    const clone = vi
      .spyOn(GitCloneTool, 'clone')
      .mockRejectedValueOnce(new Error('Connection reset by peer'))
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValue({
        path: repositoryPath,
        cleanupPath: workspacePath,
        branch: 'main',
        commit: 'abc123',
        isShallow: true,
      });
    vi.spyOn(GitCloneTool, 'cleanup').mockResolvedValue();

    // Act
    const result = await ingestTool({
      repository: 'owner/repository',
      maxRetries: 2,
      retryDelay: 0,
    });

    // Assert
    expect(result.isError).toBeUndefined();
    expect(clone).toHaveBeenCalledTimes(3);
    expect(resultText(result)).toContain('## README.md');
  });

  it('does not retry permanent clone failures', async () => {
    // Arrange
    const clone = vi
      .spyOn(GitCloneTool, 'clone')
      .mockRejectedValue(new Error('Authentication failed'));

    // Act
    const result = await ingestTool({
      repository: 'owner/repository',
      maxRetries: 10,
      retryDelay: 0,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Authentication failed');
    expect(clone).toHaveBeenCalledOnce();
  });

  it('stops after the configured number of transient retries', async () => {
    // Arrange
    const clone = vi
      .spyOn(GitCloneTool, 'clone')
      .mockRejectedValue(new Error('Network timeout'));

    // Act
    const result = await ingestTool({
      repository: 'owner/repository',
      maxRetries: 2,
      retryDelay: 0,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Network timeout');
    expect(clone).toHaveBeenCalledTimes(3);
  });
});

function resultText(result: IngestToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}
