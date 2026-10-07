import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createInteractiveSpaceConsole, InteractiveConsoleError, type InteractiveWorkflowHost } from './interactive-console.js';
import type { SpaceConsoleService } from './console.js';
import type { AssetVersion, SpaceOverview } from './types.js';
import type { ValidationWorkbench } from './validation-workbench.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}

function hidden(html: string, name: string): string {
  const found = html.match(new RegExp(`<input type="hidden" name="${name}" value="([^"]+)"`));
  if (!found) throw new Error(`Missing ${name}`);
  return found[1]!;
}
function forms(html: string, action: string): string[] {
  return [...html.matchAll(/<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/g)]
    .filter(match => match[1] === action).map(match => match[0]);
}

function fixture() {
  const calls = { case: 0, run: 0, review: 0, lastRun: undefined as Parameters<InteractiveWorkflowHost['startRun']>[2] | undefined,
    lastReview: undefined as Parameters<InteractiveWorkflowHost['saveReview']>[1] | undefined };
  const draft: AssetVersion & { state: string } = {
    id: 'draft-v1', spaceId: 'space', assetId: 'draft', version: 1,
    schema: { namespace: 'test/draft', revision: '1', hash: 'a'.repeat(64) }, payload: { text: 'Readable draft' }, payloadHash: 'b'.repeat(64),
    source: { kind: 'node', runId: 'run-1', stepRunId: 'step-1', attemptId: 'attempt-1', nodeId: 'writer', producer: 'agent', sessionId: 'session-1', contextId: 'context-1' },
    dependencies: [], attachments: [], initialState: 'candidate', state: 'candidate', createdAt: '2026-10-05T00:00:00Z',
  };
  const overview: SpaceOverview = {
    space: { id: 'space', purpose: 'Test space', owner: 'owner', status: 'active', createdAt: '2026-10-05T00:00:00Z' },
    workflows: [], cases: [{ id: 'case-1', spaceId: 'space', title: '<Useful case>', objective: 'Write an article', constraints: [] }],
    runs: [{ runId: 'run-1', spaceId: 'space', workflowVersionId: 'v1', entrypoint: 'content', caseId: 'case-1', inputManifestId: 'manifest', effectiveConfig: {}, configHash: 'hash' }],
    assets: [draft], reviews: [{ id: 'review-1', spaceId: 'space', runId: 'run-1', assetVersionIds: ['draft-v1'], standard: { id: 'standard', revision: '1', content: 'Readability' }, judge: { kind: 'agent', id: 'reviewer', sessionId: 'review-session' }, evidence: ['draft-v1'], answers: { good: 'Clear', bad: 'Slow', improvement: 'Baseline', unresolved: 'Ending' }, createdAt: '2026-10-05T00:00:00Z' }],
    comparisons: [], iterations: [], adoptions: [], sessions: [{id:'session-1',role:'writer',completeness:'complete',nextSeq:1},{id:'session-live',role:'writer',completeness:'open',nextSeq:1},{id:'session-2',role:'writer',completeness:'complete',nextSeq:1}], knowledge: [],
  };
  const service: SpaceConsoleService = {
    async listSpaces() { return [overview.space]; },
    async overview(spaceId) { if (spaceId !== 'space') throw new Error('Space access denied'); return overview; },
    async readAsset(_spaceId, versionId) { if (versionId !== draft.id) throw new Error('not found in authorized space'); return draft; },
    async readContext() { throw new Error('not found in authorized space'); },
    async sessionEvents() { return { items: [], nextCursor: 0, hasMore: false }; },
    async readBlob() { return new Uint8Array(); },
  };
  const workflow: InteractiveWorkflowHost = {
    spaceId: 'space', label: 'Content',
    caseFields: [{ name: 'title', label: 'Case title', kind: 'text', required: true }],
    runFields: [{ name: 'format', label: 'Format', kind: 'text', required: true }],
    async createCase(input) { calls.case++; expect(input.title).toBe('New case'); return { id: 'case-1' }; },
    async startRun(_caseId, _input, options) { calls.run++; calls.lastRun = options; return { runId: 'run-2' }; },
    async saveReview(_caseId, input) { calls.review++; calls.lastReview = input; return { id: 'review-2' }; },
    async runStatus() { return { state: 'needs_review', progress: 'Ready to read',reviewableAssetVersionId:'draft-v1' }; },
    isDeliverable: asset => asset.schema.namespace === 'test/draft',
  };
  return { service, workflow, calls, overview };
}

describe('interactive space console', () => {
  it('uses guarded validation forms for exact plans and trusted human reviews',async()=>{
    const {service,workflow,overview}=fixture();
    const version=(id:string)=>({id,spaceId:'space',revision:'same',changeReason:`reason ${id}`,hash:'hash',createdAt:'2026-10-06',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'code',storageContract:{workflowVersion:id,hash:'storage',nodes:{},stateRules:[]}}}}) as SpaceOverview['workflows'][number];
    overview.workflows.push(version('v1'),version('v2'));
    const calls:{create?:unknown;review?:unknown;start?:unknown;issue?:unknown}={};
    const plan={id:'plan',kind:'prospective',status:'frozen',question:'Which works?',hypothesis:'Better structure',baseline:{workflowVersionId:'v1',entrypoint:'content'},candidate:{workflowVersionId:'v2',entrypoint:'content'},cases:[{caseId:'case-1',inputManifestId:'manifest',repeats:1}],standard:{id:'quality',revision:'1',content:'Readable'},judges:[{kind:'human',id:'person'}],expectedVariables:[],exclusionRules:[],entries:[{id:'entry-1',side:'baseline',caseId:'case-1',inputManifestId:'manifest',repeat:1,workflowVersionId:'v1',entrypoint:'content'},{id:'entry-2',side:'candidate',caseId:'case-1',inputManifestId:'manifest',repeat:1,workflowVersionId:'v2',entrypoint:'content'}]};
    const summary={plan,data:overview,humanJudgeId:'person',entries:[{entry:plan.entries[0],status:'needs_review',attempts:[{attempt:1,runId:'run-1',status:'completed',reviews:[]}],requiredJudgeCoverage:[{kind:'human',id:'person',reviewIds:[]}],deliverableAssetVersionIds:['draft-v1']},{entry:plan.entries[1],status:'missing',attempts:[],requiredJudgeCoverage:[{kind:'human',id:'person',reviewIds:[]}]}],cases:[{caseId:'case-1',baselineEntryIds:['entry-1'],candidateEntryIds:['entry-2'],status:'missing'}],pairs:[{caseId:'case-1',repeat:1,baselineEntryId:'entry-1',candidateEntryId:'entry-2',status:'missing',comparisonIds:[],changedConditions:{}}],totals:{cases:1,plannedPairs:1,entries:2,attempts:1,byStatus:{needs_review:1,missing:1}},issues:[],comparisons:[]};
    workflow.validation={async list(){return{plans:[plan],data:overview,manifests:[{id:'manifest',spaceId:'space',caseId:'case-1',assets:{},hash:'hash'}],humanJudgeId:'person'};},async detail(){return summary;},async create(draft){calls.create=draft;return plan;},async freeze(){return plan;},async start(_planId,entryId,attempt){calls.start={entryId,attempt};return{runId:'run-2'};},async dispatch(){},async review(_planId,input){calls.review=input;return overview.reviews[0]!;},async compare(){},async issue(_planId,input){calls.issue=input;},async adopt(){},async linkRun(){},async linkReview(){},async iteration(){throw Error('unused');}} as unknown as ValidationWorkbench;
    const base=await listen(createInteractiveSpaceConsole(service,{workflow}));
    const index=await(await fetch(`${base}/workbench/validation`)).text();
    expect(index).toContain('name="manifest:case-1"');expect(index).toContain('reason v2');
    const csrf=hidden(index,'csrf');
    const post=(route:string,fields:Record<string,string>)=>fetch(`${base}${route}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual',body:new URLSearchParams({csrf,commandId:'a'.repeat(32),...fields})});
    const create={question:'Quality?',hypothesis:'Better',baseline:'v1|content',candidate:'v2|content',caseId:'case-1','manifest:case-1':'manifest','repeats:case-1':'1',standardId:'quality',standardRevision:'1',standardContent:'Readable'};
    expect((await post('/workbench/validation',{...create,judgeKind:'agent'})).status).toBe(400);
    expect((await post('/workbench/validation',{...create,'manifest:case-1':'foreign'})).status).toBe(400);
    expect((await post('/workbench/validation',create)).status).toBe(303);
    expect((calls.create as {judges:Array<{kind:string;id:string}>}).judges).toEqual([{kind:'human',id:'person'}]);
    const detail=await(await fetch(`${base}/workbench/validation/plan`)).text();
    expect(detail).toContain('评价未齐');expect(detail).toContain('1 个不同案例 · 2 个计划项');
    expect((await post('/workbench/validation/plan/start',{entryId:'entry-2',attempt:'1'})).status).toBe(303);
    expect(calls.start).toEqual({entryId:'entry-2',attempt:1});
    const review={entryId:'entry-1',runId:'run-1',assetVersionId:'draft-v1',good:'Good',bad:'Bad',improvement:'Better',unresolved:'Unknown'};
    expect((await post('/workbench/validation/plan/review',{...review,judge:'agent'})).status).toBe(400);
    expect((await post('/workbench/validation/plan/review',review)).status).toBe(303);
    expect((calls.review as {answers:{good:string};id:string}).answers.good).toBe('Good');
    expect((calls.review as {id:string}).id).toBe('a'.repeat(32));
  });
  it('requires an available published version and passes the exact selected identity after newer publication', async () => {
    const {service,workflow,overview,calls}=fixture();
    const makeVersion=(id:string,createdAt:string)=>({id,spaceId:'space',revision:'content-v2',changeReason:'test',hash:'h',createdAt,config:{},entrypoints:{content:{workflowId:'example.content',codeRevision:'code',storageContract:{workflowVersion:id,hash:'storage',nodes:{},stateRules:[]}}}}) as SpaceOverview['workflows'][number];
    overview.workflows.push(makeVersion('older','2026-10-05T00:00:00Z'),makeVersion('newer','2026-10-06T00:00:00Z'));
    let unavailable=false;
    workflow.methods={workflowId:'example.content',entrypoint:'content',async preview(){throw Error('unused');},async publish(){throw Error('unused');},async availability(id){return{id,available:id==='older'?!unavailable:true,reason:unavailable?'bundle missing':undefined};}};
    const base=await listen(createInteractiveSpaceConsole(service,{workflow}));
    const page=await (await fetch(`${base}/workbench/cases/case-1`)).text();
    expect(page).toContain('name="workflowVersionId"');expect(page).toContain('older');expect(page).toContain('newer');
    const baseForm={csrf:hidden(page,'csrf'),commandId:'a'.repeat(32),hypothesis:'Compare methods',format:'article',entrypoint:'content'};
    const post=(fields:Record<string,string>)=>fetch(`${base}/workbench/cases/case-1/runs`,{method:'POST',body:new URLSearchParams(fields),headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual'});
    expect((await post(baseForm)).status).toBe(400);
    expect((await post({...baseForm,workflowVersionId:'foreign'})).status).toBe(400);
    expect(calls.run).toBe(0);
    unavailable=true;
    expect((await post({...baseForm,workflowVersionId:'older'})).status).toBe(409);
    unavailable=false;
    const run=await post({...baseForm,workflowVersionId:'older'});
    expect(run.status).toBe(303);expect(calls.lastRun?.workflowVersionId).toBe('older');expect(calls.lastRun?.entrypoint).toBe('content');
    const exact=await (await fetch(`${base}/workbench/workflows/older/content/run`)).text();
    expect(exact).toContain('准确版本');expect(exact).toContain('older');
    const exactPost=await fetch(`${base}/workbench/workflows/older/content/run`,{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual',body:new URLSearchParams({csrf:hidden(exact,'csrf'),commandId:'b'.repeat(32),caseId:'case-1',hypothesis:'Exact version',format:'article'})});
    expect(exactPost.status).toBe(303);expect(calls.lastRun?.workflowVersionId).toBe('older');
  });

  it('reads persistent task status without dispatch and restricts cancel to owned active tasks', async () => {
    const {service,workflow}=fixture();let dispatches=0,canceled:string[]=[];
    const availabilityCalls:string[]=[];
    workflow.methods={workflowId:'example.content',entrypoint:'content',async preview(){throw Error('unused');},async publish(){throw Error('unused');},async availability(versionId,entrypoint){availabilityCalls.push(`${versionId}/${entrypoint}`);return{available:false,reason:'exact executor bundle missing'};}};
    workflow.runStatus=async runId=>({state:runId==='queued-run'?'queued':'interrupted',progress:runId==='queued-run'?'等待容量':'已中断'});
    const timestamps={createdAt:'2026-10-06T00:00:00Z',updatedAt:'2026-10-06T00:00:00Z'};
    const tasks=[{...timestamps,runId:'queued-run',spaceId:'space',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'m',caseId:'case-1',executorKey:'e',status:'queued' as const},{...timestamps,runId:'interrupted-run',spaceId:'space',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'m',caseId:'case-1',executorKey:'e',status:'interrupted' as const},{...timestamps,runId:'foreign-run',spaceId:'foreign',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'m',caseId:'case-1',executorKey:'e',status:'running' as const}];
    workflow.execution={async list(){return tasks;},async cancel(runId){canceled.push(runId);},async dispatch(){dispatches++;}};
    const base=await listen(createInteractiveSpaceConsole(service,{workflow}));
    const response=await fetch(`${base}/workbench/runs`),page=await response.text();
    expect(response.status).toBe(200);expect(page).toContain('排队中');expect(page).toContain('等待对应版本执行器：exact executor bundle missing');expect(page).not.toContain('等待容量');expect(page).toContain('需核对与协调恢复');expect(page).toContain('执行中 0 · 排队 1 · 中断 1');expect(page).toContain('href="/workbench/runs">刷新状态');expect(page).not.toContain('foreign-run');expect(dispatches).toBe(0);expect(availabilityCalls).toEqual(['v1/content']);
    const csrf=hidden(page,'csrf');
    const post=(path:string)=>fetch(`${base}${path}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual',body:new URLSearchParams({csrf,commandId:'c'.repeat(32)})});
    expect((await post('/workbench/runs/foreign-run/cancel')).status).toBe(404);
    expect((await post('/workbench/runs/interrupted-run/cancel')).status).toBe(409);
    expect(canceled).toHaveLength(0);
    expect((await post('/workbench/runs/queued-run/cancel')).status).toBe(303);
    expect(canceled).toEqual(['queued-run']);expect(dispatches).toBe(0);
    expect((await post('/workbench/runs/dispatch')).status).toBe(303);expect(dispatches).toBe(1);
  });
  it('previews without publishing and requires an explicit same-origin publish for the exact candidate', async () => {
    const {service,workflow,overview}=fixture();let publishes=0;
    const candidate={entrypoint:'content',version:{id:'candidate-v2',revision:'V2',changeReason:'Better method',entrypoints:{content:{workflowId:'example.content',codeRevision:'source-2',storageContract:{workflowVersion:'candidate-v2',nodes:{},stateRules:[]},process:{revision:'2',nodes:[{id:'start',kind:'program' as const}],edges:[],results:[]}}},config:{}}};
    workflow.methods={workflowId:'example.content',entrypoint:'content',async preview(){return candidate;},async publish(input){publishes++;expect(input.expectedVersionId).toBe(candidate.version.id);return{workflowVersionId:candidate.version.id,entrypoint:'content'};},async availability(){return{available:false}}};
    const base=await listen(createInteractiveSpaceConsole(service,{workflow}));
    const previewResponse=await fetch(`${base}/workbench/workflows/preview`);
    expect(previewResponse.headers.get('referrer-policy')).toBe('same-origin');
    const preview=await previewResponse.text();
    expect(preview).toContain('待发布草稿');expect(preview).toContain('data-workflow-diagram');expect(publishes).toBe(0);
    const form=new URLSearchParams({csrf:hidden(preview,'csrf'),commandId:hidden(preview,'commandId'),expectedVersionId:candidate.version.id,changeReason:'Better method'});
    const post=(body:URLSearchParams,origin=base)=>fetch(`${base}/workbench/workflows/publish`,{method:'POST',body,headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual'});
    expect((await post(form,'http://evil.example')).status).toBe(403);
    expect((await post(form,'null')).status).toBe(403);
    expect((await post(new URLSearchParams({...Object.fromEntries(form),expectedVersionId:'wrong'}))).status).toBe(409);
    expect(publishes).toBe(0);
    const result=await post(form);expect(result.status).toBe(303);expect(result.headers.get('location')).toBe('/spaces/space/workflows/candidate-v2/content');expect(publishes).toBe(1);
    expect(overview.workflows).toHaveLength(0);
  });
  it('renders generic case/run/review forms and reuses exact-version read routes', async () => {
    const { service, workflow } = fixture();
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const home = await (await fetch(`${base}/workbench`)).text();
    expect(home).toContain('&lt;Useful case&gt;');
    expect(home).toContain('Case title');
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    expect(page).toContain('/spaces/space/assets/draft-v1');
    const evidence=await (await fetch(`${base}/workbench/cases/case-1?tab=evidence`)).text();
    expect(evidence).toContain('/spaces/space/sessions/session-1');
    expect(page).toContain('Agent评价 review-1');
    expect(page).toContain('保存评价并接受结果');
    expect(page.indexOf('Readable draft')).toBeLessThan(page.indexOf('发起 Content 新运行'));
    expect(page).toContain('<details class="card"><summary>发起 Content 新运行</summary>');
    const [initial, rerun] = forms(page, '/workbench/cases/case-1/runs');
    expect(initial).toContain('name="format"');
    expect(rerun).not.toContain('name="format"');
    expect((await fetch(`${base}/spaces/space/assets/draft-v1`)).status).toBe(200);
  });

  it('requires same-origin CSRF POST and redirects after explicit actions', async () => {
    const { service, workflow, calls } = fixture();
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const home = await (await fetch(`${base}/workbench`)).text();
    const body = new URLSearchParams({ csrf: hidden(home, 'csrf'), commandId: hidden(home, 'commandId'), title: 'New case' });
    const post = (url: string, form: URLSearchParams, headers: Record<string, string> = {}) => fetch(`${base}${url}`, {
      method: 'POST', body: form, headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, redirect: 'manual',
    });
    expect((await post('/workbench/cases', body, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/workbench/cases', new URLSearchParams({ ...Object.fromEntries(body), csrf: 'wrong' }))).status).toBe(403);
    expect(calls.case).toBe(0);
    const result = await post('/workbench/cases', body);
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/workbench/cases/case-1');
    expect(calls.case).toBe(1);
    await fetch(`${base}/workbench/cases/case-1`);
    expect(calls.case).toBe(1);
  });

  it('binds rerun and review to the selected case, run and draft, with explicit acceptance', async () => {
    const { service, workflow, calls } = fixture();
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    const [initialForm, rerunForm] = forms(page, '/workbench/cases/case-1/runs');
    const reviewForm = forms(page, '/workbench/cases/case-1/reviews')[0]!;
    const csrf = hidden(page, 'csrf');
    const post = (route: string, values: Record<string, string>) => fetch(`${base}${route}`, { method: 'POST', redirect: 'manual',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...values }) });
    const missingInitial = await post('/workbench/cases/case-1/runs', { commandId: hidden(initialForm!, 'commandId'), hypothesis: 'Initial' });
    expect(missingInitial.status).toBe(400);
    const missingFeedback = await post('/workbench/cases/case-1/runs', { commandId: hidden(rerunForm!, 'commandId'), baselineRunId: 'run-1', baselineReviewId: 'review-1', hypothesis: 'Improve ending' });
    expect(missingFeedback.status).toBe(400);
    const run = await post('/workbench/cases/case-1/runs', { commandId: hidden(rerunForm!, 'commandId'), baselineRunId: 'run-1', baselineReviewId: 'review-1', hypothesis: 'Improve ending', feedback: 'Needs a stronger close' });
    expect(run.status).toBe(303);
    expect(calls.lastRun).toMatchObject({ baselineRunId: 'run-1', baselineAssetVersionId: 'draft-v1', baselineReviewId: 'review-1', hypothesis: 'Improve ending' });
    const review = await post('/workbench/cases/case-1/reviews', { commandId: hidden(reviewForm, 'commandId'), runId: 'run-1', assetVersionId: 'draft-v1', good: 'Clear', bad: 'Long', improvement: 'Baseline', unresolved: 'Ending', decision: 'accept' });
    expect(review.status).toBe(303);
    expect(calls.lastReview).toMatchObject({ assetVersionId: 'draft-v1', accept: true, answers: { good: 'Clear', bad: 'Long' } });
    const mismatch = await post('/workbench/cases/case-1/runs', { commandId: hidden(rerunForm!, 'commandId'), baselineRunId: 'run-1', baselineReviewId: 'missing', hypothesis: 'Improve ending', feedback: 'Needs a stronger close' });
    expect(mismatch.status).toBe(400);
    expect(calls.run).toBe(1);
  });

  it('bounds form size and displays only declared host validation errors', async () => {
    const { service, workflow, calls } = fixture();
    workflow.startRun = async () => { calls.run++; throw new InteractiveConsoleError(409, '先补齐必要材料'); };
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    const csrf = hidden(page, 'csrf'), commandId = hidden(forms(page, '/workbench/cases/case-1/runs')[0]!, 'commandId');
    const post = (values: Record<string, string>) => fetch(`${base}/workbench/cases/case-1/runs`, { method: 'POST', redirect: 'manual',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, commandId, ...values }) });
    const tooLarge = await post({ hypothesis: 'x'.repeat(70_000), format: 'article' });
    expect(tooLarge.status).toBe(413);
    expect(calls.run).toBe(0);
    const blocked = await post({ hypothesis: 'Make it clearer', format: 'article' });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('先补齐必要材料');
  });

  it('links live session history while preventing feedback on nonfinal drafts', async () => {
    const { service, workflow, calls } = fixture();
    workflow.runStatus = async () => ({ state: 'running', progress: 'Writing', reviewableAssetVersionId: null,
      sessions: [{ sessionId: 'session-live', label: 'Writing history' }] });
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    const evidence=await (await fetch(`${base}/workbench/cases/case-1?tab=evidence`)).text();
    expect(evidence).toContain('/spaces/space/sessions/session-live');
    expect(evidence).toContain('Writing history');
    expect(page).toContain('本次尚无最终候选结果');
    expect(page).not.toContain('http-equiv="refresh"');
    const process=await (await fetch(`${base}/workbench/cases/case-1?tab=process`)).text();
    expect(process).toContain('/spaces/space/assets/draft-v1');
    expect(forms(page, '/workbench/cases/case-1/reviews')).toHaveLength(0);
    expect(forms(page, '/workbench/cases/case-1/runs')[0]).toBeDefined();
    const csrf = hidden(page, 'csrf');
    const response = await fetch(`${base}/workbench/cases/case-1/reviews`, { method: 'POST', redirect: 'manual',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, commandId: 'a'.repeat(32), runId: 'run-1', assetVersionId: 'draft-v1',
        good: 'a', bad: 'b', improvement: 'c', unresolved: 'd', decision: 'review' }) });
    expect(response.status).toBe(409);
    expect(calls.review).toBe(0);
  });

  it('shows a review form only for the exact final version supplied by the host', async () => {
    const { service, workflow, overview, calls } = fixture();
    overview.assets.unshift({ ...overview.assets[0]!, id: 'draft-mid', version: 0 });
    workflow.runStatus = async () => ({ state: 'needs_review', reviewableAssetVersionId: 'draft-v1' });
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    const process=await (await fetch(`${base}/workbench/cases/case-1?tab=process`)).text();
    expect(process).toContain('/spaces/space/assets/draft-mid');
    expect(page).not.toContain('name="assetVersionId" value="draft-mid"');
    expect(page).toContain('/spaces/space/assets/draft-v1');
    expect(forms(page, '/workbench/cases/case-1/reviews')).toHaveLength(1);
    const response = await fetch(`${base}/workbench/cases/case-1/reviews`, { method: 'POST', redirect: 'manual',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: hidden(page, 'csrf'), commandId: 'b'.repeat(32), runId: 'run-1', assetVersionId: 'draft-mid',
        good: 'a', bad: 'b', improvement: 'c', unresolved: 'd', decision: 'review' }) });
    expect(response.status).toBe(409);
    expect(calls.review).toBe(0);
  });

  it('labels separate logical drafts by run output order and folds technical identity and sessions', async () => {
    const { service, workflow, overview } = fixture();
    overview.assets.push({ ...overview.assets[0]!, id: 'draft-v2', assetId: 'another-logical-draft', version: 1,
      createdAt: '2026-10-05T00:00:01Z' });
    workflow.runStatus = async () => ({ state: 'needs_review', reviewableAssetVersionId: 'draft-v2',
      sessions: [{ sessionId: 'session-2', label: 'Second writing pass' }] });
    const base = await listen(createInteractiveSpaceConsole(service, { workflow }));
    const page = await (await fetch(`${base}/workbench/cases/case-1`)).text();
    const process=await (await fetch(`${base}/workbench/cases/case-1?tab=process`)).text();
    expect(process).toContain('第 1 次产出');
    expect(process).toContain('第 2 次产出');
    expect(page).toContain('name="assetVersionId" value="draft-v2"');
    expect(page).not.toContain('阅读稿件 · 版本 1');
    const evidence=await (await fetch(`${base}/workbench/cases/case-1?tab=evidence`)).text();
    expect(evidence).toContain('/spaces/space/sessions/session-2');
    expect(forms(page, '/workbench/cases/case-1/reviews')).toHaveLength(1);
  });
});
