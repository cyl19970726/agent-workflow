import { artifactPayloadSha256 } from '@signal-room/workflow';
import type { FrozenStorageContract, SchemaRef } from '@signal-room/workflow-space-contracts';

export type ProcessNodeKind = 'agent' | 'program' | 'decision' | 'human' | 'group';
export interface ProcessPort { slot: string; min?: number; max?: number | 'many' }
export interface ProcessNode {
  id: string; kind: ProcessNodeKind; storageNodeId?: string; phase?: string;
  inputs?: Record<string, ProcessPort>; outputs?: Record<string, ProcessPort>;
}
export interface ProcessEdge {
  id: string; from: string; to: string;
  kind: 'sequence' | 'fork' | 'join' | 'condition' | 'rework';
  /** A condition's observed route value, or a fork/join group identifier. */
  route?: string;
  /** Individual persisted branch within a fork/join group; distinct from the group identifier. */
  branch?: string;
  /** Required for a rework edge. Counts traversals, not technical attempts. */
  maxTraversals?: number;
}
export interface ProcessResult { role: string; nodeId: string; outputPort: string; many?: boolean }
export interface RelationTypeContract {
  id: string; revision: string;
  fromSchemas: SchemaRef[]; toSchemas: SchemaRef[];
  allowFromPointer?: boolean; allowToPointer?: boolean;
  maxPerFrom?: number; maxPerTo?: number;
  scope?: 'case' | 'run';
  allowCycle?: boolean;
}
/** Mapping is from a newly produced output to an exact input bound in the same node context. */
export interface ProcessRelationMapping {
  id: string; typeId: string; nodeId: string; outputPort: string; inputPort?: string; toOutputPort?: string;
  required?: boolean;
  /** Binding mappings can be derived; explicit mappings require publication declarations (for fragments). */
  policy?: 'binding' | 'explicit';
}
/** Declared input provenance. Exact consumed versions still come from node receipts. */
export interface ProcessDataBinding {
  id: string;
  from: { node: string; port: string } | { runInput: string };
  to: { node: string; port: string };
  selection: 'latest-successful-in-this-run' | 'previous-business-round' | 'current-business-round' | 'frozen-input';
  /** Disjoint alternatives, e.g. a frozen prior draft on the first round. */
  when?: 'initial-round' | 'later-rounds';
}
export interface ProcessContractDraft {
  revision: string; nodes: ProcessNode[]; edges: ProcessEdge[]; results: ProcessResult[];
  relationTypes?: RelationTypeContract[]; relationMappings?: ProcessRelationMapping[];
  runInputs?: Record<string, SchemaRef>;
  dataBindings?: ProcessDataBinding[];
}
export interface ProcessContract extends ProcessContractDraft { hash: string }

function fail(message: string): never { throw new Error(`Invalid process contract: ${message}`); }
function named(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) fail(label);
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`duplicate ${label}`);
}
function sameSchema(a: SchemaRef, b: SchemaRef): boolean {
  return a.namespace === b.namespace && a.revision === b.revision && a.hash === b.hash;
}
function validatePortMap(ports: Record<string, ProcessPort> | undefined, storage: Record<string, {schema: SchemaRef}> | undefined,
  label: string): void {
  for (const [name, port] of Object.entries(ports ?? {})) {
    named(name, `${label} port name`); named(port.slot, `${label} slot`);
    if (!storage?.[port.slot]) fail(`${label}.${name} references an unknown storage slot`);
    if (port.min !== undefined && (!Number.isInteger(port.min) || port.min < 0)) fail(`${label}.${name} minimum`);
    if (port.max !== undefined && port.max !== 'many' && (!Number.isInteger(port.max) || port.max < (port.min ?? 0))) fail(`${label}.${name} maximum`);
  }
  unique(Object.values(ports ?? {}).map(port => port.slot), `${label} slot`);
}

export async function publishProcessContract(draft: ProcessContractDraft, storage: FrozenStorageContract): Promise<ProcessContract> {
  named(draft.revision, 'revision');
  if (!Array.isArray(draft.nodes) || !draft.nodes.length || !Array.isArray(draft.edges) || !Array.isArray(draft.results)) fail('nodes, edges and results required');
  unique(draft.nodes.map(node => node.id), 'node ID');
  unique(draft.edges.map(edge => edge.id), 'edge ID');
  unique((draft.relationTypes ?? []).map(type => type.id), 'relation type ID');
  unique((draft.relationMappings ?? []).map(mapping => mapping.id), 'relation mapping ID');
  unique((draft.dataBindings ?? []).map(binding => binding.id), 'data binding ID');
  const nodes = new Map(draft.nodes.map(node => [node.id, node]));
  const types = new Map((draft.relationTypes ?? []).map(type => [type.id, type]));
  for (const node of draft.nodes) {
    named(node.id, 'node ID');
    if (!['agent','program','decision','human','group'].includes(node.kind)) fail(`${node.id} kind`);
    if (node.storageNodeId && !storage.nodes[node.storageNodeId]) fail(`${node.id} storage node`);
    if ((node.inputs || node.outputs) && !node.storageNodeId) fail(`${node.id} ports need a storage node`);
    const binding = node.storageNodeId ? storage.nodes[node.storageNodeId] : undefined;
    validatePortMap(node.inputs, binding?.inputs, `${node.id} input`);
    validatePortMap(node.outputs, binding?.outputs, `${node.id} output`);
  }
  for (const [name, schema] of Object.entries(draft.runInputs ?? {})) {
    named(name, 'run input name');
    if (!storage.schemas.some(known => sameSchema(known, schema))) fail(`${name} unknown run input schema`);
  }
  const destinations = new Map<string, Set<string>>();
  for (const binding of draft.dataBindings ?? []) {
    named(binding.id, 'data binding ID');
    named(binding.to.node, `${binding.id} target node`); named(binding.to.port, `${binding.id} target port`);
    if (!['latest-successful-in-this-run', 'previous-business-round', 'current-business-round', 'frozen-input'].includes(binding.selection)) fail(`${binding.id} selection`);
    if (binding.when !== undefined && !['initial-round', 'later-rounds'].includes(binding.when)) fail(`${binding.id} condition`);
    const target = nodes.get(binding.to.node);
    const targetPort = target?.inputs?.[binding.to.port];
    const targetSchema = target?.storageNodeId && targetPort ? storage.nodes[target.storageNodeId]?.inputs[targetPort.slot]?.schema : undefined;
    if (!targetSchema) fail(`${binding.id} unknown input endpoint`);
    let sourceSchema: SchemaRef | undefined;
    if ('runInput' in binding.from) {
      if (Object.keys(binding.from).length !== 1) fail(`${binding.id} ambiguous source`);
      named(binding.from.runInput, `${binding.id} run input`);
      sourceSchema = draft.runInputs?.[binding.from.runInput];
      if (binding.selection !== 'frozen-input') fail(`${binding.id} run input requires frozen-input selection`);
    } else {
      if (Object.keys(binding.from).length !== 2) fail(`${binding.id} ambiguous source`);
      named(binding.from.node, `${binding.id} source node`); named(binding.from.port, `${binding.id} source port`);
      const source = nodes.get(binding.from.node), sourcePort = source?.outputs?.[binding.from.port];
      sourceSchema = source?.storageNodeId && sourcePort ? storage.nodes[source.storageNodeId]?.outputs[sourcePort.slot]?.schema : undefined;
      if (binding.selection === 'frozen-input') fail(`${binding.id} node output cannot use frozen-input selection`);
      if (binding.from.node === binding.to.node && binding.selection === 'current-business-round') fail(`${binding.id} current-round self dependency`);
    }
    if (!sourceSchema) fail(`${binding.id} unknown source endpoint`);
    if (!sameSchema(sourceSchema, targetSchema)) fail(`${binding.id} input/output schema mismatch`);
    const key = `${binding.to.node}:${binding.to.port}`, condition = binding.when ?? 'always';
    const prior = destinations.get(key) ?? new Set<string>();
    if (prior.has(condition) || (prior.size && (condition === 'always' || prior.has('always')))) fail(`${binding.id} overlapping input bindings`);
    prior.add(condition); destinations.set(key, prior);
  }
  for (const edge of draft.edges) {
    named(edge.id, 'edge ID');
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail(`${edge.id} endpoint`);
    if (!['sequence','fork','join','condition','rework'].includes(edge.kind)) fail(`${edge.id} kind`);
    if (edge.kind === 'rework') {
      if (!Number.isInteger(edge.maxTraversals) || (edge.maxTraversals ?? 0) < 1) fail(`${edge.id} rework budget`);
    } else if (edge.maxTraversals !== undefined) fail(`${edge.id} unexpected traversal budget`);
    if (edge.kind === 'condition' && !edge.route) fail(`${edge.id} condition route`);
    if(edge.branch!==undefined){named(edge.branch,`${edge.id} branch`);if(!['fork','join'].includes(edge.kind))fail(`${edge.id} unexpected branch`);}
  }
  for (const kind of ['fork','join'] as const) {
    const grouped = new Map<string, ProcessEdge[]>();
    for (const edge of draft.edges.filter(edge => edge.kind === kind)) {
      if (!edge.route) fail(`${edge.id} ${kind} group`);
      const key = `${kind}:${edge.route}:${kind === 'fork' ? edge.from : edge.to}`;
      grouped.set(key, [...(grouped.get(key) ?? []), edge]);
    }
    for (const [key, edges] of grouped) {if (edges.length < 2) fail(`${key} needs at least two edges`);unique(edges.flatMap(edge=>edge.branch?[edge.branch]:[]),`${key} branch`);}
  }
  const conditions = draft.edges.filter(edge => edge.kind === 'condition');
  unique(conditions.map(edge => `${edge.from}:${edge.route}`), 'condition route');
  // Cycles must be explicit, bounded rework edges. Ignore those edges when checking the DAG.
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) fail('unbounded control cycle');
    if (visited.has(id)) return;
    active.add(id);
    for (const edge of draft.edges) if (edge.from === id && edge.kind !== 'rework') visit(edge.to);
    active.delete(id); visited.add(id);
  };
  for (const node of draft.nodes) visit(node.id);
  unique(draft.results.map(result => result.role), 'result role');
  for (const result of draft.results) {
    named(result.role, 'result role');
    const port = nodes.get(result.nodeId)?.outputs?.[result.outputPort];
    if (!port) fail(`${result.role} result endpoint`);
    if (result.many && port.max === 1) fail(`${result.role} result multiplicity`);
  }
  for (const type of draft.relationTypes ?? []) {
    named(type.id, 'relation type ID'); named(type.revision, 'relation type revision');
    if(type.scope !== undefined && !['case','run'].includes(type.scope)) fail(`${type.id} scope`);
    if (!type.fromSchemas.length || !type.toSchemas.length) fail(`${type.id} endpoint schemas`);
    for (const ref of [...type.fromSchemas,...type.toSchemas]) {
      if (!storage.schemas.some(schema => sameSchema(schema, ref))) fail(`${type.id} unknown exact schema`);
    }
    for (const count of [type.maxPerFrom,type.maxPerTo]) if (count !== undefined && (!Number.isInteger(count) || count < 1)) fail(`${type.id} cardinality`);
  }
  for (const mapping of draft.relationMappings ?? []) {
    named(mapping.id, 'relation mapping ID');
    if(mapping.policy !== undefined && !['binding','explicit'].includes(mapping.policy)) fail(`${mapping.id} policy`);
    const node = nodes.get(mapping.nodeId), type = types.get(mapping.typeId);
    const outputSlot = node?.outputs?.[mapping.outputPort]?.slot;
    if(Boolean(mapping.inputPort)===Boolean(mapping.toOutputPort)) fail(`${mapping.id} needs exactly one target port`);
    const inputSlot = mapping.inputPort ? node?.inputs?.[mapping.inputPort]?.slot : node?.outputs?.[mapping.toOutputPort!]?.slot;
    const binding = node?.storageNodeId ? storage.nodes[node.storageNodeId] : undefined;
    const output = outputSlot ? binding?.outputs[outputSlot] : undefined;
    const input = inputSlot ? (mapping.inputPort ? binding?.inputs[inputSlot] : binding?.outputs[inputSlot]) : undefined;
    if (!type || !output || !input) fail(`${mapping.id} port or type`);
    if (!type.fromSchemas.some(ref => sameSchema(ref, output.schema)) || !type.toSchemas.some(ref => sameSchema(ref, input.schema))) fail(`${mapping.id} schema direction`);
    if (mapping.required && 'optional' in input && input.optional) fail(`${mapping.id} required mapping uses optional input`);
  }
  const copy = structuredClone(draft);
  return {...copy, hash: await artifactPayloadSha256(copy)};
}
