import { describe, expect, it, vi } from 'vitest';
import { focusGraphNode, isGraphReady, postGraphState, selectedGraphNode } from './bridge.js';
import type { WorkflowGraphStateDto } from '@signal-room/workflow-space-api/contracts';

describe('graph bridge', () => {
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const ids = new Set(['author', 'researcher']);
  it('accepts only the current frame, expected type, and exact known node', () => {
    expect(selectedGraphNode({ source: frame, data: { type: 'workflow-node-select', nodeId: 'author' } } as MessageEvent, frame, ids)).toBe('author');
    expect(selectedGraphNode({ source: {} as Window, data: { type: 'workflow-node-select', nodeId: 'author' } } as MessageEvent, frame, ids)).toBeNull();
    expect(selectedGraphNode({ source: frame, data: { type: 'space-node-focus', nodeId: 'author' } } as MessageEvent, frame, ids)).toBeNull();
    expect(selectedGraphNode({ source: frame, data: { type: 'workflow-node-select', nodeId: 'unknown' } } as MessageEvent, frame, ids)).toBeNull();
  });
  it('focuses allowed nodes without sending a reset or echo to unknown nodes', () => {
    focusGraphNode(frame, 'author', ids);
    focusGraphNode(frame, undefined, ids);
    focusGraphNode(frame, 'unknown', ids);
    expect(frame.postMessage).toHaveBeenCalledTimes(1);
    expect(frame.postMessage).toHaveBeenCalledWith({ type: 'space-node-focus', nodeId: 'author' }, '*');
  });
  it('accepts readiness only from the current iframe and exact run identity, then sends a validated monotonic state', () => {
    const identity = { spaceId: 'space-1', runId: 'run-1', versionId: 'version-1' };
    const ready = { type: 'space-graph-ready', ...identity };
    const state: WorkflowGraphStateDto = {
      schemaVersion: 1, ...identity, digest: 'digest-1', truncated: false,
      nodes: [{ id: 'author', state: 'failed', label: '第 2 轮', round: 2, occurrences: [{ id: 'o2', branch: null, state: 'failed', provenance: 'observed' }] }],
      edges: [],
    };
    expect(isGraphReady({ source: frame, data: ready } as MessageEvent, frame, identity)).toBe(true);
    expect(isGraphReady({ source: {} as Window, data: ready } as MessageEvent, frame, identity)).toBe(false);
    expect(isGraphReady({ source: frame, data: { ...ready, runId: 'run-2' } } as MessageEvent, frame, identity)).toBe(false);
    expect(postGraphState(frame, state, identity, ids, 1)).toBe(true);
    expect(frame.postMessage).toHaveBeenLastCalledWith({ type: 'space-graph-state', serial: 1, state }, '*');
    expect(postGraphState(frame, { ...state, runId: 'run-2' }, identity, ids, 2)).toBe(false);
    expect(postGraphState(frame, { ...state, nodes: [{ ...state.nodes[0]!, id: 'unknown' }] }, identity, ids, 2)).toBe(false);
    expect(postGraphState(frame, state, identity, ids, 0)).toBe(false);
  });
});
