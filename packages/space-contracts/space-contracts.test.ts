import { describe, expect, it } from 'vitest';
import {
  ContractValidationError, JSON_SCHEMA_DIALECT, SchemaRegistry, assertInputState,
  assertNodeAction, assertStateTransition, projectBoundInput, publishStorageContract,
  schemaUri, validateAgentOutput, validateNodeWrite, verifyStorageContract,
  type SchemaRef, type StorageContractDraft,
} from './index.js';

function setup() {
  const registry = new SchemaRegistry();
  const fragment = registry.registerSchema({
    namespace: 'test/fragment', revision: '1', dialect: JSON_SCHEMA_DIALECT,
    schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
  });
  const draft = registry.registerSchema({
    namespace: 'test/draft', revision: '1', dialect: JSON_SCHEMA_DIALECT,
    dependencies: [fragment],
    schema: {
      type: 'object', required: ['decision', 'script'], additionalProperties: false,
      properties: {
        decision: { type: 'string' },
        script: {
          type: 'object', required: ['title', 'segments'], additionalProperties: false,
          properties: {
            title: { type: 'string' },
            segments: { type: 'array', items: { $ref: schemaUri(fragment) } },
          },
        },
      },
    },
  });
  const raw = registry.registerSchema({
    namespace: 'test/agent-draft', revision: '1', dialect: JSON_SCHEMA_DIALECT,
    schema: { type: 'object', required: ['script'], properties: { script: { type: 'string' } } },
  });
  const observation = registry.registerSchema({
    namespace: 'test/observation', revision: '1', dialect: JSON_SCHEMA_DIALECT,
    schema: { type: 'object', required: ['retell'], properties: { retell: { type: 'string' } }, additionalProperties: false },
  });
  const payload = { decision: 'Private author reasoning', script: { title: 'Visible', segments: [{ text: 'First' }] } };
  const contractDraft: StorageContractDraft = {
    workflowVersion: 'content-v1',
    nodes: {
      author: {
        actorKinds: ['agent'], sessionPolicy: 'continue', inputs: {},
        outputs: { candidate: { schema: draft, requiredInputs: [], appendVersions: true,
          initialState: 'candidate', agentOutputSchema: raw } },
        actions: ['appendOutputVersion'],
      },
      coldReader: {
        actorKinds: ['agent'],
        inputs: { manuscript: { schema: draft, states: ['candidate'], projection: {
          version: 'viewer-v1', fields: ['/script/title', '/script/segments/*/text'],
        } } },
        outputs: { observation: { schema: observation, requiredInputs: ['manuscript'], appendVersions: false,
          initialState: 'candidate' } },
        actions: ['readBoundInputProjection', 'appendOutputVersion'],
      },
      creator: {
        actorKinds: ['human'], inputs: { manuscript: { schema: draft, states: ['candidate'] } }, outputs: {},
        actions: ['readBoundInput', 'accept'],
      },
    },
    stateRules: [{ schema: draft, from: 'candidate', to: 'accepted',
      action: 'accept', actorKinds: ['human'], nodeId: 'creator' }],
  };
  return { registry, fragment, draft, raw, observation, payload, contractDraft };
}

function ref(revision: SchemaRef): SchemaRef {
  return { namespace: revision.namespace, revision: revision.revision, hash: revision.hash };
}

// PostgreSQL jsonb emits object keys in its own canonical order, while retaining array order.
function jsonbOrdered<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonbOrdered) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
      .map(([key, item]) => [key, jsonbOrdered(item)])) as T;
  }
  return value;
}

describe('SchemaRegistry', () => {
  it('validates real JSON Schema, including a frozen cross-schema $ref', () => {
    const { registry, draft, payload } = setup();
    expect(() => registry.validatePayload(draft, payload)).not.toThrow();
    expect(() => registry.validatePayload(draft, { ...payload, script: { ...payload.script, segments: [{ text: 3 }] } }))
      .toThrow(ContractValidationError);
    expect(() => registry.validatePayload(draft, { ...payload, decision: undefined })).toThrow(ContractValidationError);
    expect(() => registry.validatePayload(draft, { ...payload, script: { title: 'No segments' } }))
      .toThrow(ContractValidationError);
  });

  it('rejects unresolved and remote references and schema identity overwrite', () => {
    const registry = new SchemaRegistry();
    expect(() => registry.registerSchema({ namespace: 'x/y', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { $ref: 'https://example.com/schema.json' } })).toThrow(/remote/);
    expect(() => registry.registerSchema({ namespace: 'x/y', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { $ref: 'aw://schema/x/missing@1' } })).toThrow(/Unresolved/);
    const first = registry.registerSchema({ namespace: 'x/y', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { type: 'string' } });
    expect(registry.registerSchema({ namespace: 'x/y', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { type: 'string' } })).toBe(first);
    expect(() => registry.registerSchema({ namespace: 'x/y', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { type: 'number' } })).toThrow(/already registered/);
    expect(() => new SchemaRegistry([{ ...first, hash: '0'.repeat(64) }])).toThrow(/hash mismatch/);
  });

  it('rehydrates exact dependency closure and rejects tampered schema or contract', () => {
    const { registry, draft, contractDraft, payload } = setup();
    const contract = publishStorageContract(registry, contractDraft);
    expect(contract.schemas.map((schema) => schema.namespace)).toContain('test/fragment');
    const restored = verifyStorageContract(JSON.parse(JSON.stringify(contract)));
    restored.validatePayload(draft, payload);
    const changed = JSON.parse(JSON.stringify(contract));
    changed.schemas[0].schema.type = 'number';
    expect(() => verifyStorageContract(changed)).toThrow(/hash mismatch/);
    const alteredContract = JSON.parse(JSON.stringify(contract));
    alteredContract.nodes.coldReader.inputs.manuscript.projection.fields.push('/decision');
    expect(() => verifyStorageContract(alteredContract)).toThrow(/altered/);
  });

  it('verifies a full contract after JSONB reorders node keys without changing the frozen schema array', () => {
    const { registry, draft, observation } = setup();
    const realistic: StorageContractDraft = {
      workflowVersion: 'creation-content-v1',
      nodes: {
        researcher: { actorKinds: ['agent', 'program'], inputs: {},
          outputs: { research: { schema: observation, requiredInputs: [], appendVersions: true, initialState: 'candidate' } },
          actions: ['appendOutputVersion'] },
        author: { actorKinds: ['agent', 'program'], inputs: { priorDraft: { schema: draft, states: ['candidate'], optional: true } },
          outputs: { draft: { schema: draft, requiredInputs: [], appendVersions: true, initialState: 'candidate' } },
          actions: ['readBoundInput', 'appendOutputVersion'] },
      },
      stateRules: [],
    };
    const published = publishStorageContract(registry, realistic);
    expect(published.schemas.map((schema) => schema.namespace)).toEqual(['test/observation', 'test/fragment', 'test/draft']);
    const stored = jsonbOrdered(JSON.parse(JSON.stringify(published)));
    expect(Object.keys(stored.nodes)).toEqual(['author', 'researcher']);
    expect(() => verifyStorageContract(stored)).not.toThrow();
  });

  it('rejects explicit undefined optionals before hashing a persistent contract', () => {
    const { registry, draft, contractDraft } = setup();
    contractDraft.nodes.creator!.inputs.manuscript!.optional = undefined;
    expect(() => publishStorageContract(registry, contractDraft)).toThrow(/Only finite JSON values/);
    expect(() => registry.registerSchema({ namespace: 'test/undefined', revision: '1', dialect: JSON_SCHEMA_DIALECT,
      schema: { properties: { x: { const: undefined } } } as never, dependencies: [draft] }))
      .toThrow(/Only finite JSON values/);
  });
});

describe('workflow storage contract', () => {
  it('binds cold readers to a projection with no decision field', () => {
    const { registry, draft, contractDraft, payload } = setup();
    const contract = publishStorageContract(registry, contractDraft);
    assertInputState(contract, 'coldReader', 'manuscript', ref(draft), 'candidate', 'agent');
    expect(() => assertInputState(contract, 'coldReader', 'manuscript', ref(draft), 'accepted', 'agent'))
      .toThrow(/cannot read/);
    expect(projectBoundInput(registry, contract, 'coldReader', 'manuscript', payload, 'agent'))
      .toEqual({ script: { title: 'Visible', segments: [{ text: 'First' }] } });
    expect(() => assertNodeAction(contract, 'coldReader', 'readBoundInput', 'agent')).toThrow(/cannot perform/);
  });

  it('validates full business output separately from agent output and requires dependencies', () => {
    const { registry, contractDraft, payload } = setup();
    const contract = publishStorageContract(registry, contractDraft);
    validateAgentOutput(registry, contract, 'author', 'candidate', { script: 'Raw model text' }, 'agent');
    expect(() => validateAgentOutput(registry, contract, 'author', 'candidate', payload, 'agent'))
      .toThrow(/does not match/);
    validateNodeWrite(registry, contract, { nodeId: 'author', outputSlot: 'candidate',
      payload, dependencySlots: [], append: true, actorKind: 'agent' });
    expect(() => validateNodeWrite(registry, contract, { nodeId: 'coldReader', outputSlot: 'observation',
      payload: { retell: 'I understood it' }, dependencySlots: [], append: false, actorKind: 'agent' }))
      .toThrow(/Missing required dependency/);
    expect(() => validateNodeWrite(registry, contract, { nodeId: 'coldReader', outputSlot: 'observation',
      payload: { retell: 'I understood it' }, dependencySlots: ['manuscript'], append: true, actorKind: 'agent' }))
      .toThrow(/cannot append/);
    expect(() => validateNodeWrite(registry, contract, { nodeId: 'coldReader', outputSlot: 'observation',
      payload: { text: 'Wrong structure' }, dependencySlots: ['manuscript'], append: false, actorKind: 'agent' }))
      .toThrow(/does not match/);
  });

  it('keeps acceptance human-only and rejects invalid publication', () => {
    const { registry, draft, contractDraft } = setup();
    const contract = publishStorageContract(registry, contractDraft);
    assertStateTransition(contract, { nodeId: 'creator', schema: draft,
      from: 'candidate', to: 'accepted', action: 'accept', actorKind: 'human' });
    expect(() => assertStateTransition(contract, { nodeId: 'author', schema: draft,
      from: 'candidate', to: 'accepted', action: 'accept', actorKind: 'agent' })).toThrow();
    const bad = structuredClone(contractDraft);
    bad.stateRules[0]!.actorKinds = ['agent'];
    expect(() => publishStorageContract(registry, bad)).toThrow();
    const bypass = structuredClone(contractDraft);
    bypass.nodes.coldReader!.actions.push('readBoundInput');
    expect(() => publishStorageContract(registry, bypass)).toThrow(/bypass projection/);
    const invalidSession = structuredClone(contractDraft);
    invalidSession.nodes.author!.sessionPolicy = 'resume' as 'new';
    expect(() => publishStorageContract(registry, invalidSession)).toThrow(/sessionPolicy/);
  });
});
