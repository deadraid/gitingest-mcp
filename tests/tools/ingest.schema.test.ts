import { describe, expect, it } from 'vitest';

import { ingestToolDefinition } from '../../src/server/create-server.js';
import { ingestSchema } from '../../src/tools/ingest.js';

describe('ingest schema', () => {
  it('applies safe defaults', () => {
    // Arrange
    const input = { repository: 'owner/repository' };

    // Act
    const value = ingestSchema.parse(input);

    // Assert
    expect(value.cloneDepth).toBe(1);
    expect(value.maxFileSize).toBe(10 * 1024 * 1024);
    expect(value.maxFiles).toBe(1000);
    expect(value.maxEntries).toBe(25_000);
    expect(value.maxDepth).toBe(128);
    expect(value.maxTotalSize).toBe(50 * 1024 * 1024);
    expect(value.maxTokens).toBe(250_000);
    expect(value.tokenizer).toBe('o200k_base');
    expect(value.timeout).toBe(30_000);
  });

  it('rejects unsafe refs, escaping subpaths, and excessive resource limits', () => {
    // Arrange
    const inputs = [
      { repository: 'owner/repository', branch: '--upload-pack=payload' },
      { repository: 'owner/repository', commit: 'main\nnext' },
      {
        repository: 'owner/repository',
        sparseCheckout: true,
        subpath: '../outside',
      },
      { repository: 'owner/repository', subpath: 'src' },
      { repository: 'owner/repository', maxFileSize: 16 * 1024 * 1024 + 1 },
      { repository: 'owner/repository', maxTotalSize: 64 * 1024 * 1024 + 1 },
      { repository: 'owner/repository', maxFiles: 10_001 },
      { repository: 'owner/repository', maxEntries: 100_001 },
      { repository: 'owner/repository', maxDepth: 257 },
      { repository: 'owner/repository', maxTokens: 1_000_001 },
      { repository: 'owner/repository', branch: 'feature..topic' },
      { repository: 'owner/repository', branch: 'feature/.hidden' },
      { repository: 'owner/repository', tag: 'release.lock' },
      { repository: 'owner/repository', commit: 'HEAD~1' },
      { repository: 'owner/repository', token: 'secret\nnext' },
      { repository: 'owner/repository', excludePatterns: ['!'] },
      { repository: 'owner/repository', includePatterns: ['src\u0000file'] },
    ];

    // Act
    const actions = inputs.map((input) => () => ingestSchema.parse(input));

    // Assert
    for (const action of actions) {
      expect(action).toThrow();
    }
  });

  it('rejects invalid limits and ambiguous refs', () => {
    // Arrange
    const invalidLimit = { repository: 'owner/repository', maxFiles: 0 };
    const ambiguousRefs = {
      repository: 'owner/repository',
      branch: 'main',
      tag: 'v1',
    };
    const sparseWithoutPath = {
      repository: 'owner/repository',
      sparseCheckout: true,
    };

    // Act
    const parseInvalidLimit = () => ingestSchema.parse(invalidLimit);
    const parseAmbiguousRefs = () =>
      ingestSchema.parse({
        ...ambiguousRefs,
      });
    const parseSparseWithoutPath = () => ingestSchema.parse(sparseWithoutPath);

    // Assert
    expect(parseInvalidLimit).toThrow();
    expect(parseAmbiguousRefs).toThrow(/Only one/);
    expect(parseSparseWithoutPath).toThrow(/subpath/);
  });

  it('publishes maxTokens and all other public options in MCP schema', () => {
    // Arrange
    const schema = ingestToolDefinition.inputSchema;

    // Act
    const properties = schema.properties;

    // Assert
    expect(properties).toHaveProperty('maxTokens');
    expect(properties).toHaveProperty('maxTotalSize');
    expect(properties).toHaveProperty('maxEntries');
    expect(properties).toHaveProperty('maxDepth');
    expect(properties).toHaveProperty('token');
    expect(properties).toHaveProperty('tokenizer');
    expect(properties).not.toHaveProperty('signal');
  });
});
