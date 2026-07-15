import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitCloneTool } from '../../src/tools/git-clone.js';

const execFileAsync = promisify(execFile);

describe('GitCloneTool', () => {
  let binPath: string;
  let originalPath: string | undefined;
  let originalGitAskPass: string | undefined;
  let originalGitConfigGlobal: string | undefined;
  let originalGitDirectory: string | undefined;
  let originalCapturePath: string | undefined;
  const cleanupPaths: string[] = [];

  beforeEach(async () => {
    binPath = await fs.mkdtemp(join(tmpdir(), 'gitingest-git-bin-'));
    originalPath = process.env.PATH;
    originalGitAskPass = process.env.GIT_ASKPASS;
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    originalGitDirectory = process.env.GIT_DIR;
    originalCapturePath = process.env.TEST_CAPTURE_PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    restoreEnvironment('GIT_ASKPASS', originalGitAskPass);
    restoreEnvironment('GIT_CONFIG_GLOBAL', originalGitConfigGlobal);
    restoreEnvironment('GIT_DIR', originalGitDirectory);
    restoreEnvironment('TEST_CAPTURE_PATH', originalCapturePath);
    await Promise.all(
      [binPath, ...cleanupPaths.splice(0)].map((path) =>
        fs.rm(path, { recursive: true, force: true })
      )
    );
  });

  it('clones a real local Git repository into a private workspace', async () => {
    // Arrange
    const sourcePath = join(binPath, 'source');
    await fs.mkdir(sourcePath);
    await execFileAsync('git', ['init', '--quiet'], { cwd: sourcePath });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], {
      cwd: sourcePath,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: sourcePath,
    });
    await fs.writeFile(join(sourcePath, 'README.md'), '# test');
    await execFileAsync('git', ['add', 'README.md'], { cwd: sourcePath });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'Initial commit'], {
      cwd: sourcePath,
    });

    // Act
    const result = await GitCloneTool.clone({ url: sourcePath });
    cleanupPaths.push(result.cleanupPath ?? result.path);
    const clonedContent = await fs.readFile(
      join(result.path, 'README.md'),
      'utf8'
    );
    const workspaceStats = await fs.stat(result.cleanupPath ?? result.path);

    // Assert
    expect(clonedContent).toBe('# test');
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.path).not.toBe(sourcePath);
    expect(workspaceStats.mode & 0o077).toBe(0);
    expect(result.isShallow).toBe(false);
  });

  it('propagates cancellation to the running git process', async () => {
    // Arrange
    const fakeGitPath = join(binPath, 'git');
    await fs.writeFile(
      fakeGitPath,
      '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n',
      { mode: 0o755 }
    );
    process.env.PATH = `${binPath}${delimiter}${originalPath ?? ''}`;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20);

    // Act
    const clone = GitCloneTool.clone(
      { url: 'https://example.com/repository.git' },
      controller.signal
    );

    // Assert
    await expect(clone).rejects.toMatchObject({ name: 'AbortError' });
    clearTimeout(abortTimer);
  });

  it('rejects token forwarding to untrusted submodule hosts', async () => {
    // Arrange
    const options = {
      url: 'https://example.com/repository.git',
      includeSubmodules: true,
      auth: { token: 'secret', username: 'oauth2' },
    };

    // Act
    const clone = GitCloneTool.clone(options);

    // Assert
    await expect(clone).rejects.toThrow(/untrusted submodule host/);
  });

  it('isolates Git configuration and dangerous inherited environment', async () => {
    // Arrange
    const capturePath = join(binPath, 'environment.jsonl');
    const fakeGitPath = join(binPath, 'git');
    await fs.writeFile(
      fakeGitPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
if (args.includes('--abbrev-ref')) process.stdout.write('main\\n');
else if (args.includes('--is-shallow-repository')) process.stdout.write('false\\n');
else if (args[0] === 'rev-parse') process.stdout.write('${'a'.repeat(40)}\\n');
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binPath}${delimiter}${originalPath ?? ''}`;
    process.env.TEST_CAPTURE_PATH = capturePath;
    process.env.GIT_ASKPASS = '/tmp/untrusted-askpass';
    process.env.GIT_CONFIG_GLOBAL = '/tmp/untrusted-gitconfig';

    // Act
    const result = await GitCloneTool.clone({
      url: 'https://code.example.com/team/repository.git',
    });
    cleanupPaths.push(result.cleanupPath ?? result.path);
    const captures = (await fs.readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { env: NodeJS.ProcessEnv });

    // Assert
    expect(captures).not.toHaveLength(0);
    for (const capture of captures) {
      expect(capture.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(capture.env.GIT_CONFIG_GLOBAL).toContain('gitingest-');
      expect(capture.env.GIT_CONFIG_GLOBAL).not.toBe(
        '/tmp/untrusted-gitconfig'
      );
      expect(capture.env.GIT_ASKPASS).toBeUndefined();
      expect(capture.env.GIT_ALLOW_PROTOCOL).toBe('https:http:ssh:git');
      expect(capture.env.GIT_PROTOCOL_FROM_USER).toBe('0');
      expect(capture.env.GIT_CONFIG_COUNT).toBe('1');
      expect(capture.env.GIT_CONFIG_KEY_0).toBe('http.followRedirects');
      expect(capture.env.GIT_CONFIG_VALUE_0).toBe('false');
    }
  });

  it('rejects invalid depth, refs, and sparse paths before spawning Git', async () => {
    // Arrange
    const options = [
      { url: 'https://example.com/repository.git', depth: 0 },
      {
        url: 'https://example.com/repository.git',
        commit: '--upload-pack=payload',
      },
      {
        url: 'https://example.com/repository.git',
        sparse: true,
        subpath: '../outside',
      },
      {
        url: 'https://example.com/repository.git',
        sparse: true,
      },
      {
        url: 'https://example.com/repository.git',
        subpath: 'src',
      },
      {
        url: 'https://example.com/repository.git',
        branch: 'feature..topic',
      },
      {
        url: 'https://example.com/repository.git',
        commit: 'HEAD~1',
      },
      {
        url: 'https://example.com/repository.git',
        branch: 'main',
        tag: 'v1',
      },
      {
        url: 'https://example.com/repository.git',
        auth: { token: 'secret\nnext', username: 'oauth2' },
      },
    ];

    // Act
    const clones = options.map((option) => GitCloneTool.clone(option));

    // Assert
    for (const clone of clones) {
      await expect(clone).rejects.toThrow();
    }
  });

  it('isolates standalone metadata commands from inherited Git variables', async () => {
    // Arrange
    const capturePath = join(binPath, 'metadata-environment.json');
    const fakeGitPath = join(binPath, 'git');
    await fs.writeFile(
      fakeGitPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify(process.env));
process.stdout.write('main\\n');
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binPath}${delimiter}${originalPath ?? ''}`;
    process.env.TEST_CAPTURE_PATH = capturePath;
    process.env.GIT_DIR = '/tmp/untrusted-git-directory';

    // Act
    const branch = await GitCloneTool.getCurrentBranch(binPath);
    const capturedEnvironment = JSON.parse(
      await fs.readFile(capturePath, 'utf8')
    ) as NodeJS.ProcessEnv;

    // Assert
    expect(branch).toBe('main');
    expect(capturedEnvironment.GIT_DIR).toBeUndefined();
    expect(capturedEnvironment.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(capturedEnvironment.GIT_CONFIG_GLOBAL).toBeTruthy();
    expect(capturedEnvironment.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('redacts secrets and control characters from bounded Git errors', async () => {
    // Arrange
    const token = 'highly-secret-token';
    const fakeGitPath = join(binPath, 'git');
    await fs.writeFile(
      fakeGitPath,
      `#!/usr/bin/env node
process.stderr.write(process.env.GITINGEST_GIT_TOKEN + '\\u001b[31m' + 'x'.repeat(100_000));
process.exit(1);
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binPath}${delimiter}${originalPath ?? ''}`;

    // Act
    let caughtError: unknown;
    try {
      await GitCloneTool.clone({
        url: 'https://example.com/repository.git',
        auth: { token, username: 'oauth2' },
      });
    } catch (error) {
      caughtError = error;
    }

    // Assert
    expect(caughtError).toBeInstanceOf(Error);
    const message = (caughtError as Error).message;
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(token);
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThanOrEqual(16 * 1024 + 32);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
