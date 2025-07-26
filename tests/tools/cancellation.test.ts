import { describe, it, expect, vi } from 'vitest';
import { ingestTool } from '../../src/tools/ingest.js';
import { GitCloneTool } from '../../src/tools/git-clone.js';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';



vi.mock('../../src/tools/filter-engine.js', () => ({
  FilterEngine: vi.fn().mockImplementation(() => ({
    loadIgnorePatterns: vi.fn(),
    shouldIncludeFile: vi.fn().mockReturnValue({ shouldInclude: true }),
  })),
}));

describe('ingestTool cancellation handling', () => {
  it('should handle cancellation signal from AbortController', async () => {
    // Arrange
    const controller = new AbortController();

    vi.spyOn(LocalRepositoryTool, 'analyze').mockImplementationOnce(
      (options, signal) => {
        return new Promise((resolve, reject) => {

          if (signal?.aborted) {
            reject(new Error('Operation cancelled'));
            return;
          }


          const abortHandler = () => {
            reject(new Error('Operation cancelled'));
          };

          if (signal) {
            signal.addEventListener('abort', abortHandler);
          }


          setTimeout(() => {

            if (signal) {
              signal.removeEventListener('abort', abortHandler);
            }
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
          }, 3000);
        });
      }
    );

    // Act

    setTimeout(() => {
      controller.abort();
    }, 1000);


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
      signal: controller.signal,
    }).catch((error) => {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Operation cancelled: ${error.message}`,
          },
        ],
      };
    });

    // Assert

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Operation cancelled');
  });

  it('should propagate cancellation to git clone operation', async () => {
    // Arrange
    const controller = new AbortController();


    vi.spyOn(GitCloneTool, 'clone').mockImplementationOnce(
      (options, signal) => {
        return new Promise((resolve, reject) => {

          if (signal?.aborted) {
            reject(new Error('Git clone cancelled'));
            return;
          }


          const abortHandler = () => {
            reject(new Error('Git clone cancelled'));
          };

          if (signal) {
            signal.addEventListener('abort', abortHandler);
          }


          setTimeout(() => {

            if (signal) {
              signal.removeEventListener('abort', abortHandler);
            }
            resolve({
              path: '/tmp/cloned-repo',
              branch: 'main',
              commit: 'abc123',
              isShallow: true,
            });
          }, 3000);
        });
      }
    );

    // Act

    setTimeout(() => {
      controller.abort();
    }, 1000);


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
      timeout: 5000,
      signal: controller.signal,
    }).catch((error) => {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Operation cancelled: ${error.message}`,
          },
        ],
      };
    });

    // Assert

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Git clone cancelled');
  });

  it('should handle already aborted signal', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();


    vi.spyOn(LocalRepositoryTool, 'analyze').mockRejectedValueOnce(
      new Error('Operation cancelled')
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
      timeout: 5000,
      signal: controller.signal,
    }).catch((error) => {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Operation cancelled: ${error.message}`,
          },
        ],
      };
    });

    // Assert

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Operation cancelled');
  });

  it('should handle cancellation gracefully', async () => {
    // Arrange
    const controller = new AbortController();


    vi.spyOn(GitCloneTool, 'clone').mockRejectedValueOnce(
      new Error('Operation cancelled')
    );

    // Act

    controller.abort();


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
      timeout: 5000,
      signal: controller.signal,
    }).catch((error) => ({
      content: [{ type: 'text', text: error.message }],
      isError: true,
    }));

    // Assert

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cancelled');
  });
});
