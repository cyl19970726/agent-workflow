import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ActorKind = 'agent' | 'program' | 'human';
export type NodeAction =
  | 'readBoundInput'
  | 'readBoundInputProjection'
  | 'appendOutputVersion'
  | 'evaluate'
  | 'requestRevision'
  | 'accept';

export interface SchemaRef {
  namespace: string;
  revision: string;
  hash: string;
}

export interface SchemaDefinition {
  namespace: string;
  revision: string;
  dialect: typeof JSON_SCHEMA_DIALECT;
  schema: JsonValue;
  dependencies?: SchemaRef[];
}

export interface FrozenSchemaRevision extends Omit<SchemaDefinition, 'dependencies'>, SchemaRef {
  dependencies: SchemaRef[];
}

export interface ProjectionSpec {
  version: string;
  /** JSON Pointer paths. `*` selects the same field from every array element. */
  fields: string[];
  /** Optional schema for the projected value, distinct from the source schema. */
  schema?: SchemaRef;
}

export interface InputBinding {
  schema: SchemaRef;
  states: string[];
  optional?: boolean;
  projection?: ProjectionSpec;
}

export interface OutputBinding {
  /** Schema of the complete persisted business asset. */
  schema: SchemaRef;
  /** Input slot names whose exact asset versions must be recorded as dependencies. */
  requiredInputs: string[];
  appendVersions: boolean;
  initialState: string;
  /** Optional schema of the raw agent result before program assembly. */
  agentOutputSchema?: SchemaRef;
}

export interface NodeStorageBinding {
  actorKinds: ActorKind[];
  /** Session reuse is an explicit workflow decision; omitted means a new session. */
  sessionPolicy?: 'new' | 'continue';
  inputs: Record<string, InputBinding>;
  outputs: Record<string, OutputBinding>;
  actions: NodeAction[];
}

export interface StateRule {
  schema: SchemaRef;
  from: string;
  to: string;
  action: NodeAction;
  actorKinds: ActorKind[];
  nodeId: string;
}

export interface StorageContractDraft {
  workflowVersion: string;
  nodes: Record<string, NodeStorageBinding>;
  stateRules: StateRule[];
}

export interface FrozenStorageContract extends StorageContractDraft {
  hash: string;
  /** Exact, self-contained transitive schema dependency closure. */
  schemas: FrozenSchemaRevision[];
}

export interface NodeWriteRequest {
  nodeId: string;
  outputSlot: string;
  payload: unknown;
  dependencySlots: string[];
  /** True when adding a version to an existing logical asset. */
  append: boolean;
  actorKind: ActorKind;
}

export interface StateTransitionRequest {
  nodeId: string;
  schema: SchemaRef;
  from: string;
  to: string;
  action: NodeAction;
  actorKind: ActorKind;
}

export class ContractValidationError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const actions: readonly NodeAction[] = [
  'readBoundInput', 'readBoundInputProjection', 'appendOutputVersion',
  'evaluate', 'requestRevision', 'accept',
];
const actorKinds: readonly ActorKind[] = ['agent', 'program', 'human'];

function fail(message: string): never {
  throw new ContractValidationError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject non-JSON values before hashing or persisting a declaration. */
function jsonCopy(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') return fail('Only finite JSON values can be registered');
  if (seen.has(value)) return fail('Cyclic data cannot be registered');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return fail('Only plain JSON objects and arrays can be registered');
  }
  seen.add(value);
  const result: JsonValue = Array.isArray(value)
    ? value.map((entry) => jsonCopy(entry, seen))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonCopy(entry, seen)]));
  seen.delete(value);
  return result;
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value)!;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(jsonCopy(value))).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertNonempty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a nonempty string`);
}

function assertRef(ref: SchemaRef): void {
  if (!ref || typeof ref.namespace !== 'string' || typeof ref.revision !== 'string' ||
    typeof ref.hash !== 'string' || !namePattern.test(ref.namespace) ||
    !revisionPattern.test(ref.revision) || !hashPattern.test(ref.hash)) {
    fail('Schema reference requires a valid namespace, revision and SHA-256 hash');
  }
}

function refKey(ref: Pick<SchemaRef, 'namespace' | 'revision'>): string {
  return `${ref.namespace}@${ref.revision}`;
}

function sameRef(a: SchemaRef, b: SchemaRef): boolean {
  return a.namespace === b.namespace && a.revision === b.revision && a.hash === b.hash;
}

export function schemaUri(ref: Pick<SchemaRef, 'namespace' | 'revision'>): string {
  if (!ref || typeof ref.namespace !== 'string' || typeof ref.revision !== 'string' ||
    !namePattern.test(ref.namespace) || !revisionPattern.test(ref.revision)) fail('Invalid schema URI identity');
  return `aw://schema/${ref.namespace}@${ref.revision}`;
}

function parseExternalRef(uri: string): Pick<SchemaRef, 'namespace' | 'revision'> | null {
  const base = uri.split('#', 1)[0]!;
  const match = /^aw:\/\/schema\/(.+)@([^@]+)$/.exec(base);
  return match && namePattern.test(match[1]!) && revisionPattern.test(match[2]!)
    ? { namespace: match[1]!, revision: match[2]! } : null;
}

function inspectSchemaReferences(schema: JsonValue, dependencies: SchemaRef[]): void {
  const declared = new Map(dependencies.map((ref) => [refKey(ref), ref]));
  function visit(value: JsonValue, root = false): void {
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry));
    if (!isObject(value)) return;
    if (!root && '$id' in value) fail('Nested schema $id is unsupported');
    if ('$dynamicRef' in value || '$recursiveRef' in value || '$recursiveAnchor' in value || '$dynamicAnchor' in value) {
      fail('Dynamic and recursive references are unsupported; use frozen $ref dependencies');
    }
    if ('$ref' in value) {
      const uri = value.$ref;
      if (typeof uri !== 'string') fail('$ref must be a string');
      if (!uri.startsWith('#')) {
        const parsed = parseExternalRef(uri);
        if (!parsed || !declared.has(refKey(parsed))) {
          fail(`Unresolved or remote schema reference: ${uri}`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '$ref') visit(child as JsonValue);
    }
  }
  visit(schema, true);
}

export class SchemaRegistry {
  private readonly revisions = new Map<string, FrozenSchemaRevision>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(frozen: FrozenSchemaRevision[] = []) {
    // A snapshot is topologically ordered; hydration verifies every hash and dependency.
    for (const revision of frozen) {
      const registered = this.registerSchema(revision);
      if (registered.hash !== revision.hash) fail(`Schema snapshot hash mismatch for ${refKey(revision)}`);
    }
  }

  registerSchema(definition: SchemaDefinition): FrozenSchemaRevision {
    if (!definition || typeof definition.namespace !== 'string' || typeof definition.revision !== 'string' ||
      !namePattern.test(definition.namespace) || !revisionPattern.test(definition.revision)) {
      fail('Schema namespace or revision is invalid');
    }
    if (definition.dialect !== JSON_SCHEMA_DIALECT) fail('Only JSON Schema draft 2020-12 is supported');
    const schema = jsonCopy(definition.schema);
    if (!isObject(schema)) fail('A registered schema must have a JSON object root');
    if ('$schema' in schema && schema.$schema !== JSON_SCHEMA_DIALECT) fail('Schema $schema does not match its dialect');
    if ('$id' in schema && schema.$id !== schemaUri(definition)) fail('Schema $id must match its registry URI');
    const dependencies = (definition.dependencies ?? []).map((ref) => {
      assertRef(ref);
      const resolved = this.resolve(ref);
      return { namespace: resolved.namespace, revision: resolved.revision, hash: resolved.hash };
    });
    const keys = dependencies.map(refKey);
    if (new Set(keys).size !== keys.length) fail('Duplicate schema dependency');
    dependencies.sort((a, b) => refKey(a).localeCompare(refKey(b)));
    inspectSchemaReferences(schema, dependencies);
    const hash = digest({ namespace: definition.namespace, revision: definition.revision,
      dialect: definition.dialect, schema, dependencies });
    if ('hash' in definition && definition.hash !== hash) fail(`Schema hash mismatch for ${refKey(definition)}`);
    const key = refKey(definition);
    const prior = this.revisions.get(key);
    if (prior) {
      if (prior.hash !== hash) fail(`Schema identity ${key} is already registered with different content`);
      return prior;
    }
    const frozen = deepFreeze({ namespace: definition.namespace, revision: definition.revision,
      hash, dialect: definition.dialect, schema, dependencies });
    this.compile(frozen);
    this.revisions.set(key, frozen);
    return frozen;
  }

  resolve(ref: SchemaRef): FrozenSchemaRevision {
    assertRef(ref);
    const revision = this.revisions.get(refKey(ref));
    if (!revision || revision.hash !== ref.hash) fail(`Unknown schema revision ${refKey(ref)} with hash ${ref.hash}`);
    return revision;
  }

  validatePayload(ref: SchemaRef, payload: unknown): void {
    this.resolve(ref);
    const validator = this.validators.get(refKey(ref));
    if (!validator) fail(`Schema validator unavailable for ${refKey(ref)}`);
    const value = jsonCopy(payload);
    if (!validator(value)) {
      const issues = (validator.errors ?? []).map((error: ErrorObject) =>
        `${error.instancePath || '/'} ${error.message ?? error.keyword}`);
      throw new ContractValidationError(`Payload does not match ${refKey(ref)}`, issues);
    }
  }

  snapshot(): FrozenSchemaRevision[] {
    return [...this.revisions.values()].map((revision) => jsonCopy(revision) as unknown as FrozenSchemaRevision);
  }

  dependencyClosure(refs: SchemaRef[]): FrozenSchemaRevision[] {
    const ordered: FrozenSchemaRevision[] = [];
    const seen = new Set<string>();
    const visit = (ref: SchemaRef): void => {
      const revision = this.resolve(ref);
      const key = refKey(ref);
      if (seen.has(key)) return;
      seen.add(key);
      revision.dependencies.forEach(visit);
      ordered.push(jsonCopy(revision) as unknown as FrozenSchemaRevision);
    };
    refs.forEach(visit);
    return ordered;
  }

  private compile(revision: FrozenSchemaRevision): void {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
    for (const dependency of this.dependencyClosure(revision.dependencies)) {
      const source = dependency.schema as Record<string, JsonValue>;
      ajv.addSchema({ ...source, $id: schemaUri(dependency), $schema: JSON_SCHEMA_DIALECT }, schemaUri(dependency));
    }
    try {
      const source = revision.schema as Record<string, JsonValue>;
      const validator = ajv.compile({ ...source, $id: schemaUri(revision), $schema: JSON_SCHEMA_DIALECT });
      this.validators.set(refKey(revision), validator);
    } catch (error) {
      fail(`Invalid JSON Schema ${refKey(revision)}: ${String(error)}`);
    }
  }
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(value)) fail(`Unsupported ${label}: ${String(value)}`);
}

function assertUniqueStrings(values: string[], label: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim()) ||
    new Set(values).size !== values.length) fail(`${label} must contain unique nonempty strings`);
}

function pointerSegments(pointer: string): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') {
    fail(`Invalid projection JSON Pointer: ${String(pointer)}`);
  }
  const segments = pointer.slice(1).split('/');
  for (const segment of segments) {
    if (/~(?![01])/.test(segment)) fail(`Invalid JSON Pointer escape: ${pointer}`);
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (decoded === '__proto__' || decoded === 'constructor' || decoded === 'prototype') {
      fail(`Unsafe projection field: ${pointer}`);
    }
  }
  return segments.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function contractRefs(draft: StorageContractDraft): SchemaRef[] {
  const refs: SchemaRef[] = [];
  for (const node of Object.values(draft.nodes)) {
    for (const input of Object.values(node.inputs)) {
      refs.push(input.schema);
      if (input.projection?.schema) refs.push(input.projection.schema);
    }
    for (const output of Object.values(node.outputs)) {
      refs.push(output.schema);
      if (output.agentOutputSchema) refs.push(output.agentOutputSchema);
    }
  }
  draft.stateRules.forEach((rule) => refs.push(rule.schema));
  return refs;
}

function assertDraft(registry: SchemaRegistry, draft: StorageContractDraft): void {
  assertNonempty(draft.workflowVersion, 'workflowVersion');
  if (!isObject(draft.nodes) || !Object.keys(draft.nodes).length) fail('Contract must declare nodes');
  if (!Array.isArray(draft.stateRules)) fail('stateRules must be an array');
  for (const [nodeId, node] of Object.entries(draft.nodes)) {
    assertNonempty(nodeId, 'node ID');
    if (!node || !Array.isArray(node.actorKinds) || !node.actorKinds.length || !isObject(node.inputs) ||
      !isObject(node.outputs) || !Array.isArray(node.actions)) fail(`Invalid node binding ${nodeId}`);
    assertUniqueStrings(node.actorKinds, `${nodeId}.actorKinds`);
    node.actorKinds.forEach((kind) => assertEnum(kind, actorKinds, 'actor kind'));
    if (node.sessionPolicy !== undefined && node.sessionPolicy !== 'new' && node.sessionPolicy !== 'continue') {
      fail(`Invalid sessionPolicy on ${nodeId}`);
    }
    assertUniqueStrings(node.actions, `${nodeId}.actions`);
    node.actions.forEach((action) => assertEnum(action, actions, 'node action'));
    if (node.actions.includes('accept') && !node.actorKinds.includes('human')) {
      fail(`Node ${nodeId} cannot accept without a human actor`);
    }
    for (const [slot, input] of Object.entries(node.inputs)) {
      assertNonempty(slot, 'input slot');
      registry.resolve(input.schema);
      assertUniqueStrings(input.states, `${nodeId}.${slot}.states`);
      if (!input.states.length) fail(`Input ${nodeId}.${slot} must allow at least one state`);
      if (input.optional !== undefined && typeof input.optional !== 'boolean') fail(`Invalid optional flag on ${nodeId}.${slot}`);
      if (input.projection) {
        assertNonempty(input.projection.version, 'projection version');
        assertUniqueStrings(input.projection.fields, `${nodeId}.${slot}.projection.fields`);
        if (!input.projection.fields.length) fail(`Projection ${nodeId}.${slot} cannot be empty`);
        input.projection.fields.forEach(pointerSegments);
        if (input.projection.schema) registry.resolve(input.projection.schema);
        if (!node.actions.includes('readBoundInputProjection')) fail(`Node ${nodeId} lacks projection read action`);
        if (node.actions.includes('readBoundInput')) fail(`Node ${nodeId} may bypass projection on ${slot}`);
      }
    }
    for (const [slot, output] of Object.entries(node.outputs)) {
      assertNonempty(slot, 'output slot');
      registry.resolve(output.schema);
      if (output.agentOutputSchema) registry.resolve(output.agentOutputSchema);
      assertUniqueStrings(output.requiredInputs, `${nodeId}.${slot}.requiredInputs`);
      output.requiredInputs.forEach((inputSlot) => {
        if (!Object.hasOwn(node.inputs, inputSlot)) fail(`Unknown required input ${nodeId}.${slot}.${inputSlot}`);
      });
      if (typeof output.appendVersions !== 'boolean') fail(`Invalid appendVersions on ${nodeId}.${slot}`);
      assertNonempty(output.initialState, 'initialState');
      if (!node.actions.includes('appendOutputVersion')) fail(`Node ${nodeId} lacks output append action`);
    }
  }
  for (const rule of draft.stateRules) {
    registry.resolve(rule.schema);
    assertNonempty(rule.from, 'state rule from');
    assertNonempty(rule.to, 'state rule to');
    if (rule.from === rule.to) fail('State rule must change state');
    assertEnum(rule.action, actions, 'state rule action');
    if (!Array.isArray(rule.actorKinds) || !rule.actorKinds.length) fail('State rule must declare actor kinds');
    assertUniqueStrings(rule.actorKinds, 'state rule actor kinds');
    rule.actorKinds.forEach((kind) => assertEnum(kind, actorKinds, 'actor kind'));
    const node = draft.nodes[rule.nodeId];
    if (!node) fail(`Unknown state rule node ${rule.nodeId}`);
    if (!node.actions.includes(rule.action)) fail(`Node ${rule.nodeId} lacks action ${rule.action}`);
    if (rule.actorKinds.some((kind) => !node.actorKinds.includes(kind))) fail(`State rule exceeds node actor kinds`);
    if (rule.action === 'accept' && (rule.actorKinds.length !== 1 || rule.actorKinds[0] !== 'human')) {
      fail('Acceptance transitions must be human-only');
    }
  }
}

export function publishStorageContract(registry: SchemaRegistry, draft: StorageContractDraft): FrozenStorageContract {
  const copy = jsonCopy(draft) as unknown as StorageContractDraft;
  assertDraft(registry, copy);
  const schemas = registry.dependencyClosure(contractRefs(copy));
  const hash = digest({ ...copy, schemas });
  return deepFreeze({ ...copy, hash, schemas });
}

/** Recheck a stored contract and its embedded schema closure before use. */
export function verifyStorageContract(contract: FrozenStorageContract): SchemaRegistry {
  const registry = new SchemaRegistry(contract.schemas);
  const rebuilt = publishStorageContract(registry, {
    workflowVersion: contract.workflowVersion, nodes: contract.nodes, stateRules: contract.stateRules,
  });
  // JSONB reorders object keys. Rebuilding the dependency closure from those keys
  // can reorder its array even though the stored declaration and closure are intact.
  // Check exact closure membership, then hash the original frozen array order.
  const expected = new Map(rebuilt.schemas.map((schema) => [refKey(schema), schema.hash]));
  if (rebuilt.schemas.length !== contract.schemas.length ||
    contract.schemas.some((schema) => expected.get(refKey(schema)) !== schema.hash) ||
    digest({ workflowVersion: contract.workflowVersion, nodes: contract.nodes,
      stateRules: contract.stateRules, schemas: contract.schemas }) !== contract.hash) {
    fail('Stored workflow contract has been altered');
  }
  return registry;
}

export function assertNodeAction(contract: FrozenStorageContract, nodeId: string,
  action: NodeAction, actorKind: ActorKind): void {
  assertEnum(action, actions, 'node action');
  assertEnum(actorKind, actorKinds, 'actor kind');
  const node = contract.nodes[nodeId];
  if (!node || !node.actorKinds.includes(actorKind) || !node.actions.includes(action)) {
    fail(`Node ${nodeId} cannot perform ${action} as ${actorKind}`);
  }
  if (action === 'accept' && actorKind !== 'human') fail('Acceptance requires a human actor');
}

export function assertInputState(contract: FrozenStorageContract, nodeId: string,
  inputSlot: string, schema: SchemaRef, state: string, actorKind: ActorKind): void {
  const input = contract.nodes[nodeId]?.inputs[inputSlot];
  if (!input || !sameRef(input.schema, schema) || !input.states.includes(state)) {
    fail(`Input ${nodeId}.${inputSlot} cannot read ${refKey(schema)} in state ${state}`);
  }
  assertNodeAction(contract, nodeId, input.projection ? 'readBoundInputProjection' : 'readBoundInput', actorKind);
}

export function validateNodeWrite(registry: SchemaRegistry, contract: FrozenStorageContract,
  request: NodeWriteRequest): void {
  assertNodeAction(contract, request.nodeId, 'appendOutputVersion', request.actorKind);
  const node = contract.nodes[request.nodeId]!;
  const output = node.outputs[request.outputSlot];
  if (!output) fail(`Undeclared output ${request.nodeId}.${request.outputSlot}`);
  if (typeof request.append !== 'boolean') fail('append must be a boolean');
  if (request.append && !output.appendVersions) fail(`Output ${request.nodeId}.${request.outputSlot} cannot append versions`);
  assertUniqueStrings(request.dependencySlots, 'dependencySlots');
  for (const slot of request.dependencySlots) {
    if (!Object.hasOwn(node.inputs, slot)) fail(`Undeclared dependency input ${slot}`);
  }
  for (const slot of output.requiredInputs) {
    if (!request.dependencySlots.includes(slot)) fail(`Missing required dependency input ${slot}`);
  }
  registry.validatePayload(output.schema, request.payload);
}

export function validateAgentOutput(registry: SchemaRegistry, contract: FrozenStorageContract,
  nodeId: string, outputSlot: string, payload: unknown, actorKind: ActorKind): void {
  assertNodeAction(contract, nodeId, 'appendOutputVersion', actorKind);
  const output = contract.nodes[nodeId]?.outputs[outputSlot];
  if (!output?.agentOutputSchema) fail(`No agent output schema for ${nodeId}.${outputSlot}`);
  registry.validatePayload(output.agentOutputSchema, payload);
}

function projectAt(value: JsonValue, paths: string[][]): JsonValue | undefined {
  if (paths.some((path) => path.length === 0)) return jsonCopy(value);
  if (Array.isArray(value)) {
    const wildcard = paths.filter((path) => path[0] === '*').map((path) => path.slice(1));
    if (wildcard.length) return value.map((item) => projectAt(item, wildcard) ?? null);
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const result: Record<string, JsonValue> = {};
  const keys = new Set(paths.map((path) => path[0]!));
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const selected = projectAt(value[key] as JsonValue,
      paths.filter((path) => path[0] === key).map((path) => path.slice(1)));
    if (selected !== undefined) result[key] = selected;
  }
  return result;
}

/** Only selected fields leave the service, even if the source payload has more fields. */
export function projectBoundInput(registry: SchemaRegistry, contract: FrozenStorageContract,
  nodeId: string, inputSlot: string, payload: unknown, actorKind: ActorKind): JsonValue {
  const input = contract.nodes[nodeId]?.inputs[inputSlot];
  if (!input) fail(`Undeclared input ${nodeId}.${inputSlot}`);
  assertNodeAction(contract, nodeId, input.projection ? 'readBoundInputProjection' : 'readBoundInput', actorKind);
  registry.validatePayload(input.schema, payload);
  const source = jsonCopy(payload);
  if (!input.projection) return source;
  const projected = projectAt(source, input.projection.fields.map(pointerSegments)) ?? {};
  if (input.projection.schema) registry.validatePayload(input.projection.schema, projected);
  return projected;
}

export function assertStateTransition(contract: FrozenStorageContract, request: StateTransitionRequest): void {
  assertNodeAction(contract, request.nodeId, request.action, request.actorKind);
  const allowed = contract.stateRules.some((rule) => rule.nodeId === request.nodeId &&
    sameRef(rule.schema, request.schema) && rule.from === request.from && rule.to === request.to &&
    rule.action === request.action && rule.actorKinds.includes(request.actorKind));
  if (!allowed) fail(`State transition ${request.from} -> ${request.to} is not allowed`);
}
