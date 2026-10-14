import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { RunSummaryDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';

/** Native ledger evidence remains separate from saved Space sessions and published answers. */
export function NativeRunEvents({ api, scope, run, onRun }: { api: SpaceApi; scope: string; run: RunSummaryDto; onRun: (run: RunSummaryDto) => void }) {
  const [open, setOpen] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const readable = run.executionMode === 'external-host' || run.executionMode === 'imported';
  const query = useInfiniteQuery({
    queryKey: ['space', scope, api.root, 'native-run-events', run.id],
    queryFn: ({ pageParam, signal }) => api.nativeRunEvents(run.id, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: page => page.hasMore ? page.nextCursor ?? undefined : undefined,
    enabled: readable && open,
    retry: false,
  });
  if (!readable) return null;
  const pages = query.data?.pages ?? [];
  const children = pages[0]?.children ?? [];
  const openChild = async (id: string) => {
    setNavigationError('');
    try { onRun(await api.run(id)); }
    catch { setNavigationError('暂时无法打开这条子流程，请重试。'); }
  };
  return <details className="sw-native-events" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>原生执行记录与子流程</summary>
    {open && <>
      <p>按真实步骤与尝试读取原生账本摘要。工具调用、传输失败和文本响应分别保留；文本存在不代表业务完成或质量通过。</p>
      {query.isPending && <p>正在读取保存记录…</p>}
      {query.error && <p role="alert">暂时无法读取原生记录。<button onClick={() => void query.refetch()}>重试</button></p>}
      {children.length > 0 && <section><h4>实际子流程与成果</h4><p>成果保留在真实生产子流程中。</p>{children.map(child => <p key={child.runId}>{child.binding === 'bound' ? <button className="sw-link" onClick={() => void openChild(child.runId)}>{child.workflowId} · {child.state} · {child.runId.slice(0, 8)}</button> : <span>{child.workflowId} · 正在关联读取入口</span>}</p>)}</section>}
      {navigationError && <p role="alert">{navigationError}</p>}
      {pages.flatMap(page => page.items).map(event => <details key={`${event.seq}:${event.id}`}>
        <summary>{event.seq} · {event.type}{event.turn !== null ? ` · 第 ${event.turn} 轮` : ''}{event.httpStatus !== null ? ` · HTTP ${event.httpStatus}` : ''}</summary>
        <p>{event.timestamp}</p>
        {event.transport && <p>传输：{event.transport.phase || '阶段未记录'} · {event.transport.causeCode || event.transport.errorName || '原因未记录'}{event.transport.retrying !== null ? event.transport.retrying ? ' · 当时允许重试' : ' · 当时不再重试' : ''}</p>}
        {event.response && <><p>{event.response.hasFinalText ? '保存了无工具调用的文本响应；业务结果另查。' : event.response.hasText ? '保存了文本和其他响应项。' : '本条没有最终文本。'}</p>{event.response.output.map((item, index) => <p key={index}>{item.type}{item.name ? ` · ${item.name}` : ''}</p>)}</>}
        {event.tool && <p>工具：{event.tool.name || '名称未记录'}{event.tool.status ? ` · ${event.tool.status}` : ''}</p>}
        <small>事件 {event.id} · 步骤 {event.stepRunId || '未关联'} · 尝试 {event.attemptId || '未关联'}</small>
      </details>)}
      {query.data && !pages.some(page => page.items.length) && <p>此运行尚无可读的原生事件。</p>}
      {query.hasNextPage && <button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在读取…' : '加载更多原生事件'}</button>}
    </>}
  </details>;
}
