import { describe, it, expect, vi } from 'vitest';
import { ingestTool } from '../../src/tools/ingest.js';
const { LocalRepositoryTool } = await import(
  '../../src/tools/local-repository.js'
);


vi.mock('../../src/tools/git-clone.js', () => ({
  GitCloneTool: {
    clone: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock('../../src/tools/local-repository.js', () => ({
  LocalRepositoryTool: {
    analyze: vi.fn(),
  },
}));

vi.mock('../../src/tools/filter-engine.js', () => ({
  FilterEngine: vi.fn().mockImplementation(() => ({
    loadIgnorePatterns: vi.fn(),
    shouldIncludeFile: vi.fn().mockReturnValue({ shouldInclude: true }),
  })),
}));

describe('ingestTool timeout handling', () => {
  it('should handle timeout when processing takes too long', async () => {
    // Arrange
    vi.mocked(LocalRepositoryTool.analyze).mockImplementation(
      async (_, signal) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({
              path: '/tmp/repo',
              summary: {
                path: '/tmp/repo',
                branch: 'main',
                commit: 'abc123',
                fileCount: 1,
                directoryCount: 1,
                totalSize: 25,
                tokenCount: 7,
                createdAt: new Date().toISOString(),
              },
              files: [
                {
                  path: 'src/index.ts',
                  content: 'console.log("Hello World");',
                  size: 25,
                  type: 'file' as const,
                },
              ],
              tree: {
                name: '',
                type: 'directory' as const,
                children: [
                  {
                    name: 'src',
                    type: 'directory' as const,
                    children: [
                      {
                        name: 'index.ts',
                        type: 'file' as const,
                        size: 25,
                      },
                    ],
                  },
                ],
              },
            });
          }, 5000); // 5 seconds delay


          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Operation timed out after 1000ms'));
          });
        });
      }
    );

    // Act
    const result = await ingestTool({
      repository: '/path/to/local/repo',
      cloneDepth: 1,
      sparseCheckout: false,
      includeSubmodules: false,
      includeGitignored: false,
      useGitignore: true,
      useGitingestignore: true,
      maxFiles: 1000,
      maxFileSize: undefined,
      excludePatterns: [],
      includePatterns: [],
      maxTotalSize: 50 * 1024 * 1024,
      token: undefined,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 1000, // 1 second timeout
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Operation timed out after 1000ms'
    );
  }, 10000); // Increase test timeout to 10 seconds

  it('should complete successfully when within timeout', async () => {
    // Arrange
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue({
      path: '/tmp/repo',
      summary: {
        path: '/tmp/repo',
        branch: 'main',
        commit: 'abc123',
        fileCount: 1,
        directoryCount: 1,
        totalSize: 25,
        tokenCount: 7,
        createdAt: new Date().toISOString(),
      },
      files: [
        {
          path: 'src/index.ts',
          content: 'console.log("Hello World");',
          size: 25,
          type: 'file' as const,
        },
      ],
      tree: {
        name: '',
        type: 'directory' as const,
        children: [
          {
            name: 'src',
            type: 'directory' as const,
            children: [
              {
                name: 'index.ts',
                type: 'file' as const,
                size: 25,
              },
            ],
          },
        ],
      },
    });

    // Act
    const result = await ingestTool({
      repository: '/path/to/local/repo',
      cloneDepth: 1,
      sparseCheckout: false,
      includeSubmodules: false,
      includeGitignored: false,
      useGitignore: true,
      useGitingestignore: true,
      maxFiles: 1000,
      maxFileSize: undefined,
      excludePatterns: [],
      includePatterns: [],
      maxTotalSize: 50 * 1024 * 1024,
      token: undefined,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 5000, // 5 seconds timeout
    });

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Repository Summary');
  });

  it('should handle timeout with remote repository', async () => {
    // Arrange
    const { GitCloneTool } = await import('../../src/tools/git-clone.js');
    vi.mocked(GitCloneTool.clone).mockImplementation(async (_, signal) => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({
            path: '/tmp/cloned-repo',
            branch: 'main',
            commit: 'abc123',
            isShallow: true,
          });
        }, 3000); // 3 seconds delay


        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('Operation timed out after 2000ms'));
        });
      });
    });

    // Act
    const result = await ingestTool({
      repository: 'https://github.com/user/repo.git',
      cloneDepth: 1,
      sparseCheckout: false,
      includeSubmodules: false,
      includeGitignored: false,
      useGitignore: true,
      useGitingestignore: true,
      maxFiles: 1000,
      maxFileSize: undefined,
      excludePatterns: [],
      includePatterns: [],
      maxTotalSize: 50 * 1024 * 1024,
      token: undefined,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 2000, // 2 seconds timeout
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Operation timed out after 2000ms'
    );
  });

  it('should clear timeout on successful completion', async () => {
    // Arrange
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue({
      path: '/tmp/repo',
      summary: {
        path: '/tmp/repo',
        branch: 'main',
        commit: 'abc123',
        fileCount: 1,
        directoryCount: 1,
        totalSize: 25,
        tokenCount: 7,
        createdAt: new Date().toISOString(),
      },
      files: [
        {
          path: 'src/index.ts',
          content: 'console.log("Hello World");',
          size: 25,
          type: 'file' as const,
        },
      ],
      tree: {
        name: '',
        type: 'directory' as const,
        children: [
          {
            name: 'src',
            type: 'directory' as const,
            children: [
              {
                name: 'index.ts',
                type: 'file' as const,
                size: 25,
              },
            ],
          },
        ],
      },
    });


    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    // Act
    const result = await ingestTool({
      repository: '/path/to/local/repo',
      cloneDepth: 1,
      sparseCheckout: false,
      includeSubmodules: false,
      includeGitignored: false,
      useGitignore: true,
      useGitingestignore: true,
      maxFiles: 1000,
      maxFileSize: undefined,
      excludePatterns: [],
      includePatterns: [],
      maxTotalSize: 50 * 1024 * 1024,
      token: undefined,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 5000,
    });

    // Assert
    expect(result.isError).toBeUndefined();
    expect(clearTimeoutSpy).toHaveBeenCalled();


    clearTimeoutSpy.mockRestore();
  });
});
