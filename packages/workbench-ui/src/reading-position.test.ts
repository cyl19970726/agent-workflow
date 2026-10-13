import { describe, expect, it } from 'vitest';
import { nodeInspectorReadingKey, readReadingPosition, readingPositionKey, writeReadingPosition } from './reading-position.js';
import { readSelection } from './selection.js';

describe('reading position identity', () => {
  const root = '/api/spaces/example';
  const scope = 'reader:scope';
  it('separates actual goal and draft revisions from accurate version views', () => {
    const goal = readSelection(new URLSearchParams('view=goal&version=v1'));
    const draft = readSelection(new URLSearchParams('view=workflow&tab=design&version=v1'));
    const method = readSelection(new URLSearchParams('view=workflow&tab=definition&version=v1'));
    const cases = readSelection(new URLSearchParams('view=workflow&tab=process&version=v1'));
    expect(readingPositionKey(root, scope, goal, { understanding: 'revision-5' })).not.toBe(readingPositionKey(root, scope, goal, { understanding: 'revision-4' }));
    expect(readingPositionKey(root, scope, draft, { methodDesign: 'draft-4' })).not.toBe(readingPositionKey(root, scope, method));
    expect(readingPositionKey(root, scope, method)).not.toBe(readingPositionKey(root, scope, cases));
    expect(readingPositionKey(root, scope, method)).not.toBe(readingPositionKey(root, scope, { ...method, version: 'v2' }));
  });
  it('restores a saved position and open details while ignoring corrupt state', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeReadingPosition(storage, 'document', { top: 930, openDetails: ['0:来源', '2:准确身份'] });
    expect(readReadingPosition(storage, 'document')).toEqual({ top: 930, openDetails: ['0:来源', '2:准确身份'] });
    values.set('document', '{invalid');
    expect(readReadingPosition(storage, 'document')).toBeUndefined();
  });
  it('returns to the same exact goal reading state after following a source into an asset or Run', () => {
    const origin = readSelection(new URLSearchParams('view=goal&understandingRevision=goal-6'));
    const reading = readSelection(new URLSearchParams('view=business&case=case-1&run=run-1&node=author&sourceRevision=goal-6&sourceIndex=16'));
    const returned = { ...reading, view: 'goal' as const, understandingRevision: reading.sourceRevision };
    expect(readingPositionKey(root, scope, returned)).toBe(readingPositionKey(root, scope, origin));
    expect(readingPositionKey(root, scope, { ...returned, understandingRevision: 'goal-5' })).not.toBe(readingPositionKey(root, scope, origin));
  });
  it('restores the exact design revision and its open sources after following D6 or D7', () => {
    const draft = readSelection(new URLSearchParams('view=workflow&tab=design&methodDesignRevision=design-5'));
    const followed = readSelection(new URLSearchParams('view=business&tab=process&case=case-1&run=run-1&designSourceRevision=design-5&designSourceIndex=1'));
    const returned = { ...followed, view: 'workflow' as const, tab: 'design' as const, methodDesignRevision: followed.designSourceRevision };
    expect(readingPositionKey(root, scope, returned)).toBe(readingPositionKey(root, scope, draft));
    expect(readingPositionKey(root, scope, { ...returned, methodDesignRevision: 'design-4' })).not.toBe(readingPositionKey(root, scope, draft));
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) || null, setItem: (key: string, value: string) => { store.set(key, value); } };
    writeReadingPosition(storage, readingPositionKey(root, scope, draft), { top: 820, openDetails: ['id:design-sources', 'summary:design-source-2:来源类型与准确引用:0'] });
    expect(readReadingPosition(storage, readingPositionKey(root, scope, returned))).toMatchObject({ top: 820, openDetails: ['id:design-sources', 'summary:design-source-2:来源类型与准确引用:0'] });
  });
  it('keeps inspector position and expanded tool details with the exact node, occurrence, attempt and pane', () => {
    const selected = readSelection(new URLSearchParams('view=business&tab=process&version=v1&case=c1&run=r1&node=author&occurrence=o1&runtimeAttempt=a1'));
    const key = nodeInspectorReadingKey(root, scope, selected, 'instructions')!;
    const values = new Map<string, string>();
    const storage = { getItem: (name: string) => values.get(name) || null, setItem: (name: string, value: string) => { values.set(name, value); } };
    writeReadingPosition(storage, key, { top: 640, openDetails: ['summary::原始输入参数 Schema:0'] });
    const reloaded = readSelection(new URLSearchParams(new URLSearchParams('view=business&tab=process&version=v1&case=c1&run=r1&node=author&occurrence=o1&runtimeAttempt=a1')));
    expect(readReadingPosition(storage, nodeInspectorReadingKey(root, scope, reloaded, 'instructions')!)).toMatchObject({ top: 640, openDetails: ['summary::原始输入参数 Schema:0'] });
    expect(nodeInspectorReadingKey(root, scope, { ...selected, runtimeAttempt: 'a2' }, 'instructions')).not.toBe(key);
    expect(nodeInspectorReadingKey(root, scope, { ...selected, node: 'research' }, 'instructions')).not.toBe(key);
    expect(nodeInspectorReadingKey(root, scope, selected, 'records')).not.toBe(key);
  });
});
