import type { ServerResponse } from 'node:http';
import type { WorkflowEntrypoint, WorkflowEntrypointDraft } from './types.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The viewer is sandboxed; only an allowlisted node ID can select host details. */
export function workflowDiagramFrame(entry: WorkflowEntrypoint | WorkflowEntrypointDraft, src: string): string {
  return `<iframe class="workflow-diagram" title="交互工作流：搜索、聚焦、上下游与路径" src="${escape(src)}" sandbox="allow-scripts allow-downloads" data-workflow-diagram data-node-ids="${escape(JSON.stringify(entry.process?.nodes.map(node => node.id) ?? []))}"></iframe><p><a href="${escape(src)}" target="_blank" rel="noopener">独立看图与导出</a></p><script src="/workflow-diagram.js" defer></script>`;
}

export const workflowDiagramCss = `.method-workspace{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(320px,1fr);gap:20px;align-items:start}.method-canvas{min-width:0}.workflow-diagram{display:block;width:100%;height:760px;border:1px solid #d9dfdf;border-radius:14px;background:#fff}.method-workspace>#node-detail{margin:0;max-height:820px;overflow:auto;position:sticky;top:18px}.method-workspace #node-detail h2{margin-top:0}.method-workspace .two{display:block}.node-occurrence{padding:12px 0;border-bottom:1px solid #e1e7e1}.method-run-selector{display:flex;align-items:end;gap:10px;margin:16px 0}.method-run-selector label{min-width:0;max-width:100%;margin:0}.executor-label{font-size:.9rem;color:#53667a}@media(max-width:1050px){.method-workspace{grid-template-columns:minmax(0,1fr)}.method-workspace>#node-detail{position:static;max-height:none}.workflow-diagram{height:650px}}@media(max-width:650px){.workflow-diagram{height:580px}}`;

export const workflowDiagramScript = `(() => {
  let pending;
  window.addEventListener('message', async event => {
    const frame = [...document.querySelectorAll('iframe[data-workflow-diagram]')].find(item => item.contentWindow === event.source);
    if (!frame || !event.data || event.data.type !== 'workflow-node-select' || typeof event.data.nodeId !== 'string') return;
    let ids;
    try { ids = JSON.parse(frame.dataset.nodeIds); } catch { return; }
    if (!Array.isArray(ids) || !ids.includes(event.data.nodeId)) return;
    const url = new URL(location.href);
    if(url.searchParams.get('node')===event.data.nodeId) return;
    const version = new URL(frame.src).searchParams.get('version');
    if (version) url.searchParams.set('version', version);
    url.searchParams.set('node', event.data.nodeId);
    url.hash = 'node-detail';
    pending?.abort();
    const controller = new AbortController(); pending = controller;
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) throw new Error('Detail unavailable');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const detail = page.querySelector('#node-detail');
      const current = document.querySelector('#node-detail');
      if (!detail || !current) throw new Error('Detail unavailable');
      if (pending !== controller) return;
      current.replaceWith(detail);
      history.replaceState(null, '', url);
      detail.setAttribute('tabindex', '-1'); detail.focus({preventScroll: true});
      if (matchMedia('(max-width: 1050px)').matches) detail.scrollIntoView({block:'start',behavior:'smooth'});
    } catch (error) {
      if (error.name !== 'AbortError' && pending === controller) location.assign(url);
    }
  });
})();`;

export function sendWorkflowDiagram(response: ServerResponse, html: string): void {
  // Only this isolated child receives inline viewer scripts. It cannot access the host DOM.
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-downloads");
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}
