export class OperationLimiter {
  private activeOperations = 0;

  constructor(private readonly maximumConcurrentOperations: number) {
    if (
      !Number.isInteger(maximumConcurrentOperations) ||
      maximumConcurrentOperations < 1
    ) {
      throw new Error('maximumConcurrentOperations must be a positive integer');
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.activeOperations >= this.maximumConcurrentOperations) {
      return undefined;
    }

    this.activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperations -= 1;
    };
  }

  get activeCount(): number {
    return this.activeOperations;
  }
}
