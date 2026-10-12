import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractValidationError, JSON_SCHEMA_DIALECT, SchemaRegistry, schemaUri } from './index.js';
import type { FrozenSchemaRevision, SchemaRef } from './index.js';

let compile: ReturnType<typeof vi.spyOn>;
beforeEach(() => { compile = vi.spyOn(Ajv2020.prototype, 'compile'); });
afterEach(() => vi.restoreAllMocks());

function register(registry: SchemaRegistry, namespace: string, revision: string, schema: Record<string, unknown>, dependencies?: SchemaRef[]) {
  return registry.registerSchema({ namespace, revision, dialect: JSON_SCHEMA_DIALECT, schema, dependencies });
}

function validationIssues(registry: SchemaRegistry, ref: SchemaRef, payload: unknown): string[] {
  try {
    registry.validatePayload(ref, payload);
  } catch (error) {
    if (error instanceof ContractValidationError) return error.issues;
    throw error;
  }
  throw new Error('Expected invalid payload');
}

describe('compiled schema validator cache', () => {
  it('reuses verified validators across registries while preserving payload checks and per-call errors', () => {
    const revision = register(new SchemaRegistry(), 'cache/reuse-case', '1', {
      type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 3 } }, additionalProperties: false,
    });
    const snapshot = [revision];
    const firstRegistry = new SchemaRegistry(snapshot);
    const secondRegistry = new SchemaRegistry(snapshot);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(() => firstRegistry.validatePayload(revision, { name: 'valid' })).not.toThrow();
    const typeIssues = validationIssues(firstRegistry, revision, { name: 4 });
    expect(() => secondRegistry.validatePayload(revision, { name: 'fine' })).not.toThrow();
    const lengthIssues = validationIssues(secondRegistry, revision, { name: 'x' });
    expect(typeIssues.join(' ')).toContain('must be string');
    expect(lengthIssues.join(' ')).toContain('must NOT have fewer than 3 characters');
    expect(lengthIssues).not.toEqual(typeIssues);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('does not reuse validators for distinct schemas or exact dependency revisions', () => {
    const firstRegistry = new SchemaRegistry();
    const firstDependency = register(firstRegistry, 'cache/dependency', '1', { type: 'string' });
    const firstRoot = register(firstRegistry, 'cache/root', '1', {
      type: 'object', properties: { value: { $ref: schemaUri(firstDependency) } },
    }, [firstDependency]);
    const restored = new SchemaRegistry([firstDependency, firstRoot]);
    expect(compile).toHaveBeenCalledTimes(2);

    const secondRegistry = new SchemaRegistry();
    // Separate registries can contain the same named revision with different
    // verified content. The transitive dependency hash must distinguish them.
    const secondDependency = register(secondRegistry, 'cache/dependency', '1', { type: 'number' });
    const secondRoot = register(secondRegistry, 'cache/root', '1', {
      type: 'object', properties: { value: { $ref: schemaUri(secondDependency) } },
    }, [secondDependency]);
    const otherSchema = register(secondRegistry, 'cache/root', '3', { type: 'boolean' });

    expect(compile).toHaveBeenCalledTimes(5);
    expect(() => restored.validatePayload(firstRoot, { value: 'text' })).not.toThrow();
    expect(() => secondRegistry.validatePayload(secondRoot, { value: 'text' })).toThrow(ContractValidationError);
    expect(() => secondRegistry.validatePayload(otherSchema, true)).not.toThrow();
  });

  it('checks hashes and dependency closure before consulting cached validators', () => {
    const registry = new SchemaRegistry();
    const dependency = register(registry, 'cache/integrity-dependency', '1', { type: 'string' });
    const revision = register(registry, 'cache/integrity-root', '1', {
      type: 'object', properties: { value: { $ref: schemaUri(dependency) } },
    }, [dependency]);
    const compileCount = compile.mock.calls.length;

    expect(() => new SchemaRegistry([dependency, { ...revision, hash: '0'.repeat(64) }])).toThrow(/hash mismatch/);
    const missingDependency = { ...revision, dependencies: [] } as FrozenSchemaRevision;
    expect(() => new SchemaRegistry([dependency, missingDependency])).toThrow(/Unresolved/);
    expect(compile).toHaveBeenCalledTimes(compileCount);
  });

  it('keeps the process cache bounded to the most recent 128 compiled validators', () => {
    const revisions: FrozenSchemaRevision[] = [];
    for (let index = 0; index < 130; index++) {
      revisions.push(register(new SchemaRegistry(), `cache/capacity-${index}`, '1', { type: 'string', minLength: index + 1 }));
    }
    const compiled = compile.mock.calls.length;

    new SchemaRegistry([revisions[129]!]);
    expect(compile).toHaveBeenCalledTimes(compiled);
    new SchemaRegistry([revisions[0]!]);
    expect(compile).toHaveBeenCalledTimes(compiled + 1);
  });

  it('rejects asynchronous schemas instead of treating their pending validation as success', () => {
    const registry = new SchemaRegistry();
    expect(() => register(registry, 'cache/async-schema', '1', { $async: true, type: 'string' }))
      .toThrow(/Asynchronous JSON Schema validation is unsupported/);
    expect(compile).not.toHaveBeenCalled();

    const dataValue = register(registry, 'cache/async-key-data', '1', { const: { $async: true } });
    expect(() => registry.validatePayload(dataValue, { $async: true })).not.toThrow();
    expect(compile).toHaveBeenCalledOnce();
  });
});
