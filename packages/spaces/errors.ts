/** The observed Agent response was durably recorded, but failed its frozen output schema. */
export class InvalidObservedOutputError extends Error {
  constructor(readonly contextId: string, readonly issues: string[]) {
    super('Observed Agent output failed its registered schema');
    this.name = 'InvalidObservedOutputError';
  }
}
