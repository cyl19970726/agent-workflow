import {describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import {WorkflowSpaceService} from './service.js';

describe('light Space summary read',()=>{
  it('uses scoped aggregate SQL and the current adoption head without loading document history',async()=>{
    const calls:Array<{sql:string;params:unknown[]}>=[];
    const space={id:'space',purpose:'Saved production',owner:'alice',status:'active',createdAt:'2026-01-01T00:00:00Z'};
    const pool={query:async(sql:string,params:unknown[])=>{
      calls.push({sql,params});
      if(sql.includes('FROM ws_members'))return {rows:[{role:'viewer',document:space}]};
      return {rows:[{version_count:2,case_count:4,run_count:3,asset_count:17,latest_version_id:'latest-content',adopted_version_id:'adopted-content'}]};
    }} as unknown as Pool;
    const service=new WorkflowSpaceService(pool,{} as ConstructorParameters<typeof WorkflowSpaceService>[1],{id:'alice',kind:'human'});
    const result=await service.spaceSummary('space',{workflowId:'content',entrypoint:'content',adoptionSlot:'published'});
    expect(result).toEqual({space,versionCount:2,caseCount:4,runCount:3,assetCount:17,latestVersionId:'latest-content',adoptedVersionId:'adopted-content'});
    expect(calls).toHaveLength(2);expect(calls[0]?.params).toEqual(['space','alice']);
    expect(calls[1]?.params).toEqual(['space','content','content','published']);
    expect(calls[1]?.sql).toContain("document->'entrypoints'->$2->>'workflowId'=$3");
    expect(calls[1]?.sql).toContain('archival IS NULL');
    expect(calls[1]?.sql).toContain("r.document->>'entrypoint'=$2");
    expect(calls[1]?.sql).toContain('JOIN scoped_versions v ON v.id=a.target_workflow_id');
    expect(calls[1]?.sql).toContain('FROM ws_adoption_heads h');
    expect(calls[1]?.sql).not.toContain('SELECT document FROM ws_asset_versions');
    expect(calls[1]?.sql).not.toContain('ws_sessions');
  });
  it('does not query aggregates when membership is denied',async()=>{
    let queries=0;
    const pool={query:async()=>{queries++;return {rows:[]};}} as unknown as Pool;
    const service=new WorkflowSpaceService(pool,{} as ConstructorParameters<typeof WorkflowSpaceService>[1],{id:'outsider',kind:'human'});
    await expect(service.spaceSummary('space',{workflowId:'content',entrypoint:'content'})).rejects.toThrow('Space access denied');
    expect(queries).toBe(1);
  });
});
