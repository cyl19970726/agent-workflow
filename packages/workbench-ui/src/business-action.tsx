import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessFormDto, BusinessPreparationDto, BusinessCommandReceiptDto, RunSummaryDto, VersionSummaryDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi, SpaceApiError } from './api.js';

type Material = { id: string; title: string; source: string; text: string };
const uuid = () => crypto.randomUUID();
const asText = (value: unknown) => typeof value === 'string' ? value : '';
const asLines = (value: unknown) => Array.isArray(value) ? value.map(asText).join('\n') : asText(value);
const asMaterials = (value: unknown): Material[] => Array.isArray(value) ? value.map((item) => {
  const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  return { id: asText(row.id) || uuid(), title: asText(row.title), source: asText(row.source), text: asText(row.text) };
}) : [{ id: uuid(), title: '', source: '', text: '' }];
const initialValues = (form: BusinessFormDto): Record<string, unknown> => Object.fromEntries(form.fields.map(field => [field.key, field.kind === 'materials' ? asMaterials(field.defaultValue) : field.kind === 'lines' ? asLines(field.defaultValue) : asText(field.defaultValue)]));
export const businessValues = (form: BusinessFormDto, values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(form.fields.map(field => [field.key, field.kind === 'lines' ? asText(values[field.key]).split(/\r?\n/).map(line => line.trim()).filter(Boolean) : field.kind === 'materials' ? (Array.isArray(values[field.key]) ? values[field.key] as Material[] : []).map(({ id, title, source, text }) => ({ id, title: asText(title).trim(), source: asText(source).trim(), text: asText(text).trim() })).filter(item => item.title || item.source || item.text) : asText(values[field.key]).trim()]));

function Field({ field, value, onChange }: { field: BusinessFormDto['fields'][number]; value: unknown; onChange: (value: unknown) => void }) {
  if (field.kind === 'materials') return <fieldset className="sw-business-materials"><legend>{field.label}{field.required ? ' *' : ''}</legend>{field.help && <p>{field.help}</p>}{asMaterials(value).map((item, index, rows) => <div className="sw-business-material" key={item.id}><strong>材料 {index + 1}</strong><label>标题<input value={item.title} onChange={event => onChange(rows.map(row => row.id === item.id ? { ...row, title: event.target.value } : row))} /></label><label>来源<input value={item.source} onChange={event => onChange(rows.map(row => row.id === item.id ? { ...row, source: event.target.value } : row))} /></label><label>正文<textarea rows={5} value={item.text} onChange={event => onChange(rows.map(row => row.id === item.id ? { ...row, text: event.target.value } : row))} /></label><button type="button" disabled={rows.length === 1} onClick={() => onChange(rows.filter(row => row.id !== item.id))}>移除材料</button></div>)}<button type="button" onClick={() => onChange([...asMaterials(value), { id: uuid(), title: '', source: '', text: '' }])}>添加材料</button></fieldset>;
  return <label className="sw-business-field"><span>{field.label}{field.required ? ' *' : ''}</span>{field.help && <small>{field.help}</small>}{field.kind === 'text' ? <input required={field.required} value={asText(value)} onChange={event => onChange(event.target.value)} /> : <textarea required={field.required} rows={field.kind === 'lines' ? 4 : 6} value={asText(value)} onChange={event => onChange(event.target.value)} placeholder={field.kind === 'lines' ? '每行一项' : undefined} />}</label>;
}

function MethodChoice({ versions, versionId, versionLabel, purpose, purposeError, adoptedVersionId, onSelect }: { versions: VersionSummaryDto[]; versionId?: string; versionLabel?: string; purpose?: string | null; purposeError: boolean; adoptedVersionId?: string | null; onSelect: (id: string) => void }) {
  const selected = versions.find(item => item.id === versionId);
  return <section className="sw-business-method"><label>本次方法版本 <select aria-label="选择本次业务的方法版本" value={versionId || ''} onChange={event => onSelect(event.target.value)}><option value="">选择方法</option>{versionId && !selected && <option value={versionId}>{versionLabel || '当前方法版本'}</option>}{versions.map(item => <option key={item.id} value={item.id}>{item.label}{item.id === adoptedVersionId ? ' · 已采用' : ''}{item.availability.state === 'available' ? ' · 可执行' : item.availability.state === 'unavailable' ? ' · 当前不可执行' : ' · 可执行性未知'}</option>)}</select></label><p><strong>{versionLabel || selected?.label || '尚未选择方法'}</strong>{!versionId ? '' : purpose ? ` · 用途：${purpose}` : purposeError ? ' · 用途读取失败' : purpose === null ? ' · 用途未记录' : ' · 用途读取中'}</p>{selected?.changeReason && <p>版本变更：{selected.changeReason}</p>}<small>{selected ? selected.availability.state === 'available' ? '当前可执行' : selected.availability.reason || (selected.availability.state === 'unknown' ? '可执行性未知' : '当前不可执行') : versionId ? '此版本未在已加载的方法列表中' : '选择一个方法版本查看状态'}{versionId === adoptedVersionId ? ' · 当前采用' : versionId ? ' · 本次选择，不改变当前采用版本' : ''}</small></section>;
}

function Form({ api, scope, versionId, versionLabel, versionPurpose, versionPurposeError, versions, adoptedVersionId, onVersionSelect, csrfToken, onPrepared }: { api: SpaceApi; scope: string; versionId?: string; versionLabel?: string; versionPurpose?: string | null; versionPurposeError: boolean; versions: VersionSummaryDto[]; adoptedVersionId?: string | null; onVersionSelect: (id: string) => void; csrfToken?: string | null; onPrepared: (prepared: BusinessPreparationDto) => void }) {
  const form = useQuery({ queryKey: ['space', scope, api.root, 'business-form'], queryFn: ({ signal }) => api.businessForm(signal) });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialized, setInitialized] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(uuid());
  useEffect(() => { if (form.data && !initialized) { setValues(initialValues(form.data)); setInitialized(true); } }, [form.data, initialized]);
  useEffect(() => { setPreview(false); key.current = uuid(); }, [versionId]);
  if (form.isPending) return <p>正在读取新建业务要求…</p>;
  if (form.error || !form.data) return <div role="alert">{form.error instanceof Error ? form.error.message : '无法读取业务表单。'} <button onClick={() => void form.refetch()}>重试</button></div>;
  if (!initialized) return <p className="sw-business-action">正在准备业务表单…</p>;
  const change = (field: string, value: unknown) => { setValues(previous => ({ ...previous, [field]: value })); setPreview(false); setError(''); key.current = uuid(); };
  const preparedValues = businessValues(form.data, values);
  const missing = form.data.fields.filter(field => field.required && (field.kind === 'materials' ? !(preparedValues[field.key] as Material[]).length || (preparedValues[field.key] as Material[]).some(item => !item.title || !item.source || !item.text) : field.kind === 'lines' ? !(preparedValues[field.key] as string[]).length : !asText(preparedValues[field.key])));
  const save = async () => {
    if (!versionId || !csrfToken || busy) return;
    setBusy(true); setError('');
    try { onPrepared(await api.prepareBusiness(versionId, preparedValues, key.current, csrfToken)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <div className="sw-business-action"><h3>{form.data.title}</h3><p>{form.data.description}</p><MethodChoice versions={versions} versionId={versionId} versionLabel={versionLabel} purpose={versionPurpose} purposeError={versionPurposeError} adoptedVersionId={adoptedVersionId} onSelect={onVersionSelect} /><form onSubmit={event => { event.preventDefault(); if (!missing.length) setPreview(true); }}>
    {form.data.fields.map(field => <Field key={field.key} field={field} value={values[field.key]} onChange={value => change(field.key, value)} />)}
    {form.data.conditions.length > 0 && <section><h4>运行条件</h4><ul>{form.data.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></section>}
    {missing.length > 0 && <p className="sw-business-hint">请填写：{missing.map(field => field.label).join('、')}</p>}
    {!preview ? <button type="submit" disabled={missing.length > 0 || !versionId}>预览要求与材料</button> : <section className="sw-business-preview"><h4>确认后冻结输入</h4><p>保存将创建业务并冻结以下要求和材料；运行仍需单独开始。</p>{form.data.fields.map(field => <div key={field.key}><strong>{field.label}</strong>{field.kind === 'materials' ? (preparedValues[field.key] as Material[]).map((item, index) => <article key={item.id}><strong>{item.title || `材料 ${index + 1}`}</strong><small>来源：{item.source || '未填写'}</small><p>{item.text}</p></article>) : field.kind === 'lines' ? <ul>{(preparedValues[field.key] as string[]).map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>{asText(preparedValues[field.key]) || '未填写'}</p>}</div>)}<button type="button" onClick={() => setPreview(false)}>返回修改</button> <button type="button" disabled={busy || !csrfToken} onClick={() => void save()}>{busy ? '正在保存…' : '保存并冻结输入'}</button></section>}
    {error && <p role="alert" className="sw-business-error">{error}</p>}
  </form></div>;
}

function Preparation({ api, scope, caseId, csrfToken, onRun, onAsset }: { api: SpaceApi; scope: string; caseId: string; csrfToken?: string | null; onRun: (run: RunSummaryDto) => void; onAsset: (id: string) => void }) {
  const client = useQueryClient();
  const queryKey = ['space', scope, api.root, 'preparation', caseId];
  const prepared = useQuery({ queryKey, queryFn: ({ signal }) => api.preparation(caseId, signal), retry: false });
  const method = useQuery({ queryKey: ['space', scope, api.root, 'version', prepared.data?.versionId], queryFn: ({ signal }) => api.version(prepared.data!.versionId, signal), enabled: !!prepared.data?.versionId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<BusinessCommandReceiptDto>();
  const startKey = useRef(uuid());
  if (prepared.isPending) return <p className="sw-business-action">正在读取冻结输入…</p>;
  if (prepared.error instanceof SpaceApiError && prepared.error.status === 404) return <p className="sw-business-action sw-muted">本案例没有普通业务准备记录。可查看已有运行，或新建业务。</p>;
  if (prepared.error) return <div className="sw-business-action" role="alert"><p>{prepared.error instanceof Error ? prepared.error.message : '无法读取准备记录。'}</p><button onClick={() => void prepared.refetch()}>重试</button></div>;
  const value = prepared.data!;
  const start = async () => {
    if (!csrfToken || busy) return;
    setBusy(true); setError('');
    try {
      const next = await api.startBusiness(value.caseId, value.versionId, value.inputManifestId, startKey.current, csrfToken);
      setReceipt(next);
      await client.invalidateQueries({ queryKey });
      await client.invalidateQueries({ queryKey: ['space', scope] });
      onRun({ id: next.runId, caseId: next.caseId, versionId: next.versionId } as RunSummaryDto);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '开始失败，请重试。'); }
    finally { setBusy(false); }
  };
  const dispatch = async (runId: string) => {
    if (!csrfToken || busy) return;
    setBusy(true); setError('');
    try { const next = await api.dispatchBusiness(value.caseId, runId, value.versionId, value.inputManifestId, csrfToken); setReceipt(next); await client.invalidateQueries({ queryKey }); await client.invalidateQueries({ queryKey: ['space', scope] }); onRun({ id: next.runId, caseId: next.caseId, versionId: next.versionId } as RunSummaryDto); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '派发失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <section className="sw-business-action sw-business-preparation"><div className="sw-business-preparation-summary"><strong>已冻结：{value.caseTitle}</strong><span>{value.objective}</span><span>方法：{method.data?.label || (method.error ? '方法名称读取失败' : '正在读取方法')}{method.data?.purpose ? ` · ${method.data.purpose}` : ''}</span></div>{value.conditions.length > 0 && <p className="sw-business-conditions">运行条件：{value.conditions.join(' · ')}</p>}
    <details className="sw-business-frozen"><summary>展开准确要求与材料（{value.inputs.length} 项冻结资产）</summary><h4>本次要求与材料</h4>{value.sections.map((section, index) => <article key={index}><strong>{section.title}</strong><p>{section.text}</p></article>)}<h4>冻结材料</h4>{value.inputs.map(asset => <button className="sw-business-asset" key={asset.id} onClick={() => onAsset(asset.id)}>{asset.title} · 阅读来源</button>)}</details><details className="sw-business-trace"><summary>方法与输入追溯</summary><dl><dt>方法版本</dt><dd>{value.versionId}</dd><dt>保存时名称</dt><dd>{value.versionLabel}</dd><dt>版本修订</dt><dd>{method.data?.revision || '未读取'}</dd><dt>输入清单</dt><dd>{value.inputManifestId}</dd><dt>清单摘要</dt><dd>{value.inputManifestHash}</dd></dl></details>
    {value.actions.start && <button disabled={busy || !csrfToken} onClick={() => void start()}>{busy ? '正在处理…' : '开始运行这件业务'}</button>}
    {value.actions.dispatch && value.runs.filter(run => run.taskState === 'queued' || run.state === 'queued').map(run => <button key={run.id} disabled={busy || !csrfToken} onClick={() => void dispatch(run.id)}>继续派发已排队运行 {run.label}</button>)}
    {value.actions.reason && <p className="sw-business-hint">{value.actions.reason}</p>}
    {value.runs.length > 0 && <div><h4>准确运行</h4>{value.runs.map(run => <button className="sw-business-asset" key={run.id} onClick={() => onRun(run)}>{run.label} · {run.state}</button>)}</div>}
    {receipt && <p className="sw-business-receipt">运行 {receipt.runId} · {receipt.dispatched ? '已派发' : '已建立，派发待确认'}{receipt.dispatchError && ` · ${receipt.dispatchError}`}</p>}
    {error && <p role="alert" className="sw-business-error">{error}</p>}
  </section>;
}

export function BusinessAction({ api, scope, caseId, selectedRunId, versionId, versionLabel, versionPurpose, versionPurposeError, versions, adoptedVersionId, onVersionSelect, csrfToken, writable, onPrepared, onRun, onAsset }: { api: SpaceApi; scope: string; caseId?: string; selectedRunId?: string; versionId?: string; versionLabel?: string; versionPurpose?: string | null; versionPurposeError: boolean; versions: VersionSummaryDto[]; adoptedVersionId?: string | null; onVersionSelect: (id: string) => void; csrfToken?: string | null; writable: boolean; onPrepared: (prepared: BusinessPreparationDto) => void; onRun: (run: RunSummaryDto) => void; onAsset: (id: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(!caseId && !selectedRunId);
  useEffect(() => { if (caseId) { setCreating(false); setOpen(!selectedRunId); } }, [caseId, selectedRunId]);
  return <div className="sw-business-shell"><div className="sw-business-head"><button onClick={() => { setCreating(true); setOpen(true); }}>新建业务</button>{caseId && <button onClick={() => { setCreating(false); setOpen(!open); }}>{open ? '收起业务准备' : '查看业务准备'}</button>}</div>{open && (creating || !caseId ? writable ? <Form key={scope} api={api} scope={scope} versionId={versionId} versionLabel={versionLabel} versionPurpose={versionPurpose} versionPurposeError={versionPurposeError} versions={versions} adoptedVersionId={adoptedVersionId} onVersionSelect={onVersionSelect} csrfToken={csrfToken} onPrepared={onPrepared} /> : <p className="sw-business-action">当前身份没有新建业务权限。</p> : <Preparation key={`${scope}:${caseId}`} api={api} scope={scope} caseId={caseId} csrfToken={csrfToken} onRun={onRun} onAsset={onAsset} />)}</div>;
}
