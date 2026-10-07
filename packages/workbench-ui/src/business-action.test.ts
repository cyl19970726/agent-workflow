import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BusinessFormDto } from '@signal-room/workflow-space-api/contracts';
import { BusinessAction, businessValues } from './business-action.js';
import { SpaceApi } from './api.js';

describe('ordinary business form', () => {
  it('uses only descriptor fields and keeps explicit material sources', () => {
    const form: BusinessFormDto = { title: '委托', description: '', conditions: [], fields: [
      { key: 'goal', label: '目标', kind: 'multiline', required: true },
      { key: 'questions', label: '必答问题', kind: 'lines', required: true },
      { key: 'materials', label: '材料', kind: 'materials', required: true },
    ] };
    expect(businessValues(form, { goal: ' 解释清楚 ', questions: '为什么？\n\n如何？', materials: [{ id: 'source-1', title: '笔记', source: '访谈', text: '正文' }], invisible: '不能提交' })).toEqual({ goal: '解释清楚', questions: ['为什么？', '如何？'], materials: [{ id: 'source-1', title: '笔记', source: '访谈', text: '正文' }] });
  });

  it('renders when the form query is ready before local material values initialize', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    const form: BusinessFormDto = { title: '新建业务', description: '填写材料', conditions: [], fields: [{ key: 'materials', label: '材料', kind: 'materials', required: true, defaultValue: [{ id: 'one', title: '笔记', source: '访谈', text: '正文' }] }] };
    client.setQueryData(['space', 'subject:scope', api.root, 'business-form'], form);
    expect(businessValues(form, {}).materials).toEqual([]);
    const html = renderToString(createElement(QueryClientProvider, { client }, createElement(BusinessAction, { api, scope: 'subject:scope', versionId: 'v1', versionLabel: '方法', versionPurposeError: false, versions: [], onVersionSelect: () => {}, csrfToken: 'csrf', writable: true, onPrepared: () => {}, onRun: () => {}, onAsset: () => {} })));
    expect(html).toContain('正在准备业务表单');
  });
});
