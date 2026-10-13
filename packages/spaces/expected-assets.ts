import type { SchemaRef } from '@signal-room/workflow-space-contracts';
import type { ProcessDataBinding } from './process-contract.js';
import type { WorkflowPresentationDraft } from './presentation.js';
import type { WorkflowEntrypoint, WorkflowEntrypointDraft } from './types.js';

export interface ExpectedAssetConsumer {
  nodeId: string;
  port: string;
  bindingId: string;
  selection: ProcessDataBinding['selection'];
  when?: ProcessDataBinding['when'];
}

/** A method contract slot, never an actual asset or an asset version. */
export interface ExpectedAsset {
  id: string;
  source: { kind: 'run-input'; name: string } | { kind: 'node-output'; nodeId: string; port: string };
  label: string;
  schema?: SchemaRef;
  producer?: { nodeId: string; port: string };
  consumers: ExpectedAssetConsumer[];
  resultRoles: string[];
  /** Only declared result roles and data bindings establish use. */
  purpose: { resultRoles: string[]; consumerNodeIds: string[] };
  missing: string[];
}

export interface ExpectedAssetDependency {
  id: string;
  assetId: string;
  to: { nodeId: string; port: string };
  selection: ProcessDataBinding['selection'];
  when?: ProcessDataBinding['when'];
}

export interface ExpectedAssetGap {
  code: 'missing-process' | 'missing-storage-node' | 'missing-input-schema' | 'missing-output-schema' | 'missing-data-binding' | 'unknown-binding-source';
  nodeId?: string;
  port?: string;
  bindingId?: string;
  message: string;
}

export interface ExpectedAssetProjection {
  assets: ExpectedAsset[];
  dependencies: ExpectedAssetDependency[];
  gaps: ExpectedAssetGap[];
}

// Archify IDs must be ASCII identifiers. Hex cannot contain the separator,
// so distinct (node, port) pairs remain distinct even with arbitrary names.
const idPart = (value: string): string => Buffer.from(value, 'utf8').toString('hex');
const outputId = (nodeId: string, port: string): string => `expected_output_${idPart(nodeId)}_${idPart(port)}`;
const inputId = (name: string): string => `expected_input_${idPart(name)}`;

function sameSchema(left: SchemaRef, right: SchemaRef): boolean {
  return left.namespace === right.namespace && left.revision === right.revision && left.hash === right.hash;
}

/** Read-only projection of exactly the data handoffs declared by one method. */
export function projectExpectedAssets(
  entry: WorkflowEntrypoint | WorkflowEntrypointDraft,
  presentation?: WorkflowPresentationDraft,
): ExpectedAssetProjection {
  const process = entry.process;
  if (!process) return {assets: [], dependencies: [], gaps: [{code: 'missing-process', message: '方法未声明流程合同'}]};

  const assets: ExpectedAsset[] = [];
  const dependencies: ExpectedAssetDependency[] = [];
  const gaps: ExpectedAssetGap[] = [];
  const byId = new Map<string, ExpectedAsset>();
  const reservedIds = new Set(process.nodes.map(node => node.id));
  const allocatedIds = new Map<string, string>();
  const allocateId = (base: string): string => {
    let id = base;
    while (reservedIds.has(id)) id = `expected_${id}`;
    reservedIds.add(id); allocatedIds.set(base, id);
    return id;
  };
  const label = (schema: SchemaRef | undefined, fallback: string): string =>
    (schema && presentation?.assetViews.find(view => sameSchema(view.schema, schema))?.label) || fallback;

  for (const [name, schema] of Object.entries(process.runInputs ?? {})) {
    const asset: ExpectedAsset = {
      id: allocateId(inputId(name)), source: {kind: 'run-input', name}, label: label(schema, name), schema,
      consumers: [], resultRoles: [], purpose: {resultRoles: [], consumerNodeIds: []}, missing: [],
    };
    assets.push(asset); byId.set(asset.id, asset);
  }
  for (const node of process.nodes) {
    const storage = node.storageNodeId ? entry.storageContract.nodes[node.storageNodeId] : undefined;
    if (node.storageNodeId && !storage) gaps.push({code: 'missing-storage-node', nodeId: node.id, message: `${node.id} 的存储节点 ${node.storageNodeId} 缺失`});
    for (const [portName, port] of Object.entries(node.outputs ?? {})) {
      const schema = storage?.outputs[port.slot]?.schema;
      const asset: ExpectedAsset = {
        id: allocateId(outputId(node.id, portName)), source: {kind: 'node-output', nodeId: node.id, port: portName},
        label: label(schema, portName), ...(schema ? {schema} : {}), producer: {nodeId: node.id, port: portName},
        consumers: [], resultRoles: [], purpose: {resultRoles: [], consumerNodeIds: []},
        missing: schema ? [] : ['未找到输出端口的 schema'],
      };
      assets.push(asset); byId.set(asset.id, asset);
      if (!schema) gaps.push({code: 'missing-output-schema', nodeId: node.id, port: portName, message: `${node.id}.${portName} 缺少输出 schema`});
    }
    for (const [portName, port] of Object.entries(node.inputs ?? {})) {
      if (!storage?.inputs[port.slot]?.schema) gaps.push({code: 'missing-input-schema', nodeId: node.id, port: portName, message: `${node.id}.${portName} 缺少输入 schema`});
      if (!(process.dataBindings ?? []).some(binding => binding.to.node === node.id && binding.to.port === portName)) {
        gaps.push({code: 'missing-data-binding', nodeId: node.id, port: portName, message: `${node.id}.${portName} 未声明数据来源`});
      }
    }
  }

  for (const result of process.results) {
    const asset = byId.get(allocatedIds.get(outputId(result.nodeId, result.outputPort)) ?? '');
    if (asset) asset.resultRoles.push(result.role);
  }
  for (const binding of process.dataBindings ?? []) {
    const baseId = 'runInput' in binding.from ? inputId(binding.from.runInput) : outputId(binding.from.node, binding.from.port);
    const assetId = allocatedIds.get(baseId);
    const asset = assetId ? byId.get(assetId) : undefined;
    if (!asset) {
      gaps.push({code: 'unknown-binding-source', bindingId: binding.id, nodeId: binding.to.node, port: binding.to.port,
        message: `${binding.id} 的数据来源未在方法合同中找到`});
      continue;
    }
    const consumer: ExpectedAssetConsumer = {nodeId: binding.to.node, port: binding.to.port, bindingId: binding.id,
      selection: binding.selection, ...(binding.when ? {when: binding.when} : {})};
    asset.consumers.push(consumer);
    dependencies.push({id: binding.id, assetId: assetId!, to: {nodeId: binding.to.node, port: binding.to.port},
      selection: binding.selection, ...(binding.when ? {when: binding.when} : {})});
  }
  for (const asset of assets) asset.purpose = {
    resultRoles: [...asset.resultRoles], consumerNodeIds: [...new Set(asset.consumers.map(consumer => consumer.nodeId))],
  };
  return {assets, dependencies, gaps};
}
