import { workflowFingerprint } from '@signal-room/workflow';
import type { WorkflowEntrypoint, WorkflowVersion } from './types.js';

/** A trusted deployment pairs its frozen declaration with the code that implements it. */
export interface WorkflowExecutorRegistration<T> {
  versionId: string;
  entrypoint: string;
  config: Record<string, unknown>;
  definition: WorkflowEntrypoint;
  executor: T;
  /** Check that the deployed code/resources are still the ones registered at startup. */
  verify?: () => void | Promise<void>;
}

/**
 * Registry of explicitly deployed implementations, not a loader for stored code or prompts.
 * A version can remain readable without a registered executor. Publishing a newer version
 * does not replace an older entry, and resolving never falls back to another version.
 */
export class WorkflowExecutorRegistry<T> {
  private readonly registrations = new Map<string, {
    fingerprint: string;
    executor: T;
    verify?: () => void | Promise<void>;
  }>();

  static key(versionId: string, entrypoint: string): string {
    if (!versionId.trim() || !entrypoint.trim()) throw new Error('Executable version and entrypoint are required');
    return JSON.stringify([versionId, entrypoint]);
  }

  register(input: WorkflowExecutorRegistration<T>): void {
    const key = WorkflowExecutorRegistry.key(input.versionId, input.entrypoint);
    if (this.registrations.has(key)) throw new Error('An executor is already registered for this exact method');
    if (!input.definition.workflowId || !input.definition.codeRevision ||
        input.definition.storageContract.workflowVersion !== input.versionId) {
      throw new Error('Executor declaration must match its frozen method identity');
    }
    // Store a value fingerprint, so later mutation of the caller's declaration cannot alter it.
    this.registrations.set(key, {
      fingerprint: workflowFingerprint({ config: input.config, definition: input.definition }),
      executor: input.executor,
      verify: input.verify,
    });
  }

  keys(): string[] { return [...this.registrations.keys()]; }

  async resolve(published: WorkflowVersion, entrypoint: string): Promise<T> {
    const key = WorkflowExecutorRegistry.key(published.id, entrypoint);
    const registered = this.registrations.get(key);
    if (!registered) throw new Error('此版本没有对应的已部署执行器，不能用当前代码替代。');
    const definition = published.entrypoints[entrypoint];
    if (!definition || workflowFingerprint({ config: published.config, definition }) !== registered.fingerprint) {
      throw new Error('已发布方法与执行器的冻结定义不一致。');
    }
    await registered.verify?.();
    return registered.executor;
  }

  async availability(published: WorkflowVersion, entrypoint: string): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.resolve(published, entrypoint);
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : '此版本执行器不可用。' };
    }
  }
}
