import type { Selection } from './selection.js';

export interface ReadingPosition {
  top: number;
  openDetails: string[];
}

/** A reading surface belongs to its exact document or version, not the shared scroll container. */
export function readingPositionKey(root: string, scope: string, selection: Selection, revisions: { understanding?: string; methodDesign?: string } = {}): string {
  const subject = selection.view === 'goal'
    ? ['understanding', selection.understandingRevision || revisions.understanding || 'current-loading']
    : selection.view === 'workflow' && selection.tab === 'design'
      ? ['method-design', selection.methodDesignRevision || revisions.methodDesign || 'current-loading']
      : selection.view === 'workflow'
        ? ['workflow', selection.version || 'unselected', selection.tab, ...(selection.tab === 'process' ? [selection.case || '', selection.run || ''] : [])]
        : selection.view === 'business'
          ? ['business', selection.case || '', selection.run || '']
          : ['assets', 'catalog'];
  return `sw-reading:v2:${JSON.stringify([root, scope, ...subject])}`;
}

/** Node inspector state is separate from the graph canvas and scoped to the exact attempt. */
export function nodeInspectorReadingKey(root: string, scope: string, selection: Selection, pane: string): string | undefined {
  if (!selection.node || (selection.view !== 'business' && selection.view !== 'workflow')) return undefined;
  return `sw-inspector:v1:${JSON.stringify([root, scope, selection.version || '', selection.view, selection.tab, selection.run || '', selection.node, selection.occurrence || '', selection.runtimeAttempt || '', pane])}`;
}

export function readReadingPosition(storage: Pick<Storage, 'getItem'>, key: string): ReadingPosition | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Partial<ReadingPosition>;
    if (typeof item.top !== 'number' || !Number.isFinite(item.top) || item.top < 0 || !Array.isArray(item.openDetails) || !item.openDetails.every(part => typeof part === 'string')) return undefined;
    return { top: item.top, openDetails: item.openDetails };
  } catch { return undefined; }
}

export function writeReadingPosition(storage: Pick<Storage, 'setItem'>, key: string, value: ReadingPosition): void {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* reading remains usable when session storage is unavailable */ }
}
