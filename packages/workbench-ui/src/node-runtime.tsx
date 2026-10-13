import { useInfiniteQuery } from '@tanstack/react-query';
import type { OccurrenceDetailDto, OccurrenceRuntimeDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { toolFieldSummaries } from './tool-schema.js';

type RuntimeEvent = OccurrenceRuntimeDto['events'][number];
type SavedCall = { callId: string; name: string | null; turn: number | null; call?: RuntimeEvent; outcome?: RuntimeEvent };

/** Only the saved producer identifies a model attempt; a publish context is not one. */
export function agentAttemptContexts(contexts: OccurrenceDetailDto['contexts']): OccurrenceDetailDto['contexts'] {
  return contexts.filter(context => context.producer === 'agent');
}

/** Pages may split a call and its outcome; only merge events from one exact attempt. */
export function pairSavedToolCalls(events: RuntimeEvent[]): SavedCall[] {
  const calls = new Map<string, SavedCall>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!event.callId || event.type === 'siwc.started') continue;
    const pair = calls.get(event.callId) || { callId: event.callId, name: event.name, turn: event.turn };
    if (event.type === 'siwc.tool_call') { pair.call = event; pair.name = event.name; pair.turn = event.turn; }
    else pair.outcome = event;
    calls.set(event.callId, pair);
  }
  return [...calls.values()].sort((a, b) => (a.call?.seq || a.outcome?.seq || 0) - (b.call?.seq || b.outcome?.seq || 0));
}

const readable = (value: unknown) => value === null || value === undefined ? '未记录' : typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '未记录';

function ToolCall({ pair, complete }: { pair: SavedCall; complete: boolean }) {
  const status = pair.outcome?.type === 'siwc.tool_result' ? '已保存返回结果' : pair.outcome?.type === 'siwc.tool_failed' ? '调用失败，结果未知' : pair.call ? complete ? '未保存返回结果' : '结果可能在后续页' : complete ? '未保存对应调用' : '调用可能在较早页';
  return <details className="sw-runtime-call"><summary><strong>{pair.name || '工具名称未记录'}</strong> · {status} · 轮次 {pair.turn ?? '未记录'}</summary>{pair.call && <><h5>调用参数</h5><pre>{readable(pair.call.arguments)}</pre><small>调用事件 {pair.call.id} · 序号 {pair.call.seq}{pair.call.argumentsHash ? ` · 参数 hash ${pair.call.argumentsHash}` : ''}{pair.call.bodyCoverage === 'truncated' ? ' · 内容截断' : ''}</small></>}{pair.outcome?.type === 'siwc.tool_result' && <><h5>返回内容</h5><pre>{readable(pair.outcome.output)}</pre></>}{pair.outcome?.type === 'siwc.tool_failed' && <p>保存的失败事件未记录可确认的错误正文；不能推断工具实际副作用。</p>}{pair.outcome && <small>结果事件 {pair.outcome.id} · 序号 {pair.outcome.seq}{pair.outcome.outputHash ? ` · 返回 hash ${pair.outcome.outputHash}` : ''}{pair.outcome.bodyCoverage === 'truncated' ? ' · 内容截断' : ''}</small>}<details><summary>准确调用身份</summary><code>{pair.callId}</code></details></details>;
}

export function NodeRuntime({ api, scope, runId, occurrenceId, contexts, selectedAttempt, onSelectAttempt }: { api: SpaceApi; scope: string; runId: string; occurrenceId: string; contexts: OccurrenceDetailDto['contexts']; selectedAttempt?: string; onSelectAttempt: (id: string) => void }) {
  const attempts = agentAttemptContexts(contexts);
  const selected = attempts.find(context => context.attemptId === selectedAttempt) || (attempts.length === 1 ? attempts[0] : undefined);
  const attemptId = selected?.attemptId || '';
  const unambiguous = !!attemptId && attempts.filter(context => context.attemptId === attemptId).length === 1;
  const runtime = useInfiniteQuery({ queryKey: ['space', scope, api.root, 'occurrence-runtime', runId, occurrenceId, attemptId], queryFn: ({ pageParam, signal }) => api.occurrenceRuntime(runId, occurrenceId, attemptId, pageParam, signal), initialPageParam: 0, getNextPageParam: page => page.hasMore ? page.nextCursor : undefined, enabled: !!attemptId && unambiguous, retry: false });
  if (!attempts.length) return <p className="sw-muted">此轮没有保存可辨认的 Agent 尝试上下文；程序发布上下文不会作为模型尝试读取。</p>;
  const pages = runtime.data?.pages || [];
  const identity = pages[0];
  const events = [...new Map(pages.flatMap(page => page.events).map(event => [event.id, event])).values()].sort((a, b) => a.seq - b.seq);
  const complete = !!pages.length && !pages.at(-1)?.hasMore;
  const starts = events.filter(event => event.type === 'siwc.started');
  const calls = pairSavedToolCalls(events);
  const noIdEvents = events.filter(event => event.type !== 'siwc.started' && !event.callId);
  const callCount = calls.filter(call => !!call.call).length;
  return <section className="sw-node-runtime"><label>准确 Agent 尝试 <select value={attemptId} onChange={event => onSelectAttempt(event.target.value)}><option value="" disabled>选择保存的 Agent 尝试</option>{attempts.map(context => <option value={context.attemptId} key={`${context.id}:${context.attemptId}`}>{context.attemptId} · 步骤 {context.stepRunId}</option>)}</select></label>{selectedAttempt && selectedAttempt !== attemptId && <p className="sw-muted">URL 指定的尝试不属于此轮保存的 Agent 上下文；请选择准确尝试。</p>}{attempts.length > 1 && !selected && <p className="sw-muted">此轮有多个真实 Agent 尝试，请明确选择；不会默认读取第一项。</p>}{attemptId && !unambiguous && <p role="alert">此轮同一 Agent 尝试关联多份上下文，无法确定准确阅读对象；请核对保存记录。</p>}
    {runtime.error && <div className="sw-notice" role="alert"><p>运行时记录不可读：{runtime.error instanceof Error ? runtime.error.message : '读取失败'}</p><button onClick={() => void runtime.refetch()}>重试</button></div>}
    {runtime.isPending && !runtime.error && unambiguous && <p className="sw-muted">正在读取此尝试的保存事件…</p>}
    {identity && <><p className="sw-muted">此处只读取已保存、已脱敏的运行事件；不代表完整模型思考，也不包含外层设计会话。</p><div className="sw-runtime-layers"><article><h5>① 准确版本冻结 Prompt</h5><details><summary>{identity.frozenPrompt ? `阅读本版冻结文本${identity.frozenPromptCoverage === 'truncated' ? '（有界截断）' : ''}` : '冻结文本未记录'}</summary><pre>{identity.frozenPrompt || '此准确版本未保存该节点冻结 Prompt。'}</pre></details></article><article><h5>② 本次上下文指令</h5><details><summary>阅读实际执行文本{identity.contextInstructionsCoverage === 'truncated' ? '（有界截断）' : ''}</summary><pre>{identity.contextInstructions || '本次上下文指令正文未记录'}</pre></details></article><article><h5>③ 提供给模型的指令</h5>{starts.length ? starts.map(start => <details key={start.id}><summary>已保存的供应商请求 · 事件 {start.seq}</summary><pre>{start.providerInstructions || '事件未记录供应商指令正文'}</pre><p>供应商模型：{start.providerModel || '未记录'}</p></details>) : <p className="sw-muted">{complete ? '四类已保存事件已读完，但没有 siwc.started 记录；不能推断模型没有收到指令。' : '当前已读取页未见 siwc.started；可继续加载后续页核对。'}</p>}</article></div>
      <details><summary>本次有效配置 · 安全投影</summary><pre>{readable(identity.effectiveConfig)}</pre></details>
      <h5>实际提供给模型的工具</h5>{starts.length ? starts.map(start => <section key={`${start.id}:tools`}>{start.providerToolProfileHash && <details><summary>工具配置身份</summary><code>{start.providerToolProfileHash}</code></details>}{start.toolDefinitions === null ? <p className="sw-muted">事件未保存可读的动态工具定义；不能推断工具未提供。</p> : start.toolDefinitions.length ? start.toolDefinitions.map(tool => <article className="sw-runtime-tool" key={`${start.id}:${tool.name}`}><strong>{tool.name}</strong><p>{tool.description}</p>{toolFieldSummaries(tool.parameters).map(field => <p className="sw-tool-field" key={field.name}><strong>{field.name}</strong> · {field.type} · {field.required ? '必需' : '可选'}{field.choices.length ? ` · 可选值 ${field.choices.join('、')}${field.moreChoices ? '…' : ''}` : ''}</p>)}<details><summary>原始输入参数 Schema</summary><pre>{readable(tool.parameters)}</pre></details><p>输出合同：{tool.outputSchemaCoverage === 'not-recorded' ? '运行事件未记录' : '未核对'}</p></article>) : <p className="sw-muted">此请求保存的动态工具列表为空。</p>}</section>) : <p className="sw-muted">尚未读到工具提供事件；调用记录与工具提供记录分别核对。</p>}
      <h5>实际工具调用</h5><p>{complete ? `四类已保存事件已分页读完；其中可辨认的调用 ${callCount} 次。提供工具不等于实际调用，保存事件也不保证覆盖所有行为。` : `已读取部分事件页；目前看到 ${callCount} 条调用，最终数量尚未核对。`}</p>{calls.map(pair => <ToolCall key={pair.callId} pair={pair} complete={complete} />)}{noIdEvents.length > 0 && <details><summary>未带调用 ID 的保存事件 · {noIdEvents.length}</summary>{noIdEvents.map(event => <p key={event.id}>{event.seq} · {event.type} · 事件 {event.id}</p>)}</details>}{!calls.length && <p className="sw-muted">{complete ? '这四类已保存事件中没有可辨认的工具调用；不能据此推断没有向模型提供工具或没有发生其他行为。' : '当前已读取页尚无工具调用；继续加载可核对后续事件。'}</p>}
      {pages.some(page => page.bodyCoverage === 'truncated') && <p className="sw-muted">部分保存事件正文已做有界截断；请按覆盖标记核对。</p>}{runtime.hasNextPage && <button className="sw-more" disabled={runtime.isFetchingNextPage} onClick={() => void runtime.fetchNextPage()}>{runtime.isFetchingNextPage ? '正在读取…' : '继续读取此尝试事件'}</button>}
      <details><summary>准确尝试与会话身份</summary><code>Run {identity.runId} · 轮次 {identity.occurrenceId} · 步骤 {identity.stepRunId} · 尝试 {identity.attemptId} · 会话 {identity.sessionId} · 上下文 {identity.contextId} · 版本 {identity.versionId}</code></details>
    </>}
  </section>;
}
