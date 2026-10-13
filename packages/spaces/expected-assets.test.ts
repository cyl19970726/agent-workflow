import { describe, expect, it } from 'vitest';
import type { SchemaRef } from '@signal-room/workflow-space-contracts';
import type { WorkflowEntrypoint } from './types.js';
import { projectExpectedAssets } from './expected-assets.js';

const draft: SchemaRef = {namespace: 'content/draft', revision: '1', hash: 'a'.repeat(64)};
const notes: SchemaRef = {namespace: 'content/notes', revision: '1', hash: 'b'.repeat(64)};
const entry = {
  workflowId: 'CONTENT', codeRevision: 'r1',
  storageContract: {nodes: {
    writer: {inputs: {materials: {schema: notes}, previous: {schema: draft}}, outputs: {draft: {schema: draft}}},
    reviewer: {inputs: {target: {schema: draft}}, outputs: {}},
  }},
  process: {
    revision: '1', hash: 'c'.repeat(64),
    nodes: [
      {id: 'writer', kind: 'agent', storageNodeId: 'writer', inputs: {materials: {slot: 'materials'}, previous: {slot: 'previous'}}, outputs: {draft: {slot: 'draft'}}},
      {id: 'reviewer', kind: 'agent', storageNodeId: 'reviewer', inputs: {target: {slot: 'target'}}},
    ],
    edges: [{id: 'control', from: 'writer', to: 'reviewer', kind: 'sequence'}],
    results: [{role: 'primary', nodeId: 'writer', outputPort: 'draft'}],
    runInputs: {materials: notes},
    dataBindings: [
      {id: 'materials-to-writer', from: {runInput: 'materials'}, to: {node: 'writer', port: 'materials'}, selection: 'frozen-input'},
      {id: 'draft-to-reviewer', from: {node: 'writer', port: 'draft'}, to: {node: 'reviewer', port: 'target'}, selection: 'current-business-round'},
      {id: 'draft-to-next-round', from: {node: 'writer', port: 'draft'}, to: {node: 'writer', port: 'previous'}, selection: 'previous-business-round', when: 'later-rounds'},
    ],
  },
} as unknown as WorkflowEntrypoint;

describe('expected method assets', () => {
  it('uses exact run input and output ports, schemas, declared consumers and result roles without a run', () => {
    const result = projectExpectedAssets(entry, {
      id: 'display', revision: '1', entrypoint: 'CONTENT', label: 'CONTENT',
      assetViews: [{schema: draft, label: '文章草稿', sections: []}],
      results: {primary: 'primary', supporting: [], assessments: []},
    });
    expect(result.assets.map(asset => asset.id)).toEqual(['expected_input_6d6174657269616c73', 'expected_output_777269746572_6472616674']);
    expect(result.assets[1]).toMatchObject({label: '文章草稿', schema: draft, producer: {nodeId: 'writer', port: 'draft'},
      resultRoles: ['primary'], purpose: {resultRoles: ['primary'], consumerNodeIds: ['reviewer', 'writer']}});
    expect(result.assets[1].consumers).toEqual([
      {nodeId: 'reviewer', port: 'target', bindingId: 'draft-to-reviewer', selection: 'current-business-round'},
      {nodeId: 'writer', port: 'previous', bindingId: 'draft-to-next-round', selection: 'previous-business-round', when: 'later-rounds'},
    ]);
    expect(result.dependencies.map(item => item.id)).toEqual(['materials-to-writer', 'draft-to-reviewer', 'draft-to-next-round']);
    expect(result.gaps).toEqual([]);
  });

  it('does not infer data handoffs from control edges or matching schemas', () => {
    const withoutBinding = {...entry, process: {...entry.process!, dataBindings: []}} as WorkflowEntrypoint;
    const result = projectExpectedAssets(withoutBinding);
    expect(result.dependencies).toEqual([]);
    expect(result.assets[1].consumers).toEqual([]);
    expect(result.gaps.filter(gap => gap.code === 'missing-data-binding').map(gap => `${gap.nodeId}.${gap.port}`))
      .toEqual(['writer.materials', 'writer.previous', 'reviewer.target']);
  });

  it('keeps same-schema output ports distinct and names missing draft schema evidence', () => {
    const changed = structuredClone(entry);
    changed.process!.nodes[0].outputs!.alternate = {slot: 'alternate'};
    const result = projectExpectedAssets(changed);
    const alternate = result.assets.find(asset => asset.source.kind === 'node-output' && asset.source.port === 'alternate');
    expect(alternate?.id).not.toBe(result.assets.find(asset => asset.source.kind === 'node-output' && asset.source.port === 'draft')?.id);
    expect(alternate?.schema).toBeUndefined();
    expect(alternate?.missing).toEqual(['未找到输出端口的 schema']);
    expect(result.gaps).toContainEqual({code: 'missing-output-schema', nodeId: 'writer', port: 'alternate', message: 'writer.alternate 缺少输出 schema'});
  });

  it('allocates an asset ID around a legal process-node collision without changing its bindings', () => {
    const changed = structuredClone(entry);
    changed.process!.nodes.push({id: 'expected_output_777269746572_6472616674', kind: 'group'});
    const result = projectExpectedAssets(changed);
    const asset = result.assets.find(item => item.source.kind === 'node-output');
    expect(asset?.id).toBe('expected_expected_output_777269746572_6472616674');
    expect(result.dependencies.filter(item => item.assetId === asset?.id).map(item => item.id))
      .toEqual(['draft-to-reviewer', 'draft-to-next-round']);
    expect(asset?.resultRoles).toEqual(['primary']);
  });
});
