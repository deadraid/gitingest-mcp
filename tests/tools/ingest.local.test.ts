import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestTool } from '../../src/tools/ingest.js';
import { FilterEngine } from '../../src/tools/filter-engine.js';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';
import type { IngestInput } from '../../src/tools/ingest.js';




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

vi.mock('../../src/tools/filter-engine.js', () => {

  const mockFilterEngine = {
    loadIgnorePatterns: vi.fn().mockResolvedValue(undefined),
    shouldIncludeFile: vi.fn().mockReturnValue({ shouldInclude: true }),
  };


  const FilterEngine = vi.fn().mockImplementation((options) => {
    return mockFilterEngine;
  });

  return { FilterEngine };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file content'),
}));




const baseInput: IngestInput = {
  repository: '/path/to/local/repo',
  cloneDepth: 1,
  sparseCheckout: false,
  includeSubmodules: false,
  includeGitignored: false,
  useGitignore: true,
  useGitingestignore: true,
  maxFiles: 1000,
  maxFileSize: undefined as number | undefined,
  excludePatterns: [] as string[],
  includePatterns: [] as string[],
  maxTotalSize: 50 * 1024 * 1024,
  token: undefined as string | undefined,
  maxRetries: 3,
  retryDelay: 1000,
  maxTokens: undefined as number | undefined,
  timeout: 30000,
};

function input(overrides: Partial<IngestInput> = {}): IngestInput {
  return { ...baseInput, ...overrides };
}




function buildMockLocalRepo(
  files: Array<{ path: string; content: string; size: number }>
) {
  return {
    path: '/tmp/repo',
    summary: {
      path: '/tmp/repo',
      branch: 'main',
      commit: 'abc123',
      fileCount: files.length,
      directoryCount: 1,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      tokenCount: files.reduce(
        (s, f) => s + Math.ceil(f.content.length / 4),
        0
      ),
      createdAt: new Date().toISOString(),
    },
    files: files.map((f) => ({ ...f, type: 'file' as const })),
    tree: {
      name: '',
      type: 'directory' as const,
      children: [
        {
          name: 'src',
          type: 'directory' as const,
          children: files.map((f) => ({
            name: f.path.split('/').pop()!,
            type: 'file' as const,
            size: f.size,
          })),
        },
      ],
    },
  };
}




describe('ingestTool – Local Repository & Filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes local repository successfully', async () => {
    // Arrange
    const mockRepo = buildMockLocalRepo([
      {
        path: 'src/index.ts',
        content: 'console.log("Hello World");',
        size: 25,
      },
    ]);
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(mockRepo);

    // Act
    const result = await ingestTool(input());

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Repository Summary');
    expect(result.content[0].text).toContain('src/index.ts');
  });

  it('applies exclude patterns correctly', async () => {
    // Arrange
    const mockRepo = buildMockLocalRepo([
      {
        path: 'src/index.ts',
        content: 'console.log("Hello World");',
        size: 25,
      },
      { path: 'logs/app.log', content: 'error', size: 10 },
    ]);
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(mockRepo);


    vi.mocked(FilterEngine).mockImplementation(
      () =>
        ({
          loadIgnorePatterns: vi.fn(),
          shouldIncludeFile: vi.fn((p: string) => ({
            shouldInclude: !p.endsWith('.log'),
          })),
          options: {},
        }) as unknown as InstanceType<typeof FilterEngine>
    );

    // Act
    const result = await ingestTool(input({ excludePatterns: ['*.log'] }));

    // Assert
    expect(result.content[0].text).toContain('src/index.ts');
    expect(result.content[0].text).not.toContain('logs/app.log');
  });

  it('respects maxFileSize limit', async () => {
    // Arrange
    const mockRepo = buildMockLocalRepo([
      { path: 'src/small.ts', content: 'small', size: 20 },
      { path: 'dist/large.js', content: 'big'.repeat(50000), size: 200000 },
    ]);
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(mockRepo);

    vi.mocked(FilterEngine).mockImplementation(
      () =>
        ({
          loadIgnorePatterns: vi.fn(),
          shouldIncludeFile: vi.fn((_: string, size: number) => ({
            shouldInclude: size < 100000,
          })),
          options: {},
        }) as unknown as InstanceType<typeof FilterEngine>
    );

    // Act
    const result = await ingestTool(input({ maxFileSize: 100000 }));

    // Assert
    expect(result.content[0].text).toContain('src/small.ts');
    expect(result.content[0].text).not.toContain('dist/large.js');
  });

  it('respects maxFiles limit', async () => {
    // Arrange
    const manyFiles = Array(30)
      .fill(null)
      .map((_, i) => ({
        path: `src/file${i}.ts`,
        content: 'x',
        size: 4,
      }));
    const mockRepo = buildMockLocalRepo(manyFiles);
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(mockRepo);


    let count = 0;
    vi.mocked(FilterEngine).mockImplementation(
      () =>
        ({
          loadIgnorePatterns: vi.fn(),
          shouldIncludeFile: vi.fn(() => {
            count += 1;
            return { shouldInclude: count <= 20 };
          }),
          options: { maxFiles: 20 },
        }) as unknown as InstanceType<typeof FilterEngine>
    );

    // Act
    const result = await ingestTool(input({ maxFiles: 20 }));

    // Assert
    expect(result.content[0].text).toContain('- **Files**: 20');
  });

  it('respects maxTokens limit', async () => {
    // Arrange
    const mockRepoTokens = buildMockLocalRepo([
      { path: 'src/small.ts', content: 'console.log("hello");', size: 22 },
      { path: 'src/tiny.ts', content: 'export default {}', size: 17 },
    ]);
    vi.mocked(LocalRepositoryTool.analyze).mockResolvedValue(mockRepoTokens);


    vi.mocked(FilterEngine).mockImplementation(
      () =>
        ({
          loadIgnorePatterns: vi.fn(),
          shouldIncludeFile: vi.fn().mockReturnValue({ shouldInclude: true }),
          options: {},
        }) as unknown as InstanceType<typeof FilterEngine>
    );

    // Act
    const result = await ingestTool(input({ maxTokens: 50 }));

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Repository Summary');
  });

  it('handles invalid repository path error', async () => {
    // Arrange
    vi.mocked(LocalRepositoryTool.analyze).mockRejectedValue(
      new Error('Repository not found')
    );

    // Act
    const result = await ingestTool(input({ repository: '/invalid/path' }));

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Repository not found');
  });
});
