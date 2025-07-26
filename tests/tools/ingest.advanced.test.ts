import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestTool } from '../../src/tools/ingest.js';
import { FilterEngine } from '../../src/tools/filter-engine.js';
import { GitCloneTool } from '../../src/tools/git-clone.js';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';
import { GitUrlParser } from '../../src/tools/url-parser.js';


vi.mock('fs', () => ({
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/tools/git-clone.js');
vi.mock('../../src/tools/local-repository.js');
vi.mock('../../src/tools/filter-engine.js');
vi.mock('../../src/tools/url-parser.js');

describe('ingestTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();


    vi.mocked(GitUrlParser.parse).mockImplementation((repo: string) => {


      if (repo.startsWith('/')) {
        return {
          isLocal: true,
          url: repo,
          type: 'local',
          branch: undefined,
          subpath: undefined,
        };
      }

      return {
        isLocal: false,
        url: repo.startsWith('http') ? repo : `https://github.com/${repo}`,
        type: 'github', // Simplified
        branch: undefined,
        subpath: undefined,
      };
    });
    vi.mocked(GitUrlParser.toHttpsUrl).mockImplementation(
      (parsed) => parsed.url
    );


    vi.mocked(GitCloneTool.clone).mockResolvedValue({
      path: '/tmp/cloned-repo',
      branch: 'main',
      commit: 'abc1234',
      isShallow: true,
    });
    vi.mocked(GitCloneTool.cleanup).mockResolvedValue(undefined);


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

  describe('Remote Repository Processing', () => {
    it('should handle various remote repository formats', async () => {
      // Arrange
      const fs = await import('fs');
      vi.mocked(fs.promises.readdir).mockImplementation(async (path: any) => {
        const normalizedPath = path.toString().replace(/\\/g, '/');
        if (normalizedPath === '/tmp/cloned-repo') {
          return [
            { name: 'test.txt', isFile: () => true, isDirectory: () => false },
            { name: 'README.md', isFile: () => true, isDirectory: () => false },
          ] as any;
        }
        return [];
      });
      vi.mocked(fs.promises.stat).mockImplementation(async (path: any) => {
        const normalizedPath = path.toString().replace(/\\/g, '/');
        if (normalizedPath.endsWith('test.txt'))
          return {
            size: 12,
            isFile: () => true,
            isDirectory: () => false,
          } as any;
        if (normalizedPath.endsWith('README.md'))
          return {
            size: 45,
            isFile: () => true,
            isDirectory: () => false,
          } as any;
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      });
      vi.mocked(fs.promises.readFile).mockImplementation(async (path: any) => {
        const normalizedPath = path.toString().replace(/\\/g, '/');
        if (normalizedPath.endsWith('test.txt')) return 'test content';
        if (normalizedPath.endsWith('README.md'))
          return '# Test Repository\n\nThis is a test repository.';
        return '';
      });

      // Act
      const result1 = await ingestTool({
        repository: 'https://github.com/user/repo',
        cloneDepth: 1,
        sparseCheckout: false,
        includeSubmodules: false,
        includeGitignored: false,
        useGitignore: true,
        useGitingestignore: true,
        maxFiles: 1000,
        maxTotalSize: 50 * 1024 * 1024,
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
      });
      const result2 = await ingestTool({
        repository: 'user/repo',
        source: 'github',
        cloneDepth: 1,
        sparseCheckout: false,
        includeSubmodules: false,
        includeGitignored: false,
        useGitignore: true,
        useGitingestignore: true,
        maxFiles: 1000,
        maxTotalSize: 50 * 1024 * 1024,
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
      });

      // Assert
      expect(GitCloneTool.clone).toHaveBeenCalledTimes(2);
      expect(result1.content[0].text).toContain('Repository Summary');
      expect(result1.content[0].text).toContain('test.txt');
      expect(result2.content[0].text).toContain('Repository Summary');
      expect(GitCloneTool.cleanup).toHaveBeenCalledWith('/tmp/cloned-repo');
    });
  });

  describe('File Processing', () => {
    it('should handle file filtering and size limits', async () => {
      // Arrange
      const mockRepositoryData = {
        path: '/tmp/local-repo',
        summary: {
          path: '/tmp/local-repo',
          branch: 'main',
          commit: 'local123',
          fileCount: 4,
          directoryCount: 1,
          totalSize: 200175,
          tokenCount: 100, // Added missing property
          createdAt: new Date().toISOString(),
        },
        files: [
          {
            path: 'src/index.ts',
            content: 'console.log("Hello");',
            size: 25,
            type: 'file' as const,
          },
          {
            path: 'logs/app.log',
            content: 'error log',
            size: 100,
            type: 'file' as const,
          },
          {
            path: 'node_modules/dep/index.js',
            content: '{}',
            size: 50,
            type: 'file' as const,
          },
          {
            path: 'dist/bundle.js',
            content: 'large file'.repeat(10000),
            size: 200000,
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
              children: [{ name: 'index.ts', type: 'file' as const, size: 25 }],
            },
          ],
        },
      };
      vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(
        mockRepositoryData
      );

      vi.mocked(FilterEngine).mockImplementation(
        (options) =>
          ({
            options,
            loadIgnorePatterns: vi.fn().mockResolvedValue(undefined),
            shouldIncludeFile: vi.fn((path: string, size: number) => {
              if (path.includes('node_modules'))
                return { shouldInclude: false };
              if (path.endsWith('.log')) return { shouldInclude: false };
              if (size > 100000) return { shouldInclude: false };
              return { shouldInclude: true };
            }),
          }) as any
      );

      // Act
      const result = await ingestTool({
        repository: '/path/to/local-repo',
        maxFileSize: 100000,
        excludePatterns: ['**/*.log', 'node_modules/**'],
        cloneDepth: 1,
        sparseCheckout: false,
        includeSubmodules: false,
        includeGitignored: false,
        useGitignore: true,
        useGitingestignore: true,
        maxFiles: 1000,
        maxTotalSize: 50 * 1024 * 1024,
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
      });

      // Assert
      expect(LocalRepositoryTool.analyze).toHaveBeenCalled();
      expect(result.content[0].text).toContain('src/index.ts');
      expect(result.content[0].text).not.toContain('logs/app.log');
      expect(result.content[0].text).not.toContain('node_modules/dep/index.js');
      expect(result.content[0].text).not.toContain('dist/bundle.js');
    });
  });
});
