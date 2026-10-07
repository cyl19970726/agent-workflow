import {describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import {WorkflowSpaceService} from './service.js';

describe('exact review target lookup',()=>{
  it('queries reviewed assetVersionIds rather than treating a cited evidence asset as a target',async()=>{
    const target={id:'baseline-review',spaceId:'s',runId:'baseline-run',assetVersionIds:['baseline-draft'],evidence:['baseline-draft']};
    const evidenceOnly={id:'candidate-review',spaceId:'s',runId:'candidate-run',assetVersionIds:['candidate-draft'],evidence:['baseline-draft']};
    const queries:Array<{sql:string;params:unknown[]}>=[];
    const pool={query:async(sql:string,params:unknown[])=>{
      queries.push({sql,params});
      if(sql.includes('FROM ws_members'))return {rows:[{role:'viewer',document:{id:'s',status:'active'}}]};
      // ws_review_assets indexes both targets and cited evidence. The SQL target predicate
      // must remove the candidate review before it reaches the API's strict identity check.
      if(sql.includes('FROM ws_review_assets'))return {rows:[target,evidenceOnly].filter(review=>review.assetVersionIds.includes(String(params[1]))).map(document=>({document}))};
      throw Error('Unexpected read');
    }} as unknown as Pool;
    const service=new WorkflowSpaceService(pool,{} as ConstructorParameters<typeof WorkflowSpaceService>[1],{id:'alice',kind:'human'});
    Object.assign(service,{asset:async()=>({id:'baseline-draft'})});
    const reviews=await service.reviewsForAsset('s','baseline-draft');
    expect(reviews.map(review=>review.id)).toEqual(['baseline-review']);
    expect(queries[1]?.params).toEqual(['s','baseline-draft']);
    expect(queries[1]?.sql).toContain("r.document->'assetVersionIds' ? $2::text");
  });
});
