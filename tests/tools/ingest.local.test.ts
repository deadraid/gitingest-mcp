import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestTool, type IngestToolResult } from '../../src/tools/ingest.js';
import { countTextTokens, getTokenizer } from '../../src/utils/tokenizer.js';

describe('local repository ingestion', () => {
  let repositoryPath: string;
  const cleanupPaths: string[] = [];

  beforeEach(async () => {
    repositoryPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-test-'));
    cleanupPaths.push(repositoryPath);
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((path) => fs.rm(path, { recursive: true, force: true }))
    );
  });

  it('applies nested ignore files with full gitignore escaping semantics', async () => {
    // Arrange
    await writeFile(
      'src/.gitignore',
      ['*.generated', '!important.generated', '\\#literal.txt'].join('\n')
    );
    await writeFile('src/.gitingestignore', 'private.txt\n');
    await writeFile('src/drop.generated', 'drop');
    await writeFile('src/important.generated', 'keep');
    await writeFile('src/#literal.txt', 'escaped pattern');
    await writeFile('src/private.txt', 'private');

    // Act
    const result = await ingestTool({ repository: repositoryPath });
    const output = resultText(result);

    // Assert
    expect(output).toContain('## src/important.generated');
    expect(output).not.toContain('## src/drop.generated');
    expect(output).not.toContain('## src/#literal.txt');
    expect(output).not.toContain('## src/private.txt');
  });

  it('finds nested files selected by includePatterns', async () => {
    // Arrange
    await writeFile('src/index.ts', 'export const value = 42;');
    await writeFile('src/index.js', 'export const ignored = true;');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      includePatterns: ['**/*.ts'],
    });
    const output = resultText(result);

    // Assert
    expect(result.isError).toBeUndefined();
    expect(output).toContain('## src/index.ts');
    expect(output).not.toContain('## src/index.js');
  });

  it('applies gitignore, gitingestignore, and explicit exclusions', async () => {
    // Arrange
    await writeFile(
      '.gitignore',
      ['ignored.txt', 'generated/**', '!generated/keep.txt'].join('\n')
    );
    await writeFile('.gitingestignore', 'private/**\n');
    await writeFile('ignored.txt', 'ignored');
    await writeFile('generated/drop.txt', 'generated and ignored');
    await writeFile('generated/keep.txt', 'generated but included');
    await writeFile('private/secret.txt', 'secret');
    await writeFile('logs/app.log', 'log');
    await writeFile('src/index.ts', 'included');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      excludePatterns: ['**/*.log'],
    });
    const output = resultText(result);

    // Assert
    expect(output).toContain('## src/index.ts');
    expect(output).toContain('## generated/keep.txt');
    expect(output).not.toContain('## ignored.txt');
    expect(output).not.toContain('## generated/drop.txt');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('## logs/app.log');
  });

  it('applies ordered explicit negations and literal leading bangs', async () => {
    // Arrange
    await writeFile('drop.txt', 'drop');
    await writeFile('keep.txt', 'keep');
    await writeFile('!important.txt', 'important');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      excludePatterns: ['**/*.txt', '!keep.txt', '!\\!important.txt'],
    });
    const output = resultText(result);

    // Assert
    expect(output).not.toContain('## drop.txt');
    expect(output).toContain('## keep.txt');
    expect(output).toContain('## !important.txt');
  });

  it('enforces maxFileSize', async () => {
    // Arrange
    await writeFile('small.txt', 'included');
    await writeFile('large.txt', 'x'.repeat(100));

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxFileSize: 50,
    });
    const output = resultText(result);

    // Assert
    expect(output).toContain('**Files**: 1');
    expect(output).toContain('## small.txt');
    expect(output).not.toContain('## large.txt');
  });

  it('enforces maxFiles in deterministic path order', async () => {
    // Arrange
    await writeFile('c.txt', 'third');
    await writeFile('a.txt', 'first');
    await writeFile('b.txt', 'second');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxFiles: 2,
    });
    const output = resultText(result);

    // Assert
    expect(output).toContain('**Files**: 2');
    expect(output).toContain('## a.txt');
    expect(output).toContain('## b.txt');
    expect(output).not.toContain('## c.txt');
  });

  it('enforces maxTotalSize across included files', async () => {
    // Arrange
    await writeFile('a.txt', '12345678');
    await writeFile('b.txt', 'abcdefgh');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxTotalSize: 10,
    });
    const output = resultText(result);

    // Assert
    expect(output).toContain('**Files**: 1');
    expect(output).toContain('**Size**: 8 B');
    expect(output).toContain('## a.txt');
    expect(output).not.toContain('## b.txt');
  });

  it('keeps the complete digest within the maxTokens budget', async () => {
    // Arrange
    await writeFile('source.ts', 'const value = 1;\n'.repeat(200));
    const maxTokens = 400;
    const tokenizer = await getTokenizer('o200k_base');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxTokens,
    });
    const output = resultText(result);

    // Assert
    expect(countTextTokens(tokenizer, output)).toBeLessThanOrEqual(maxTokens);
    expect(output).toContain('## source.ts');
    expect(output).toContain('[truncated by maxTokens]');
  });

  it('treats tokenizer special strings and Unicode as ordinary content', async () => {
    // Arrange
    await writeFile('tokens.txt', '<|endoftext|> 😀 Привет мир\n'.repeat(200));
    const maxTokens = 400;
    const tokenizer = await getTokenizer('cl100k_base');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxTokens,
      tokenizer: 'cl100k_base',
    });
    const output = resultText(result);

    // Assert
    expect(result.isError).toBeUndefined();
    expect(countTextTokens(tokenizer, output)).toBeLessThanOrEqual(maxTokens);
    expect(output).toContain('<|endoftext|>');
    expect(Buffer.from(output, 'utf8').toString('utf8')).toBe(output);
    expect(output).not.toContain('\uFFFD');
  });

  it('skips binary files and symlinks', async () => {
    // Arrange
    const outsidePath = await fs.mkdtemp(join(tmpdir(), 'gitingest-outside-'));
    cleanupPaths.push(outsidePath);
    await fs.writeFile(join(outsidePath, 'outside-secret.txt'), 'outside');
    await writeFile('text.txt', 'plain text');
    await writeFile('.git/config', 'git metadata');
    await fs.writeFile(
      join(repositoryPath, 'binary.bin'),
      Buffer.from([0, 1, 2, 3])
    );
    await fs.symlink(
      join(repositoryPath, 'text.txt'),
      join(repositoryPath, 'link.txt')
    );
    await fs.symlink(outsidePath, join(repositoryPath, 'linked-directory'));

    // Act
    const result = await ingestTool({ repository: repositoryPath });
    const output = resultText(result);

    // Assert
    expect(output).toContain('## text.txt');
    expect(output).not.toContain('binary.bin');
    expect(output).not.toContain('link.txt');
    expect(output).not.toContain('outside-secret.txt');
    expect(output).not.toContain('git metadata');
  });

  it('fails closed when an ignore file exceeds its resource limit', async () => {
    // Arrange
    await writeFile('.gitingestignore', 'x'.repeat(1024 * 1024 + 1));
    await writeFile('secret.txt', 'must not be ingested');

    // Act
    const result = await ingestTool({ repository: repositoryPath });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Ignore file exceeds');
    expect(resultText(result)).not.toContain('must not be ingested');
  });

  it('enforces the repository entry scan budget', async () => {
    // Arrange
    await writeFile('a.txt', 'a');
    await writeFile('b.txt', 'b');
    await writeFile('c.txt', 'c');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxEntries: 2,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('maximum of 2 entries');
  });

  it('enforces the repository traversal depth budget', async () => {
    // Arrange
    await writeFile('one/two/file.txt', 'content');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxDepth: 1,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('maximum depth of 1');
  });

  it('always excludes a .git file as well as a .git directory', async () => {
    // Arrange
    await writeFile('.git', 'gitdir: outside');
    await writeFile('.GIT-case-test', 'ordinary file');
    await writeFile('source.txt', 'included');

    // Act
    const result = await ingestTool({ repository: repositoryPath });
    const output = resultText(result);

    // Assert
    expect(result.isError).toBeUndefined();
    expect(output).toContain('## source.txt');
    expect(output).toContain('## .GIT-case-test');
    expect(output).not.toContain('gitdir: outside');
  });

  it('excludes case variants of Git metadata directories', async () => {
    // Arrange
    await writeFile('.GIT/config', 'case-insensitive git metadata');
    await writeFile('source.txt', 'included');

    // Act
    const result = await ingestTool({ repository: repositoryPath });
    const output = resultText(result);

    // Assert
    expect(output).toContain('## source.txt');
    expect(output).not.toContain('case-insensitive git metadata');
  });

  it('limits the total number of rules loaded from ignore files', async () => {
    // Arrange
    await writeFile('.gitingestignore', 'ignored\n'.repeat(50_000));
    await writeFile('secret.txt', 'must not be ingested');

    // Act
    const result = await ingestTool({ repository: repositoryPath });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('50000 rules');
    expect(resultText(result)).not.toContain('must not be ingested');
  });

  it('limits the total bytes loaded from nested ignore files', async () => {
    // Arrange
    const ignoreContent = `#${'x'.repeat(900 * 1024 - 1)}`;
    for (let index = 0; index < 5; index += 1) {
      await writeFile(`directory-${index}/.gitingestignore`, ignoreContent);
    }

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxFiles: 10_000,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('4194304 bytes in total');
  });

  it('limits the number of nested ignore files', async () => {
    // Arrange
    for (let index = 0; index < 513; index += 1) {
      await writeFile(`directory-${index}/.gitignore`, '');
      await writeFile(`directory-${index}/.gitingestignore`, '');
    }

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      maxFiles: 2000,
      maxEntries: 3000,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('maximum of 1024 ignore files');
  });

  it('rejects glob patterns with excessive brace expansion', async () => {
    // Arrange
    await writeFile('source.txt', 'content');

    // Act
    const result = await ingestTool({
      repository: repositoryPath,
      excludePatterns: ['file-{1..100}.txt'],
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('32 brace expansions');
  });

  it('enforces the local-path allowlist used by HTTP transport', async () => {
    // Arrange
    await writeFile('source.ts', 'content');

    // Act
    const result = await ingestTool(
      { repository: repositoryPath },
      {
        allowUnrestrictedLocalRepositories: false,
        allowedLocalRoots: [],
      }
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Local repository access is disabled');
  });

  it('rejects remote-only options for a local repository', async () => {
    // Arrange
    await writeFile('source.ts', 'content');
    const inputs = [
      { repository: repositoryPath, branch: 'main' },
      { repository: repositoryPath, token: 'secret' },
      { repository: repositoryPath, includeSubmodules: true },
      { repository: repositoryPath, cloneDepth: 2 },
      { repository: repositoryPath, maxRetries: 2 },
      { repository: repositoryPath, retryDelay: 2 },
    ];

    // Act
    const results = await Promise.all(inputs.map((input) => ingestTool(input)));

    // Assert
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('only for remote repositories');
    }
  });

  it('distinguishes a file path from a missing local repository', async () => {
    // Arrange
    const filePath = join(repositoryPath, 'not-a-directory.txt');
    const missingPath = join(repositoryPath, 'missing');
    await fs.writeFile(filePath, 'content');

    // Act
    const fileResult = await ingestTool({ repository: filePath });
    const missingResult = await ingestTool({ repository: missingPath });

    // Assert
    expect(fileResult.isError).toBe(true);
    expect(resultText(fileResult)).toContain('is not a directory');
    expect(missingResult.isError).toBe(true);
    expect(resultText(missingResult)).toContain('does not exist');
  });

  async function writeFile(path: string, content: string): Promise<void> {
    const fullPath = join(repositoryPath, path);
    await fs.mkdir(join(fullPath, '..'), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
});

function resultText(result: IngestToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}
