import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestTool, ingestSchema } from '../../src/tools/ingest.js';
import { z } from 'zod';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';


vi.mock('../../src/tools/git-clone.js', () => {
  const GitCloneTool = {
    clone: vi.fn(),
    cleanup: vi.fn(),
  };
  return { GitCloneTool };
});

vi.mock('../../src/tools/local-repository.js', () => {
  const LocalRepositoryTool = {
    analyze: vi.fn(),
  };
  return { LocalRepositoryTool };
});

vi.mock('../../src/tools/filter-engine.js', () => {

  class MockFilterEngine {
    options: Record<string, any>;
    loadIgnorePatterns: () => Promise<void>;
    shouldIncludeFile: () => { shouldInclude: boolean };

    constructor(options: Record<string, any>) {
      this.options = options || {};
      this.loadIgnorePatterns = vi.fn().mockResolvedValue(undefined);
      this.shouldIncludeFile = vi.fn().mockReturnValue({ shouldInclude: true });
    }
  }

  return { FilterEngine: MockFilterEngine };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file content'),
}));

describe('ingestTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Schema Validation', () => {
    it('should validate schema with various inputs', () => {

      expect(() => ingestSchema.parse({})).toThrow(z.ZodError);


      const validInput = { repository: 'test-repo' };
      const result = ingestSchema.parse(validInput);
      expect(result.repository).toBe('test-repo');


      const inputWithTimeout = { repository: 'test-repo', timeout: 5000 };
      const parsed = ingestSchema.parse(inputWithTimeout);
      expect(parsed.timeout).toBe(5000);


      const minimalInput = { repository: 'test-repo' };
      const parsedDefaults = ingestSchema.parse(minimalInput);
      expect(parsedDefaults.cloneDepth).toBe(1);
      expect(parsedDefaults.maxFiles).toBe(1000);
      expect(parsedDefaults.maxTotalSize).toBe(50 * 1024 * 1024);
      expect(parsedDefaults.timeout).toBe(30000);
    });
  });

  describe('Local Repository Processing', () => {
    it('should process local repository successfully', async () => {
      // Arrange
      const mockRepositoryData = {
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
      };

      vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(
        mockRepositoryData
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
        timeout: 30000,
      });

      // Assert
      expect(LocalRepositoryTool.analyze).toHaveBeenCalledWith(
        {
          path: '/path/to/local/repo',
          includeGitignored: false,
          useGitignore: true,
          useGitingestignore: true,
          maxFileSize: undefined,
          maxFiles: 1000,
          excludePatterns: [],
          includePatterns: [],
        },
        expect.any(AbortSignal)
      );

      expect(result.content[0].text).toContain('Repository Summary');
      expect(result.content[0].text).toContain('src/index.ts');
      expect(result.content[0].text).toContain('main');
      expect(result.content[0].text).toContain('abc123');
    });

    it('should handle empty local repository', async () => {
      // Arrange
      const mockEmptyRepository = {
        path: '/tmp/empty-repo',
        summary: {
          path: '/tmp/empty-repo',
          branch: 'main',
          commit: 'abc123',
          fileCount: 0,
          directoryCount: 0,
          totalSize: 0,
          tokenCount: 0,
          createdAt: new Date().toISOString(),
        },
        files: [],
        tree: {
          name: '',
          type: 'directory' as const,
          children: [],
        },
      };

      vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(
        mockEmptyRepository
      );

      // Act
      const result = await ingestTool({
        repository: '/path/to/empty/repo',
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
      expect(result.content[0].text).toContain('**Files**: 0');
      expect(result.content[0].text).toContain('**Directories**: 0');
    });
  });
});
