import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isMainModule } from '../../src/server/is-main-module.js';

describe('isMainModule', () => {
  const temporaryDirectories: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('recognizes an entrypoint reached through an npm-style symlink', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'gitingest-main-module-'));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, 'index.js');
    const executablePath = join(directory, 'gitingest-mcp-server');
    await writeFile(modulePath, '');
    await symlink(modulePath, executablePath);
    process.argv[1] = executablePath;

    // Act
    const result = isMainModule(pathToFileURL(modulePath).href);

    // Assert
    expect(result).toBe(true);
  });
});
