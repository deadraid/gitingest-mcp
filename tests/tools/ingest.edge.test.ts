import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilterEngine } from '../../src/tools/filter-engine.js';
import { GitCloneTool } from '../../src/tools/git-clone.js';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';
import { GitUrlParser } from '../../src/tools/url-parser.js';
import { ingestTool } from '../../src/tools/ingest.js';


vi.mock('fs', () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/tools/git-clone.js');
vi.mock('../../src/tools/local-repository.js');
vi.mock('../../src/tools/filter-engine.js');
vi.mock('../../src/tools/url-parser.js');

describe('ingestTool', () => {
  beforeEach(async () => {
    vi.resetAllMocks();


    const fs = await import('fs');
    vi.mocked(fs.promises.readdir).mockResolvedValue([]);


    vi.mocked(GitUrlParser.parse).mockImplementation((url: string) => {
      if (url.startsWith('/')) {
        return {
          isLocal: true,
          path: url,
          url: url,
        };
      }
      return {
        isLocal: false,
        url: url,
        branch: 'main',
        type: 'github',
        owner: 'user',
        repo: url.split('/').pop()?.replace('.git', '') || 'repo',
      };
    });
    vi.mocked(GitUrlParser.toHttpsUrl).mockImplementation(
      (parsed) => parsed.url
    );
    vi.mocked(GitUrlParser.toApiUrl).mockImplementation(
      (parsed) => `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`
    );


    vi.mocked(FilterEngine).mockImplementation(
      (options) =>
        ({
          options,
          loadIgnorePatterns: vi.fn().mockResolvedValue(undefined),
          shouldIncludeFile: vi.fn().mockReturnValue({ shouldInclude: true }),
        }) as any
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Error Handling', () => {
    it('should handle various error scenarios', async () => {
      // Arrange
      vi.mocked(GitCloneTool.clone).mockRejectedValue(
        new Error('Invalid repository URL')
      );

      // Act
      const result1 = await ingestTool({
        repository: 'invalid-url',
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
        timeout: 30000,
      });

      // Assert
      expect(result1.isError).toBe(true);
      expect(result1.content[0].text).toContain('Invalid repository URL');

      // Arrange
      vi.mocked(GitCloneTool.clone).mockRejectedValue(
        new Error('Repository not found')
      );

      // Act
      const result2 = await ingestTool({
        repository: 'https://github.com/user/nonexistent-repo.git',
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
        timeout: 30000,
      });

      // Assert
      expect(result2.isError).toBe(true);
      expect(result2.content[0].text).toContain('Repository not found');

      // Arrange
      vi.mocked(LocalRepositoryTool.analyze).mockRejectedValue(
        new Error('Failed to analyze repository')
      );

      // Act
      const result3 = await ingestTool({
        repository: '/path/to/invalid/local/repo',
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
        timeout: 30000,
      });

      // Assert
      expect(result3.isError).toBe(true);
      expect(result3.content[0].text).toContain('Failed to analyze repository');

      // Arrange
      vi.mocked(GitCloneTool.clone).mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError')
      );

      // Act
      const result4 = await ingestTool({
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
        timeout: 1000, // 1 second timeout
      });

      // Assert
      expect(result4.isError).toBe(true);
      expect(result4.content[0].text).toContain('Operation timed out after 1000ms');
});
});


  describe('Retry Logic', () => {
    it('should retry failed clone operation', async () => {
      // Arrange
      let cloneCallCount = 0;
      vi.mocked(GitCloneTool.clone).mockImplementation(() => {
        cloneCallCount++;
        if (cloneCallCount < 3) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          path: '/tmp/cloned-repo',
          branch: 'main',
          commit: 'abc123',
          isShallow: true,
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
        retryDelay: 100,
        timeout: 30000,
      });

      // Assert
      expect(GitCloneTool.clone).toHaveBeenCalledTimes(3);
      expect(result.content[0].text).toContain('Repository Summary');
    });

    it('should fail after maximum retries exceeded', async () => {
      // Arrange
      vi.mocked(GitCloneTool.clone).mockRejectedValue(
        new Error('Persistent network error')
      );

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
        retryDelay: 100,
        timeout: 30000,
      });

      // Assert
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Persistent network error');
      expect(GitCloneTool.clone).toHaveBeenCalledTimes(4); // Initial attempt + 3 retries
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle various complex scenarios', async () => {
      // Arrange
      const mockCloneResult1 = {
        path: '/tmp/cloned-repo',
        branch: 'main',
        commit: 'abc123',
        isShallow: true,
      };
      vi.mocked(GitCloneTool.clone).mockResolvedValue(mockCloneResult1);

      // Act
      const result1 = await ingestTool({
        repository: 'https://github.com/user/repo-with-submodules.git',
        cloneDepth: 1,
        sparseCheckout: false,
        includeSubmodules: true,
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
        timeout: 30000,
      });

      // Assert
      expect(GitCloneTool.clone).toHaveBeenCalledWith(
        {
          url: 'https://github.com/user/repo-with-submodules.git',
          branch: 'main',
          commit: undefined,
          tag: undefined,
          depth: 1,
          sparse: false,
          subpath: undefined,
          includeSubmodules: true,
        },
        expect.any(AbortSignal)
      );
      expect(result1.content[0].text).toContain('Repository Summary');

      // Arrange
      const mockCloneResult2 = {
        path: '/tmp/cloned-repo',
        branch: 'main',
        commit: 'abc123',
        isShallow: true,
      };
      vi.mocked(GitCloneTool.clone).mockResolvedValue(mockCloneResult2);

      // Act
      const result2 = await ingestTool({
        repository: 'https://github.com/user/repo.git',
        cloneDepth: 1,
        sparseCheckout: true,
        subpath: 'packages/core',
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
        timeout: 30000,
      });

      // Assert
      expect(GitCloneTool.clone).toHaveBeenCalledWith(
        {
          url: 'https://github.com/user/repo.git',
          branch: 'main',
          commit: undefined,
          tag: undefined,
          depth: 1,
          sparse: true,
          subpath: 'packages/core',
          includeSubmodules: false,
        },
        expect.any(AbortSignal)
      );
      expect(result2.content[0].text).toContain('Repository Summary');

      // Arrange
      const mockRepositoryData = {
        path: '/tmp/repo',
        summary: {
          path: '/tmp/repo',
          branch: 'main',
          commit: 'abc123',
          fileCount: 2,
          directoryCount: 2,
          totalSize: 125,
          tokenCount: 50,
          createdAt: new Date().toISOString(),
        },
        files: [
          {
            path: 'src/index.ts',
            content: 'console.log("Hello World");',
            size: 25,
            type: 'file' as const,
          },
          {
            path: '.env',
            content: 'SECRET_KEY=12345',
            size: 100,
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
            {
              name: '.env',
              type: 'file' as const,
              size: 100,
            },
          ],
        },
      };
      vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(
        mockRepositoryData
      );
      const mockShouldIncludeFile = vi
        .fn()
        .mockImplementation(
          (path: string, size: number, isGitIgnored: boolean) => {
            if (isGitIgnored) {
              return {
                shouldInclude: true,
                reason: 'includeGitignored is true',
              };
            }
            return { shouldInclude: true };
          }
        );
      vi.mocked(FilterEngine).mockImplementation(() => {
        return {
          loadIgnorePatterns: vi.fn().mockResolvedValue(undefined),
          shouldIncludeFile: mockShouldIncludeFile,
          options: {},
        } as unknown as InstanceType<typeof FilterEngine>;
      });

      // Act
      const result3 = await ingestTool({
        repository: '/path/to/local/repo',
        cloneDepth: 1,
        sparseCheckout: false,
        includeSubmodules: false,
        includeGitignored: true,
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
        timeout: 30000,
      });

      // Assert
      expect(result3.content[0].text).toContain('src/index.ts');
      expect(result3.content[0].text).toContain('.env');
    });
  });
});
