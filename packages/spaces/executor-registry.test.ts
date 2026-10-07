import { describe, expect, it } from 'vitest';
import { WorkflowExecutorRegistry } from './executor-registry.js';
import type { WorkflowVersion } from './types.js';

function version(id: string, model: string): WorkflowVersion {
  return {
    id, spaceId: 'space', revision: 'same-code', hash: `hash-${id}`, createdAt: 'now', changeReason: 'fixture',
    config: { models: { writer: model } },
    entrypoints: { main: {
      workflowId: 'write', codeRevision: 'same-code',
      storageContract: { workflowVersion: id, nodes: {}, stateRules: [], hash: `storage-${id}` },
      nodeDefinitions: { writer: { instructions: `Write using ${model}`, model } },
    } },
  };
}

describe('Explicit deployed method registry', () => {
  it('keeps two exact factories without falling back to latest or matching only code revision', async () => {
    const registry = new WorkflowExecutorRegistry<() => string>();
    const v1 = version('v1', 'model-1'), v2 = version('v2', 'model-2');
    for (const v of [v1, v2]) registry.register({ versionId: v.id, entrypoint: 'main',
      config: v.config, definition: v.entrypoints.main!, executor: () => v.id });
    expect((await registry.resolve(v2, 'main'))()).toBe('v2');
    expect((await registry.resolve(v1, 'main'))()).toBe('v1');
    await expect(registry.resolve(version('v0', 'model-1'), 'main')).rejects.toThrow('没有对应');
    await expect(registry.resolve(v1, 'other')).rejects.toThrow('没有对应');
    expect(registry.keys()).toEqual([WorkflowExecutorRegistry.key('v1', 'main'), WorkflowExecutorRegistry.key('v2', 'main')]);
  });

  it('pins declarations by value and rejects config, prompt, schema or workflow drift', async () => {
    const registry = new WorkflowExecutorRegistry<string>();
    const registered = version('v1', 'model-1');
    const published = structuredClone(registered);
    registry.register({ versionId: registered.id, entrypoint: 'main', config: registered.config,
      definition: registered.entrypoints.main!, executor: 'one' });
    registered.config.models = { writer: 'changed' };
    registered.entrypoints.main!.nodeDefinitions!.writer!.instructions = 'changed';
    expect(await registry.resolve(published, 'main')).toBe('one');
    await expect(registry.resolve(registered, 'main')).rejects.toThrow('不一致');
    for (const mutate of [
      (v: WorkflowVersion) => { v.entrypoints.main!.workflowId = 'other-workflow'; },
      (v: WorkflowVersion) => { v.entrypoints.main!.storageContract.hash = 'different'; },
      (v: WorkflowVersion) => { v.entrypoints.main!.nodeDefinitions!.writer!.instructions = 'different'; },
    ]) {
      const changed = structuredClone(published); mutate(changed);
      expect(await registry.availability(changed, 'main')).toMatchObject({ available: false });
    }
  });

  it('checks deployed resources again at dispatch and prevents executor replacement', async () => {
    const registry = new WorkflowExecutorRegistry<string>();
    const v = version('v1', 'model'); let changed = false;
    const registration = { versionId: v.id, entrypoint: 'main', config: v.config,
      definition: v.entrypoints.main!, executor: 'one', verify: () => { if (changed) throw new Error('Deployment changed'); } };
    registry.register(registration);
    expect(await registry.availability(v, 'main')).toEqual({ available: true });
    expect(() => registry.register({ ...registration, executor: 'replacement' })).toThrow('already registered');
    changed = true;
    await expect(registry.resolve(v, 'main')).rejects.toThrow('Deployment changed');
  });
});
