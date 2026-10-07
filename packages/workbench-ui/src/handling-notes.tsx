import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetSummaryDto, HandlingNoteDto, HandlingNoteRequestDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi, SpaceApiError } from './api.js';

const recommendationLabel: Record<HandlingNoteDto['recommendation'], string> = { needs_revision: '建议修改', pending_human_review: '等待人工审阅', defer: '暂缓处理' };
const newKey = () => crypto.randomUUID();

export function HandlingNotes({ api, scope, asset, referencedAssets, csrfToken, writable, chooseAsset }: { api: SpaceApi; scope: string; asset: AssetSummaryDto; referencedAssets: AssetSummaryDto[]; csrfToken?: string | null; writable: boolean; chooseAsset: (id: string) => void }) {
  const client = useQueryClient();
  const queryKey = ['space', scope, api.root, 'handling-notes', asset.runId, asset.id];
  const notes = useQuery({ queryKey, queryFn: ({ signal }) => api.handlingNotes(asset.runId!, asset.id, signal), enabled: !!asset.runId && asset.sourceKind === 'node', retry: false, retryOnMount: false });
  const run = useQuery({ queryKey: ['space', scope, api.root, 'handling-run', asset.runId], queryFn: ({ signal }) => api.run(asset.runId!, signal), enabled: !!asset.runId && asset.sourceKind === 'node' && !!notes.data, retry: false });
  const [open, setOpen] = useState(false);
  const [author, setAuthor] = useState('');
  const [threadId, setThreadId] = useState('');
  const [answers, setAnswers] = useState({ good: '', bad: '', improvement: '', unresolved: '' });
  const [recommendation, setRecommendation] = useState<HandlingNoteRequestDto['recommendation']>('needs_revision');
  const [nextStep, setNextStep] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newKey());
  if (!asset.runId || asset.sourceKind !== 'node') return null;
  if (notes.error instanceof SpaceApiError && notes.error.status === 404) return null;
  if (notes.error) return <section className="sw-handling" role="alert"><h4>处理建议暂不可读</h4><p>{notes.error instanceof Error ? notes.error.message : '读取失败。'}</p><button onClick={() => void notes.refetch()}>重试</button></section>;
  if (!notes.data) return <p className="sw-muted sw-handling-status" role="status">正在确认此资产的处理建议入口…</p>;
  if (run.error) return <section className="sw-handling" role="alert"><h4>运行状态暂不可读</h4><p>{run.error instanceof Error ? run.error.message : '读取失败。'}</p><button onClick={() => void run.refetch()}>重试</button></section>;
  if (!run.data) return <p className="sw-muted sw-handling-status" role="status">正在读取这份稿件的运行状态…</p>;
  const processDraft = run.data.state === 'failed' && run.data.primaryAssetId === null;
  const change = () => { key.current = newKey(); setError(''); };
  const save = async () => {
    if (!csrfToken || !asset.runId || busy) return;
    setBusy(true); setError('');
    try {
      await api.addHandlingNote(asset.runId, asset.id, { key: key.current, author: { kind: 'external-agent', name: author.trim(), threadId: threadId.trim() }, answers, recommendation, nextStep: nextStep.trim(), referencedAssetIds: references }, csrfToken);
      await client.invalidateQueries({ queryKey });
      setOpen(false); setAnswers({ good: '', bad: '', improvement: '', unresolved: '' }); setNextStep(''); setReferences([]); key.current = newKey();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <section className="sw-handling"><h4>外部 Agent 处理建议</h4>{processDraft && <p className="sw-business-hint">这份稿是失败运行中保存的过程稿；运行仍为失败，尚未形成最终稿，也未被接受。</p>}<p className="sw-muted">这些建议由外部会话声明来源，尚未经 Space 节点会话核验；保存建议不会接受稿件或执行下一步。</p>
    {notes.data?.truncated && <p className="sw-business-hint" role="status">仅显示前 100 条处理建议；此列表未包含全部历史。</p>}
    {notes.data?.items.map(note => <article key={note.id}><strong>{recommendationLabel[note.recommendation]}</strong><small>{note.author.name} · 外部 Agent 会话 {note.author.threadId} · 来源声明未核验 · {note.createdAt}</small><p><b>有效之处：</b>{note.answers.good || '未填写'}</p><p><b>问题：</b>{note.answers.bad || '未填写'}</p><p><b>改进：</b>{note.answers.improvement || '未填写'}</p><p><b>未解决：</b>{note.answers.unresolved || '未填写'}</p><p><b>建议下一步：</b>{note.nextStep}</p>{note.referencedAssetIds.length > 0 && <div>引用意见：{note.referencedAssetIds.map(id => <button key={id} onClick={() => chooseAsset(id)}>{referencedAssets.find(item => item.id === id)?.title || id}</button>)}</div>}</article>)}
    {writable && <><button onClick={() => setOpen(!open)}>{open ? '收起建议表单' : '记录外部 Agent 建议'}</button>{open && <form onSubmit={event => { event.preventDefault(); void save(); }}><label>声明作者<input required value={author} onChange={event => { setAuthor(event.target.value); change(); }} placeholder="Agent 名称" /></label><label>外部会话 ID<input required value={threadId} onChange={event => { setThreadId(event.target.value); change(); }} /></label>{([['good', '有效之处'], ['bad', '问题'], ['improvement', '改进'], ['unresolved', '未解决']] as const).map(([field, title]) => <label key={field}>{title}<textarea rows={3} value={answers[field]} onChange={event => { setAnswers(current => ({ ...current, [field]: event.target.value })); change(); }} /></label>)}<label>处理建议<select value={recommendation} onChange={event => { setRecommendation(event.target.value as HandlingNoteRequestDto['recommendation']); change(); }}>{Object.entries(recommendationLabel).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label>建议下一步<textarea required rows={3} value={nextStep} onChange={event => { setNextStep(event.target.value); change(); }} /></label>{referencedAssets.length > 0 && <fieldset><legend>引用本稿对应意见</legend>{referencedAssets.map(item => <label key={item.id}><input type="checkbox" checked={references.includes(item.id)} onChange={event => { setReferences(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); change(); }} />{item.title}</label>)}</fieldset>}<button type="submit" disabled={busy || !csrfToken}>{busy ? '正在保存…' : '保存建议'}</button>{error && <p role="alert" className="sw-business-error">{error}</p>}</form>}</>}
  </section>;
}
