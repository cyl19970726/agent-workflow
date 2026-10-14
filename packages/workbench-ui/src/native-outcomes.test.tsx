import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AssetSummaryDto, ProcessDto, RunDetailDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { NativeRunEvents } from './native-run-events.js';
import { CaseRunOutcome } from './workbench.js';

const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
const scope = 'subject:reader';
const run = { id: 'child-run', caseId: 'case-1', versionId: 'version-1',
  executionMode: 'external-host' } as RunDetailDto;
const emptyProcess = { coverage: 'observed', occurrences: [] } as unknown as ProcessDto;
const asset = (id: string, title: string, runId = run.id) =>
  ({ id, title, runId, sourceKind: 'external-artifact' }) as AssetSummaryDto;

function render(client: QueryClient, node: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client }, node)).replaceAll('<!-- -->', '');
}

function outcome(client: QueryClient, selectedRun: RunDetailDto, process: ProcessDto) {
  return render(client, createElement(CaseRunOutcome, {
    api, scope, run: selectedRun, process, error: null, retry: () => {}, onAsset: () => {}, onRecords: () => {},
  }));
}

function published(client: QueryClient, selectedRun: RunDetailDto, items: AssetSummaryDto[]) {
  client.setQueryData(['space', scope, api.root, 'run-published-assets', selectedRun.id], {
    pages: [{ items, nextCursor: null }], pageParams: [undefined],
  });
}

describe('native run outcome reading', () => {
  it.each(['external-host', 'imported'] as const)(
    'shows a %s child run published asset even without Space contexts or process outputs', executionMode => {
      const client = new QueryClient();
      const selectedRun = { ...run, executionMode } as RunDetailDto;
      published(client, selectedRun, [asset('same-run', '真实子流程成果'), asset('foreign', '其他运行成果', 'other-run')]);
      const html = outcome(client, selectedRun, emptyProcess);
      expect(html).toContain('已发布成果 · 1 项');
      expect(html).toContain('真实子流程成果');
      expect(html).not.toContain('其他运行成果');
      expect(html).not.toContain('此运行没有保存已发布的成果资产');
    });

  it('deduplicates a published asset already represented in process outputs by exact ID', () => {
    const client = new QueryClient();
    const same = asset('same-run', '真实子流程成果');
    published(client, run, [same]);
    const process = { coverage: 'observed', occurrences: [{ state: 'succeeded', outputs: [same] }] } as unknown as ProcessDto;
    const html = outcome(client, run, process);
    expect(html).toContain('已发布成果 · 1 项');
    expect(html.match(/真实子流程成果/g)).toHaveLength(1);
  });

  it('keeps native ledger records separate from ordinary harness sessions', () => {
    const client = new QueryClient();
    const ordinary = render(client, createElement(NativeRunEvents, {
      api, scope, run: { ...run, executionMode: 'case' }, onRun: () => {},
    }));
    expect(ordinary).toBe('');
    for (const executionMode of ['external-host', 'imported'] as const) {
      const native = render(client, createElement(NativeRunEvents, {
        api, scope, run: { ...run, executionMode }, onRun: () => {},
      }));
      expect(native).toContain('原生执行记录与子流程');
      expect(native).not.toContain('会话事件');
    }
  });
});
