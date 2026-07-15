import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestTool, type IngestToolResult } from '../../src/tools/ingest.js';

describe('ingest cancellation', () => {
  let repositoryPath: string;

  beforeEach(async () => {
    repositoryPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-cancel-'));
  });

  afterEach(async () => {
    await fs.rm(repositoryPath, { recursive: true, force: true });
  });

  it('honors a signal that was already aborted', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      signal: controller.signal,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Operation cancelled');
  });

  it('honors the runtime signal supplied by the MCP request', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();

    // Act
    const result = await ingestTool(
      { repository: repositoryPath },
      { signal: controller.signal }
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Operation cancelled');
  });
});

function resultText(result: IngestToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}
