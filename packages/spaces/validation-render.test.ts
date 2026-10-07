import {describe,expect,it} from 'vitest';
import {validationDetailBody,validationListBody} from './validation-render.js';
import type {SpaceOverview} from './types.js';

const data={space:{id:'space'},workflows:[{id:'baseline-version',revision:'same-name',changeReason:'旧方法：增加背景',entrypoints:{content:{nodeDefinitions:{writer:{model:'model-a'}}}}},{id:'candidate-version',revision:'same-name',changeReason:'新方法：改写结构',entrypoints:{content:{nodeDefinitions:{writer:{model:'model-b'}}}}}],cases:[{id:'case-1',title:'案例 <一>'}],assets:[],adoptions:[],runs:[],reviews:[]} as unknown as SpaceOverview;
const plan={id:'plan-1',status:'frozen',kind:'prospective',question:'两版哪个更好？',hypothesis:'结构改善',baseline:{workflowVersionId:'baseline-version',entrypoint:'content'},candidate:{workflowVersionId:'candidate-version',entrypoint:'content'},cases:[{caseId:'case-1',inputManifestId:'manifest-1',repeats:2}],standard:{id:'quality',revision:'1',content:'可读性'},judges:[{kind:'human',id:'person'}],expectedVariables:['方法'],exclusionRules:[],entries:[{id:'base-1',side:'baseline',caseId:'case-1',inputManifestId:'manifest-1',repeat:1,workflowVersionId:'baseline-version',entrypoint:'content'},{id:'cand-1',side:'candidate',caseId:'case-1',inputManifestId:'manifest-1',repeat:1,workflowVersionId:'candidate-version',entrypoint:'content'},{id:'base-2',side:'baseline',caseId:'case-1',inputManifestId:'manifest-1',repeat:2,workflowVersionId:'baseline-version',entrypoint:'content'},{id:'cand-2',side:'candidate',caseId:'case-1',inputManifestId:'manifest-1',repeat:2,workflowVersionId:'candidate-version',entrypoint:'content'}]};

describe('validation pages',()=>{
  it('offers exact published methods, case manifests and frozen criteria as forms',()=>{
    const page=validationListBody({plans:[],data,manifests:[{id:'manifest-1',caseId:'case-1',assets:{brief:'asset-1'}}],humanJudgeId:'person'} as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('baseline-version|content');expect(page).toContain('candidate-version|content');expect(page).toContain('manifest:case-1');expect(page).toContain('repeats:case-1');expect(page).toContain('name="standardContent"');expect(page).toContain('案例 &lt;一&gt;');expect(page).not.toContain('案例 <一>');
  });
  it('keeps failed and missing repeated entries visible and separates case from entry count',()=>{
    const summary={plan,data,humanJudgeId:'person',entries:[{entry:plan.entries[0],status:'failed',attempts:[{attempt:1,runId:'run-failed',status:'failed',reviews:[]}]},{entry:plan.entries[1],status:'missing',attempts:[]},{entry:plan.entries[2],status:'needs_review',attempts:[{attempt:1,runId:'run-ready',status:'completed',reviews:[]}]},{entry:plan.entries[3],status:'canceled',attempts:[{attempt:1,runId:'run-canceled',status:'canceled',reviews:[]}]}],cases:[{caseId:'case-1',baselineEntryIds:['base-1','base-2'],candidateEntryIds:['cand-1','cand-2']}],totals:{cases:1,entries:4,byStatus:{failed:1,missing:1,needs_review:1,canceled:1}},issues:[],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('1 个不同案例 · 4 个计划项');expect(page).toContain('失败 1');expect(page).toContain('取消 1');expect(page).toContain('未启动 1');expect(page).toContain('run-failed');expect(page).toContain('再次排队');expect(page).toContain('质量结论未知');expect(page).toContain('旧方法：增加背景');expect(page).toContain('model-b');
  });
  it('uses the exact adoption head when history timestamps tie',()=>{
    const prior={id:'old-pointer',slot:'primary',target:{kind:'workflow',id:'baseline-version'},createdAt:'2026-10-06T00:00:00Z',reason:'Old'};
    const head={id:'exact-head',slot:'primary',target:{kind:'workflow',id:'candidate-version'},createdAt:'2026-10-06T00:00:00Z',reason:'Current'};
    const summary={plan,data:{...data,adoptions:[head,prior]},currentAdoptions:[head],humanJudgeId:'person',entries:[],cases:[],totals:{cases:0,entries:0,byStatus:{}},issues:[],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('name="expectedPrevious" value="exact-head"');
    expect(page).toContain('当前采用：新方法：改写结构');
  });
  it('offers only coordinator-approved deliverables for review',()=>{
    const asset=(id:string)=>({id,source:{kind:'node',runId:'run-1'},schema:{namespace:'content/draft'}});
    const summary={plan,data:{...data,assets:[asset('draft-final'),asset('research-note')]},deliverableAssetVersionIds:['draft-final'],humanJudgeId:'person',entries:[{entry:plan.entries[0],status:'needs_review',attempts:[{attempt:1,runId:'run-1',status:'completed',reviews:[]}]}],cases:[],totals:{cases:1,entries:1,byStatus:{needs_review:1}},issues:[],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('<option value="draft-final">');
    expect(page).not.toContain('<option value="research-note">');
  });
  it('groups each repeat into stable baseline and candidate columns with direct reading and evidence links',()=>{
    const entry=(index:number)=>({entry:plan.entries[index],status:'needs_review',attempts:index===0?[{attempt:1,runId:'run-1',status:'completed',reviews:[]}]:[]});
    const summary={plan,data:{...data,assets:[{id:'draft-final',source:{kind:'node',runId:'run-1'},schema:{namespace:'content/draft'}}]},deliverableAssetVersionIds:['draft-final'],humanJudgeId:'person',entries:[entry(3),entry(1),entry(0),entry(2)],cases:[{caseId:'case-1',baselineEntryIds:['base-1','base-2'],candidateEntryIds:['cand-1','cand-2']}],totals:{cases:1,entries:4,byStatus:{}},issues:[{id:'issue-1',kind:'observation',category:'structure',text:'Weak ending',evidence:[{entryId:'base-1',caseId:'case-1',runId:'run-1'}]}],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    const groups=[...page.matchAll(/<section class="validation-group">([\s\S]*?)<\/section>/g)].map(match=>match[1]!);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain('案例 &lt;一&gt; · 第 1 次');
    expect(groups[0]!.indexOf('条目 ID：<code>base-1')).toBeLessThan(groups[0]!.indexOf('条目 ID：<code>cand-1'));
    expect(groups[1]).toContain('第 2 次');
    expect(page).toContain('/spaces/space/assets/draft-final?run=run-1">阅读本次结果');
    expect(page).toContain('/spaces/space/workflows/baseline-version/content');
    expect(page).toContain('/workbench/cases/case-1?run=run-1">案例 &lt;一&gt; · 基线 · 第 1 次 · 查看运行');
  });
  it('keeps unverified Agent reviews readable without counting them as comparison coverage',()=>{
    const review=(id:string,runId:string)=>({id,runId,judge:{kind:'agent',id:'agent-a',sessionId:`session-${id}`},answers:{good:'Clear',bad:'Weak',improvement:'Some',unresolved:'Ending'}});
    const baseline=review('review-base','run-base'),candidate=review('review-candidate','run-candidate');
    const evidence={reviewId:candidate.id,verified:false,differences:{tools:{expected:[{name:'read'}],observed:[{name:'write'}]}}};
    const agentPlan={...plan,judges:[{kind:'agent',id:'agent-a',instructions:'Judge the ending',tools:[{name:'read',description:'Read evidence',parameters:{type:'object'}}],configuration:{temperature:0}}]};
    const summary={plan:agentPlan,data,humanJudgeId:'person',entries:[{entry:plan.entries[0],status:'reviewed',requiredJudgeCoverage:[{kind:'agent',id:'agent-a',reviewIds:[baseline.id],unverifiedReviewIds:[]}],attempts:[{attempt:1,runId:'run-base',status:'completed',reviews:[baseline],judgeEvidence:[{reviewId:baseline.id,verified:true,differences:{}}]}]},{entry:plan.entries[1],status:'needs_review',requiredJudgeCoverage:[{kind:'agent',id:'agent-a',reviewIds:[],unverifiedReviewIds:[candidate.id]}],attempts:[{attempt:1,runId:'run-candidate',status:'completed',reviews:[candidate],judgeEvidence:[evidence]}]}],cases:[{caseId:'case-1',baselineEntryIds:['base-1'],candidateEntryIds:['cand-1']}],totals:{cases:1,entries:2,byStatus:{reviewed:1,needs_review:1}},issues:[],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('Agent agent-a 的冻结评价策略');expect(page).toContain('Judge the ending');expect(page).toContain('Read evidence');
    expect(page).toContain('未核验');expect(page).toContain('核验原因与观察差异');expect(page).toContain('&quot;write&quot;');
    expect(page).toContain('有 1 份未核验历史评价，仍需可信评价');expect(page).toContain('评价未齐或尚无可配对评价');
    expect(page).not.toContain('action="/workbench/validation/plan-1/compare"');
  });
  it('shows queued and interrupted work in the coverage line',()=>{
    const summary={plan,data,humanJudgeId:'person',entries:[],cases:[],totals:{cases:1,plannedPairs:4,entries:8,attempts:7,byStatus:{queued:7,missing:1}},issues:[],comparisons:[]};
    const page=validationDetailBody(summary as never,'<input type="hidden" name="csrf" value="token">');
    expect(page).toContain('未启动 1 · 排队中 7');
    expect(page).toContain('8 是两版计划项数，7 是全部尝试数');
    const later=validationDetailBody({...summary,totals:{...summary.totals,byStatus:{queued:5,missing:1,interrupted:1,cancel_requested:1}}} as never,'<input type="hidden" name="csrf" value="token">');
    expect(later).toContain('排队中 5 · 等待取消 1 · 中断待核对 1');
  });
});
