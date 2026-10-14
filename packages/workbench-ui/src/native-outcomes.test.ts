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
const run = { id: 'child-run', caseId: 'case-1', versionId: 'version-1', entrypoint: 'post',
  executionMode: 'external-host' } as RunDetailDto;
const emptyProcess = { coverage: 'observed', occurrences: [] } as unknown as ProcessDto;
const asset = (id: string, title: string, runId = run.id) =>
  ({ id, title, runId, caseId: run.caseId, versionId: run.versionId, state: 'candidate', sourceKind: 'external-artifact' }) as AssetSummaryDto;

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

  it('shows an exact-run import separately without counting it as a produced outcome', () => {
    const client = new QueryClient();
    published(client, run, [{ ...asset('failure-memo', '外部失败说明'), sourceKind: 'import' },
      { ...asset('other-case', '其他 Case 的导入材料'), caseId: 'case-other', sourceKind: 'import' },
      { ...asset('other-version', '其他方法的导入材料'), versionId: 'version-other', sourceKind: 'import' }]);
    const html = outcome(client, run, emptyProcess);
    expect(html).toContain('已发布成果 · 0 项');
    expect(html).toContain('关联导入材料 / 历史草稿 · 1 项');
    expect(html).toContain('外部失败说明');
    expect(html).not.toContain('其他 Case 的导入材料');
    expect(html).not.toContain('其他方法的导入材料');
  });

  it('links exact child-run assets from the root without treating them as root-produced', () => {
    const client = new QueryClient();
    const root = { ...run, id: 'root-run', versionId: 'root-version' } as RunDetailDto;
    const child = { ...run, id: 'builder-run', versionId: 'builder-version' } as RunDetailDto;
    published(client, root, []);
    client.setQueryData(['space', scope, api.root, 'native-child-index', root.id], { children: [
      { runId: child.id, workflowId: 'post.build', state: 'completed', binding: 'bound' },
      { runId: 'pending-run', workflowId: 'post.review', state: 'running', binding: 'pending' },
    ] });
    client.setQueryData(['space', scope, api.root, 'native-child-run', child.id], child);
    published(client, child, [
      { ...asset('final-candidate', '最终候选稿', child.id), versionId: child.versionId, state: 'revised-unverified' },
      { ...asset('sibling-asset', '兄弟运行的资产', 'sibling-run'), versionId: child.versionId },
      { ...asset('foreign-case', '其他案例的资产', child.id), caseId: 'another-case', versionId: child.versionId },
    ]);
    const html = outcome(client, root, emptyProcess);
    expect(html).toContain('已发布成果 · 0 项');
    expect(html).toContain('此完整任务的子流程成果');
    expect(html).toContain('最终候选稿');
    expect(html).toContain('修订未验证 · 只读');
    expect(html).not.toContain('兄弟运行的资产');
    expect(html).not.toContain('其他案例的资产');
    expect(html).not.toContain('pending-run');
  });

  it('rejects a child whose exact Case binding differs from the root', () => {
    const client = new QueryClient();
    const root = { ...run, id: 'root-run' } as RunDetailDto;
    published(client, root, []);
    client.setQueryData(['space', scope, api.root, 'native-child-index', root.id], { children: [
      { runId: 'foreign-child', workflowId: 'post.build', state: 'completed', binding: 'bound' },
    ] });
    client.setQueryData(['space', scope, api.root, 'native-child-run', 'foreign-child'], { ...run, id: 'foreign-child', caseId: 'other-case' });
    published(client, { ...run, id: 'foreign-child' }, [asset('foreign', '不可读的外部成果', 'foreign-child')]);
    const html = outcome(client, root, emptyProcess);
    expect(html).toContain('子运行与本 Case 的身份不一致');
    expect(html).not.toContain('不可读的外部成果');
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
