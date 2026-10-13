import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { CaseFrozenInputsDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';

type Manifest = CaseFrozenInputsDto['manifests'][number];

function shortManifestId(id: string, manifests: readonly Manifest[]): string {
  let length = Math.min(8, id.length);
  while (length < id.length && manifests.some(item => item.id !== id && item.id.startsWith(id.slice(0, length)))) length += 1;
  return length < id.length ? `${id.slice(0, length)}…` : id;
}

export function chosenCaseManifest(requestedId: string | null, manifests: readonly Manifest[], hasMore: boolean): Manifest | undefined {
  if (requestedId) return manifests.find(item => item.id === requestedId);
  return !hasMore && manifests.length === 1 ? manifests[0] : undefined;
}

/** Case-owned input history has no saved chronology or method-version association. */
export function CaseFrozenInputs({ api, scope, caseId, runCount, onAsset }: { api: SpaceApi; scope: string; caseId: string; runCount?: number; onAsset: (assetVersionId: string) => void }) {
  const [params, setParams] = useSearchParams();
  const requestedId = params.get('caseManifest');
  const history = useInfiniteQuery({
    queryKey: ['space', scope, api.root, 'case-frozen-inputs', caseId],
    queryFn: ({ pageParam, signal }) => api.caseFrozenInputs(caseId, pageParam ? { after: pageParam } : {}, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor || undefined,
    retry: false,
    retryOnMount: false,
  });
  const listed = [...new Map((history.data?.pages.flatMap(page => page.manifests) || []).map(item => [item.id, item])).values()];
  const exact = useQuery({
    queryKey: ['space', scope, api.root, 'case-frozen-input', caseId, requestedId],
    queryFn: ({ signal }) => api.caseFrozenInputs(caseId, { manifestId: requestedId! }, signal),
    enabled: !!requestedId && !listed.some(item => item.id === requestedId),
    retry: false,
    retryOnMount: false,
  });
  const hasMore = history.hasNextPage || !!history.data?.pages.at(-1)?.hasMore;
  const selected = chosenCaseManifest(requestedId, [...listed, ...(exact.data?.manifests || [])], hasMore);
  const known = [...new Map([...listed, ...(selected ? [selected] : [])].map(item => [item.id, item])).values()];
  const choose = (id: string | null) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (id) next.set('caseManifest', id); else next.delete('caseManifest');
    return next;
  });
  const loading = !selected && ((history.isPending && !history.error) || (!!requestedId && exact.isPending && !exact.error));
  const failure = history.error || (requestedId && exact.error);
  return <section className="sw-case-frozen-inputs" aria-label="案例已冻结输入">
    <h3>案例冻结输入</h3>
    {selected ? <p className="sw-status">{runCount === 0 ? '已冻结输入、尚未运行。这些是此案例已保存的输入。' : '已冻结输入，当前未选择运行。这些是此案例已保存的输入。'}</p>
      : loading ? <p className="sw-muted">正在核对案例是否已有冻结输入…</p>
      : failure ? <p role="alert">冻结输入读取失败：{failure instanceof Error ? failure.message : '请重试。'}。不能据此判断案例没有输入。</p>
      : listed.length || requestedId ? <p className="sw-muted">{requestedId ? '指定清单不属于此案例；原选择仍保留在地址中。' : '此案例有多份冻结输入清单。请选择准确清单。'}</p>
      : <p className="sw-muted">此案例未保存可读取的冻结输入清单。</p>}
    {(listed.length > 1 || (requestedId && listed.length > 0)) && <div className="sw-case-manifest-list">{listed.map(item => <button key={item.id} className={`sw-row${selected?.id === item.id ? ' selected' : ''}`} onClick={() => choose(item.id)}><span><strong>输入清单 {shortManifestId(item.id, known)}</strong><small>{item.slots.length} 项输入 · {item.slots.map(slot => slot.asset.title).join('、') || '无输入资产'}</small></span><span aria-hidden="true">›</span></button>)}</div>}
    {history.hasNextPage && <button className="sw-more" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? '正在读取更多清单…' : '加载更多清单'}</button>}
    {history.error && <button className="sw-link" onClick={() => void history.refetch()}>{listed.length ? '清单列表读取不完整，重试' : '重新读取案例冻结输入'}</button>}
    {requestedId && exact.error && <button className="sw-link" onClick={() => void exact.refetch()}>重新读取指定清单</button>}
    {selected && <div className="sw-case-manifest-detail"><h4>已保存的输入</h4><p className="sw-muted">选择一项，阅读已保存的完整内容。</p>{selected.slots.length ? selected.slots.map(slot => <button className="sw-row" key={`${selected.id}:${slot.slot}`} onClick={() => onAsset(slot.asset.id)}><span><strong>{slot.asset.title}</strong><small>输入项：{slot.slot}</small></span><span aria-hidden="true">›</span></button>) : <p className="sw-muted">此清单没有保存输入项。</p>}</div>}
    {known.length > 0 && <details className="sw-case-manifest-provenance"><summary>准确冻结清单与内容校验值</summary><p>这些清单属于此案例；保存记录没有新旧时间顺序，也不直接关联某个方法版本。</p>{known.map(item => <section key={item.id}><h4>清单 {item.id}</h4><dl><dt>清单 hash</dt><dd>{item.hash}</dd>{item.slots.map(slot => <SlotProvenance key={`${item.id}:${slot.slot}`} slot={slot} />)}</dl></section>)}</details>}
  </section>;
}

function SlotProvenance({ slot }: { slot: Manifest['slots'][number] }) {
  return <><dt>{slot.slot} · 资产版本</dt><dd>{slot.asset.id}</dd><dt>资产 Schema</dt><dd>{slot.asset.schema.namespace} · {slot.asset.schema.revision} · {slot.asset.schema.hash}</dd><dt>内容 hash</dt><dd>{slot.payloadHash}</dd><dt>读取路径</dt><dd>{slot.readingUrl}</dd></>;
}
