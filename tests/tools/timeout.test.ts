import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestTool, type IngestToolResult } from '../../src/tools/ingest.js';
import { LocalRepositoryTool } from '../../src/tools/local-repository.js';

describe('ingest timeout', () => {
  let repositoryPath: string;

  beforeEach(async () => {
    repositoryPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-timeout-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repositoryPath, { recursive: true, force: true });
  });

  it('aborts work after the configured timeout', async () => {
    // Arrange
    vi.spyOn(LocalRepositoryTool, 'analyze').mockImplementation(
      async (_options, signal) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        })
    );

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      timeout: 10,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Operation timed out after 10ms');
  });
});

function resultText(result: IngestToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}
