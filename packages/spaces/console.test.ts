import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createSpaceConsole, type SpaceConsoleService } from './console.js';
import type { AssetVersion, SpaceOverview } from './types.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function origin(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return `http://127.0.0.1:${address.port}`;
}

function fixture(): {service: SpaceConsoleService; asset: AssetVersion & {state: string}} {
  const asset: AssetVersion & {state: string} = {
    id: 'v1', spaceId: 'allowed', assetId: 'draft', version: 1,
    schema: { namespace: 'test/draft', revision: '1', hash: 'a'.repeat(64) },
    payload: { text: '<script>alert(1)</script>', decision: 'Do not execute' }, payloadHash: 'b'.repeat(64),
    source: { kind: 'import', actorId: 'author', description: '<img src=x onerror=alert(1)>' },
    dependencies: [], attachments: [], initialState: 'candidate', state: 'candidate', createdAt: '2026-10-04T00:00:00Z',
  };
  const second = { ...asset, id: 'v2', version: 2, payload: { text: 'Revised text' } };
  const overview: SpaceOverview = {
    space: { id: 'allowed', purpose: '<script>Unsafe title</script>', owner: 'owner', status: 'active', createdAt: '2026-10-04T00:00:00Z' },
    workflows: [], cases: [], runs: [], assets: [asset, second],
    reviews: [{
      id: 'review-1', spaceId: 'allowed', runId: 'run-1', assetVersionIds: ['v1'],
      standard: { id: 'standard', revision: '1', content: 'Evaluate content' },
      judge: { kind: 'human', id: 'owner' }, evidence: ['v1'],
      answers: { good: 'Readable', bad: '<svg onload=alert(1)>', improvement: 'Clearer title', unresolved: 'Audience fit' },
      createdAt: '2026-10-04T00:00:00Z',
    }],
    comparisons: [{ id: 'comparison-1', spaceId: 'allowed', baselineReviewId: 'review-1', candidateReviewId: 'review-2',
      conclusion: 'Improved', changedConditions: {} }],
    iterations: [], adoptions: [], sessions: [], knowledge: [],
  };
  const service: SpaceConsoleService = {
    async listSpaces() { return [overview.space]; },
    async overview(spaceId) {
      if (spaceId !== 'allowed') throw new Error('Space access denied');
      return overview;
    },
    async readAsset(spaceId, versionId) {
      if (spaceId !== 'allowed' || versionId === 'secret') throw new Error('Space access denied');
      const found = overview.assets.find((item) => item.id === versionId);
      if (!found) throw new Error('Record not found in authorized space');
      return found;
    },
    async readContext() { throw new Error('Record not found in authorized space'); },
    async sessionEvents() { return { items: [], nextCursor: 0, hasMore: false }; },
    async readBlob() { return new Uint8Array([1, 2, 3]); },
  };
  return { service, asset };
}

describe('space console', () => {
  it('bounds linked process selections and immutable fragment returns to the selected run',async()=>{
    const {service,asset}=fixture(),data=await service.overview('allowed');
    const run={runId:'run-1',spaceId:'allowed',workflowVersionId:'method',entrypoint:'draft',caseId:'case-1',inputManifestId:'manifest',effectiveConfig:{},configHash:'c'};
    data.runs.push(run);data.cases.push({id:'case-1',spaceId:'allowed',title:'Case',objective:'Read exact output',constraints:[]});
    asset.source={kind:'node',runId:'run-1',nodeId:'author',contextId:'ctx',sessionId:'session',stepRunId:'step',attemptId:'attempt',producer:'program'};
    service.process=async()=>({run,contractSource:'unknown',coverage:'partial',routes:[],relations:[],unmappedStepIds:[],occurrences:[{
      id:'node-1',nodeId:'author',round:2,provenance:'observed',state:'succeeded',inputs:{},outputs:{draft:['v1']},stepRunIds:['step'],contextIds:[],attemptIds:[],attemptRecords:[],technicalSteps:[],sessionIds:[],lifecycleEvidence:[],inputBindings:[],outputBindings:[],
    }]});
    const base=await origin(createSpaceConsole(service));
    const route=`${base}/spaces/allowed/cases/case-1?run=run-1&tab=process`;
    expect((await fetch(route+'&round=2&node=node-1&asset=v1')).status).toBe(200);
    for(const query of ['mode=unknown','round=3','node=other','asset=v2'])expect((await fetch(route+'&'+query)).status).toBe(400);
    const returned=await fetch(`${base}/spaces/allowed/assets/v1?run=run-1&pointer=%2Ftext&backAsset=v1&backRound=2`);
    expect(returned.status).toBe(200);expect(await returned.text()).toContain('tab=process&amp;asset=v1&amp;round=2');
    for(const query of ['pointer=%2Fmissing','pointer=%2Fbad~3','backAsset=v2&backRound=2','backAsset=v1&backRound=3'])expect((await fetch(`${base}/spaces/allowed/assets/v1?run=run-1&${query}`)).status).toBe(400);
  });
  it('renders a business overview without raw storage payloads and escapes its title', async () => {
    const { service } = fixture();
    const base = await origin(createSpaceConsole(service));
    const response = await fetch(`${base}/spaces/allowed`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('&lt;script&gt;Unsafe title&lt;/script&gt;');
    expect(html).toContain('需要处理的事项');
    expect(html).toContain('尚未创建案例');
    expect(html).not.toContain('comparison-1');
    expect(html).not.toContain('Do not execute');
    expect(html).not.toContain('<script>');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('compares exact versions and enforces the bound service on every read', async () => {
    const { service } = fixture();
    const base = await origin(createSpaceConsole(service));
    const compare = await fetch(`${base}/spaces/allowed/compare?left=v1&right=v2`);
    const html = await compare.text();
    expect(compare.status).toBe(200);
    expect(html).toContain('Revised text');
    expect(html).toContain('Do not execute');
    const denied = await fetch(`${base}/spaces/forbidden?principal=owner`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('Do not execute');
    const crossSpace = await fetch(`${base}/spaces/allowed/compare?left=v1&right=secret`);
    expect(crossSpace.status).toBe(403);
    expect(await crossSpace.text()).not.toContain('Do not execute');
  });

  it('rejects mutations and invalid cursors', async () => {
    const { service } = fixture();
    const base = await origin(createSpaceConsole(service));
    expect((await fetch(`${base}/spaces/allowed`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${base}/spaces/allowed/sessions/session-1?cursor=oops`)).status).toBe(400);
    expect((await fetch(`${base}/spaces/allowed/assets/v1`)).status).toBe(200);
  });

  it('keeps secondary storage pages separate and rejects unknown case tabs',async()=>{
    const {service}=fixture();const base=await origin(createSpaceConsole(service));
    const assets=await (await fetch(`${base}/spaces/allowed/assets`)).text();
    expect(assets).toContain('资产内容');expect(assets).not.toContain('<script>');
    const iterations=await (await fetch(`${base}/spaces/allowed/iterations`)).text();
    expect(iterations).toContain('暂无方法迭代记录');expect(iterations).toContain('comparison-1');
    expect((await fetch(`${base}/spaces/allowed/cases/missing?run=run-other`)).status).toBe(404);
    expect((await fetch(`${base}/spaces/allowed/compare?left=v1&right=v2&mode=wrong`)).status).toBe(400);
  });

  it('selects a business reader by schema revision and escapes all rendered text', async () => {
    const { service } = fixture();
    const base = await origin(createSpaceConsole(service, { readers: {
      'test/draft@1': asset => ({title:'Readable draft',sections:[{title:'<b>Body</b>',text:(asset.payload as {text:string}).text}]}),
      'test/draft@2': () => { throw new Error('Wrong schema reader'); },
    }}));
    const html=await (await fetch(`${base}/spaces/allowed/assets/v1`)).text();
    expect(html).toContain('<h1>Readable draft</h1>');expect(html).toContain('&lt;b&gt;Body&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');expect(html).not.toContain('<script>');
    expect(html).toContain('原始结构数据');
    expect(html).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
    expect(html.indexOf('<h1>Readable draft</h1>')).toBeLessThan(html.indexOf('<summary>版本与来源</summary>'));
    expect(html).toContain('Logical asset draft');
    expect(html).toContain('<summary>版本与来源</summary>');
  });
  it('reopens only historical view bindings of the exact workflow without changing its method', async()=>{
    const {service,asset}=fixture();
    const data=await service.overview('allowed');
    asset.source={kind:'node',runId:'run',stepRunId:'step',attemptId:'attempt',nodeId:'writer',producer:'program',sessionId:'session',contextId:'ctx'};
    data.runs=[{runId:'run',spaceId:'allowed',workflowVersionId:'method',entrypoint:'quote',caseId:'case',inputManifestId:'inputs',effectiveConfig:{},configHash:'unchanged'}];
    data.cases=[{id:'case',spaceId:'allowed',title:'Quotation',objective:'A readable quote',constraints:[]}];
    const definition=(revision:string)=>({id:'view',revision,entrypoint:'quote',label:'Quotes',spaceId:'allowed',hash:revision.repeat(64),createdAt:'2026-10-05',createdBy:'owner',results:{primary:'quote',supporting:[],assessments:[]},assetViews:[{schema:asset.schema,label:'Quote '+revision,sections:[{component:'paragraphs' as const,path:'/text',label:'Body'}]}]});
    const binding=(revision:string)=>({id:'binding-'+revision,spaceId:'allowed',workflowVersionId:'method',entrypoint:'quote',presentationId:'view',presentationRevision:revision,presentationHash:revision.repeat(64),actorId:'owner',createdAt:'2026-10-05'});
    service.resolvePresentation=async()=>({presentation:definition('2'),binding:binding('2'),history:[binding('1'),binding('2')]});
    service.getPresentation=async(_space,_id,revision)=>definition(revision);
    const base=await origin(createSpaceConsole(service));
    const old=await fetch(`${base}/spaces/allowed/assets/v1?run=run&viewBinding=binding-1`);
    expect(old.status).toBe(200);expect(await old.text()).toContain('<h1>Quote 1</h1>');
    expect((await fetch(`${base}/spaces/allowed/assets/v1?viewBinding=foreign-binding`)).status).toBe(400);
    expect((await fetch(`${base}/spaces/allowed/assets/v2?run=run`)).status).toBe(400);
    expect(data.runs[0]?.configHash).toBe('unchanged');
  });

  it('summarizes streaming events while retaining exact failure, recovery and raw evidence', async()=>{
    const {service}=fixture();const data=await service.overview('allowed');
    data.cases=[{id:'case',spaceId:'allowed',title:'Quotation',objective:'A readable quote',constraints:[]}];
    data.runs=[{runId:'run',spaceId:'allowed',workflowVersionId:'method',entrypoint:'quote',caseId:'case',inputManifestId:'inputs',effectiveConfig:{},configHash:'unchanged'}];
    const events=[{id:'delta-1',type:'siwc.text_delta',text:'kept raw'}, {id:'delta-2',type:'siwc.text_delta'}, {id:'failure',type:'step.failed'}, {id:'recovery',type:'harness.recovery_patch'}];
    service.runtimeEvidence=async()=>({getRun:async()=>undefined,listSteps:async()=>[],listEvents:async()=>events}) as Awaited<ReturnType<NonNullable<SpaceConsoleService['runtimeEvidence']>>>;
    const base=await origin(createSpaceConsole(service));
    const html=await (await fetch(`${base}/spaces/allowed/cases/case?tab=evidence`)).text();
    expect(html).toContain('共 4 条事件');expect(html).toContain('siwc.text_delta：2');
    expect(html).not.toContain('<summary>siwc.text_delta</summary>');
    expect(html).toContain('<summary>step.failed</summary>');expect(html).toContain('<summary>harness.recovery_patch</summary>');
    expect(html).toContain('<summary>全部事件原始证据</summary>');expect(html).toContain('kept raw');
  });

});
