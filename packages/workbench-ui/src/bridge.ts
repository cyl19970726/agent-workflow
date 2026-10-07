import type { WorkflowGraphStateDto } from '@signal-room/workflow-space-api/contracts';

export interface GraphBridgeMessage { type: 'workflow-node-select'; nodeId: string }
export interface GraphIdentity { spaceId: string; runId: string; versionId: string }

export function selectedGraphNode(event: MessageEvent, frameWindow: Window | null, allowedIds: ReadonlySet<string>): string | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return null;
  const message = data as Partial<GraphBridgeMessage>;
  if (message.type !== 'workflow-node-select' || typeof message.nodeId !== 'string') return null;
  return allowedIds.has(message.nodeId) ? message.nodeId : null;
}

export function focusGraphNode(frameWindow: Window | null, nodeId: string | undefined, allowedIds: ReadonlySet<string>): void {
  if (frameWindow && nodeId && allowedIds.has(nodeId)) frameWindow.postMessage({ type: 'space-node-focus', nodeId }, '*');
}

export function isGraphReady(event: MessageEvent, frameWindow: Window | null, identity: GraphIdentity | undefined): boolean {
  if (!frameWindow || !identity || event.source !== frameWindow) return false;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return false;
  const message = data as Record<string, unknown>;
  return message.type === 'space-graph-ready' && message.spaceId === identity.spaceId && message.runId === identity.runId && message.versionId === identity.versionId;
}

export function postGraphState(frameWindow: Window | null, state: WorkflowGraphStateDto | null | undefined, identity: GraphIdentity | undefined, allowedIds: ReadonlySet<string>, serial: number): boolean {
  if (!frameWindow || !state || !identity || !Number.isSafeInteger(serial) || serial < 1) return false;
  if (state.schemaVersion !== 1 || state.spaceId !== identity.spaceId || state.runId !== identity.runId || state.versionId !== identity.versionId) return false;
  if (state.nodes.some(node => !allowedIds.has(node.id))) return false;
  frameWindow.postMessage({ type: 'space-graph-state', serial, state }, '*');
  return true;
}
