import { describe, expect, it } from 'vitest';

import { OperationLimiter } from '../../src/server/operation-limiter.js';

describe('OperationLimiter', () => {
  it('rejects work above the limit and releases capacity idempotently', () => {
    // Arrange
    const limiter = new OperationLimiter(1);

    // Act
    const release = limiter.tryAcquire();
    const rejectedRelease = limiter.tryAcquire();
    release?.();
    release?.();
    const nextRelease = limiter.tryAcquire();
    const activeBeforeFinalRelease = limiter.activeCount;
    nextRelease?.();
    const activeAfterFinalRelease = limiter.activeCount;

    // Assert
    expect(release).toBeTypeOf('function');
    expect(rejectedRelease).toBeUndefined();
    expect(nextRelease).toBeTypeOf('function');
    expect(activeBeforeFinalRelease).toBe(1);
    expect(activeAfterFinalRelease).toBe(0);
  });

  it('rejects invalid limits', () => {
    // Arrange
    const invalidLimits = [0, -1, 1.5, Number.NaN];

    // Act
    const actions = invalidLimits.map(
      (limit) => () => new OperationLimiter(limit)
    );

    // Assert
    for (const action of actions) {
      expect(action).toThrow(/positive integer/);
    }
  });
});
