import { describe, expect, it } from 'vitest';
import { shouldCollapsePlanAfterCommand } from './plan-transition.js';

describe('plan command transition', () => {
  it('only collapses the confirmation panel when the exact run is active or complete without dispatch error', () => {
    expect(shouldCollapsePlanAfterCommand({ status: 'running', dispatchError: null })).toBe(true);
    expect(shouldCollapsePlanAfterCommand({ status: 'completed', dispatchError: null })).toBe(true);
    expect(shouldCollapsePlanAfterCommand({ status: 'queued', dispatchError: null })).toBe(false);
    expect(shouldCollapsePlanAfterCommand({ status: 'queued', dispatchError: 'executor unavailable' })).toBe(false);
    expect(shouldCollapsePlanAfterCommand({ status: 'running', dispatchError: 'executor unavailable' })).toBe(false);
    expect(shouldCollapsePlanAfterCommand({ status: 'failed', dispatchError: null })).toBe(false);
    expect(shouldCollapsePlanAfterCommand({ status: 'canceled', dispatchError: null })).toBe(false);
  });
});
