import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestSchema } from '../../src/tools/ingest.js';
import { z } from 'zod';




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

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file content'),
}));




describe('ingestSchema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should validate required repository parameter', () => {
    // Arrange
    const invalidInput = {};

    // Act
    const act = () => ingestSchema.parse(invalidInput);

    // Assert
    expect(act).toThrow(z.ZodError);
  });

  it('should accept valid repository parameter', () => {
    // Arrange
    const validInput = { repository: 'test-repo' };

    // Act
    const result = ingestSchema.parse(validInput);

    // Assert
    expect(result.repository).toBe('test-repo');
  });

  it('should parse timeout parameter correctly', () => {
    // Arrange
    const inputWithTimeout = { repository: 'test-repo', timeout: 5000 };

    // Act
    const parsed = ingestSchema.parse(inputWithTimeout);

    // Assert
    expect(parsed.timeout).toBe(5000);
  });

  it('should use default values for optional parameters', () => {
    // Arrange
    const minimalInput = { repository: 'test-repo' };

    // Act
    const parsed = ingestSchema.parse(minimalInput);

    // Assert
    expect(parsed.cloneDepth).toBe(1);
    expect(parsed.maxFiles).toBe(1000);
    expect(parsed.maxTotalSize).toBe(50 * 1024 * 1024);
    expect(parsed.timeout).toBe(30000);
  });
});
