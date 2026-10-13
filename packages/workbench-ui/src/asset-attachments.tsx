import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AttachmentDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { inlineAttachmentType, readableByteSize, verifiedAttachment } from './attachment-bytes.js';

function Attachment({ api, assetVersionId, item, index }: { api: SpaceApi; assetVersionId: string; item: AttachmentDto; index: number }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [url, setUrl] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const inlineType = inlineAttachmentType(item.mediaType);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const read = async () => {
    activeRequest.current?.abort();
    const request = new AbortController();
    activeRequest.current = request;
    setPending(true); setError(undefined);
    try {
      const bytes = await api.attachmentContent(assetVersionId, item, request.signal);
      await verifiedAttachment(bytes, item);
      if (request.signal.aborted) return;
      setUrl(URL.createObjectURL(new Blob([bytes], { type: inlineType || 'application/octet-stream' })));
    } catch (reason) {
      if (request.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : '附件字节不可读取。');
      setUrl(undefined);
    } finally { if (!request.signal.aborted) setPending(false); }
  };
  return <li className="sw-attachment"><strong>附件 {index + 1}</strong><span>{item.mediaType} · {readableByteSize(item.size)}</span><details><summary>准确附件身份</summary><code>Blob {item.id} · SHA-256 {item.sha256}</code></details>{url ? <span className="sw-attachment-actions">{inlineType && <a href={url} target="_blank" rel="noopener noreferrer">阅读已核对附件</a>}<a href={url} download={item.sha256}>下载已核对附件</a><button type="button" onClick={() => { setUrl(undefined); void read(); }} disabled={pending}>重新核对</button></span> : <button type="button" onClick={() => void read()} disabled={pending}>{pending ? '正在核对保存字节…' : '核对并读取附件'}</button>}{error && <p role="alert">附件字节不可读取：{error}</p>}</li>;
}

export function AssetAttachments({ api, scope, assetVersionId }: { api: SpaceApi; scope: string; assetVersionId: string }) {
  const query = useQuery({ queryKey: ['space', scope, api.root, 'asset-attachments', assetVersionId], queryFn: ({ signal }) => api.assetAttachments(assetVersionId, signal), retry: false });
  return <section className="sw-attachments"><h4>此资产版本的附件</h4>{query.error && <p role="alert">附件清单不可读取：{query.error instanceof Error ? query.error.message : '读取失败'} <button type="button" onClick={() => void query.refetch()}>重试</button></p>}{!query.data && !query.error && <p className="sw-muted">正在核对准确资产版本的附件绑定…</p>}{query.data && (query.data.assetVersionId !== assetVersionId ? <p role="alert">附件清单返回的资产版本不一致，已停止读取。</p> : query.data.items.length ? <ul>{query.data.items.map((item, index) => <Attachment key={`${assetVersionId}:${item.id}`} api={api} assetVersionId={assetVersionId} item={item} index={index} />)}</ul> : <p className="sw-muted">此资产版本没有绑定附件。</p>)}</section>;
}
