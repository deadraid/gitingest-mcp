import { describe, expect, it } from 'vitest';

import { GitUrlParser } from '../../src/tools/url-parser.js';

describe('GitUrlParser', () => {
  it('preserves SSH clone URLs', () => {
    // Arrange
    const repository = 'git@github.com:owner/private.git';

    // Act
    const parsed = GitUrlParser.parse(repository);

    // Assert
    expect(parsed.type).toBe('github');
    expect(parsed.transport).toBe('ssh');
    expect(GitUrlParser.toCloneUrl(parsed)).toBe(
      'git@github.com:owner/private.git'
    );
    expect(parsed.branch).toBeUndefined();
  });

  it('uses the requested provider for shorthand repositories', () => {
    // Arrange
    const repository = 'owner/repository';

    // Act
    const parsed = GitUrlParser.parse(repository, 'gitlab');

    // Assert
    expect(parsed.type).toBe('gitlab');
    expect(parsed.transport).toBe('https');
    expect(GitUrlParser.toCloneUrl(parsed)).toBe(
      'https://gitlab.com/owner/repository.git'
    );
  });

  it('rejects a source that conflicts with the URL host', () => {
    // Arrange
    const repository = 'https://github.com/owner/repository';

    // Act
    const act = () => GitUrlParser.parse(repository, 'gitlab');

    // Assert
    expect(act).toThrow(/forced to gitlab/);
  });

  it('rejects credentials embedded in URLs', () => {
    // Arrange
    const repository = 'https://token@github.com/owner/repository.git';

    // Act
    const act = () => GitUrlParser.parse(repository);

    // Assert
    expect(act).toThrow(/token parameter/);
  });

  it('does not invent main when no branch was provided', () => {
    // Arrange
    const repository = 'https://github.com/owner/repository';

    // Act
    const parsed = GitUrlParser.parse(repository);

    // Assert
    expect(parsed.branch).toBeUndefined();
  });

  it('supports canonical GitLab URLs with nested groups', () => {
    // Arrange
    const repository = 'https://gitlab.com/group/subgroup/repository.git';

    // Act
    const parsed = GitUrlParser.parse(repository);

    // Assert
    expect(parsed.type).toBe('gitlab');
    expect(parsed.owner).toBe('group/subgroup');
    expect(parsed.repo).toBe('repository');
    expect(GitUrlParser.toCloneUrl(parsed)).toBe(repository);
  });

  it('rejects ambiguous repository browsing URLs', () => {
    // Arrange
    const repositories = [
      'https://github.com/owner/repository/tree/feature/topic/src',
      'https://gitlab.com/group/subgroup/repository/-/tree/main/src',
      'https://gitlab.com/group/subgroup/repository/-/commit/abc123',
      'https://bitbucket.org/owner/repository/src/main/src',
    ];

    // Act
    const actions = repositories.map(
      (repository) => () => GitUrlParser.parse(repository)
    );

    // Assert
    for (const action of actions) {
      expect(action).toThrow(/browsing URLs are ambiguous/);
    }
  });

  it('rejects implicit local paths and dangerous remote helpers', () => {
    // Arrange
    const repositories = [
      'local.git',
      'ext::sh -c payload.git',
      'file:///tmp/repo',
    ];

    // Act
    const actions = repositories.map(
      (repository) => () => GitUrlParser.parse(repository)
    );

    // Assert
    for (const action of actions) {
      expect(action).toThrow(/Unsupported/);
    }
  });

  it('accepts explicit generic Git transports with a host and path', () => {
    // Arrange
    const repositories = [
      'https://code.example.com/team/repository.git',
      'ssh://git@code.example.com/team/repository.git',
      'git@code.example.com:team/repository.git',
    ];

    // Act
    const parsedRepositories = repositories.map((repository) =>
      GitUrlParser.parse(repository)
    );

    // Assert
    expect(parsedRepositories.map((repository) => repository.host)).toEqual([
      'code.example.com',
      'code.example.com',
      'code.example.com',
    ]);
    expect(
      parsedRepositories.every((repository) => repository.type === 'git')
    ).toBe(true);
  });

  it('normalizes and safely encodes hosted repository paths', () => {
    // Arrange
    const repository = 'grøup/répository';

    // Act
    const parsed = GitUrlParser.parse(repository, 'gitlab');

    // Assert
    expect(parsed.owner).toBe('grøup');
    expect(parsed.repo).toBe('répository');
    expect(GitUrlParser.toCloneUrl(parsed)).toBe(
      'https://gitlab.com/gr%C3%B8up/r%C3%A9pository.git'
    );
  });

  it('rejects ambiguous hosted URL components and non-canonical suffixes', () => {
    // Arrange
    const repositories = [
      'owner/repo%3Fredirect',
      'https://github.com/owner/repository?ref=main',
      'https://github.com/owner/repository#main',
      'https://github.com:8443/owner/repository',
      'https://github.com/owner/%2Fetc',
      'https://github.com/owner/repository\nnext',
      '-oProxyCommand=payload@github.com:owner/repository.git',
      'ssh://-oProxyCommand@github.com/owner/repository.git',
      "git@github.com:owner/repository';payload.git",
      'ssh://git@-oProxyCommand/repository.git',
      'https://-invalid-host/repository.git',
    ];

    // Act
    const actions = repositories.map(
      (repository) => () => GitUrlParser.parse(repository)
    );

    // Assert
    for (const action of actions) {
      expect(action).toThrow();
    }
  });

  it('rejects malformed hosted percent encoding', () => {
    // Arrange
    const repository = 'git@github.com:owner/repo%ZZ.git';

    // Act
    const act = () => GitUrlParser.parse(repository);

    // Assert
    expect(act).toThrow(/encoding/);
  });
});
