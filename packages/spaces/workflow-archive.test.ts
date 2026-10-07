import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';

vi.mock('@signal-room/workflow-postgres',async importOriginal=>({
  ...await importOriginal<typeof import('@signal-room/workflow-postgres')>(),
  migratePostgresWorkflowStore:vi.fn(async()=>{}),
}));

describe('workflow archival lifecycle metadata',()=>{
  it('adds an idempotent nullable column without rewriting frozen workflow data',async()=>{
    const queries:string[]=[];
    const client={query:async(sql:string)=>{queries.push(sql);return {rows:[]};},release:()=>{}};
    const pool={connect:async()=>client} as unknown as Pool;
    await migrateWorkflowSpaces(pool);
    await migrateWorkflowSpaces(pool);
    const ddl=queries.filter(sql=>sql.includes('CREATE TABLE IF NOT EXISTS ws_workflows'));
    expect(ddl).toHaveLength(2);
    for(const sql of ddl){
      expect(sql).toContain('archival jsonb');
      expect(sql).toContain('ALTER TABLE ws_workflows ADD COLUMN IF NOT EXISTS archival jsonb');
      expect(sql).toContain('FOREIGN KEY(space_id,predecessor_id) REFERENCES ws_workflows(space_id,id)');
      expect(sql).not.toMatch(/UPDATE ws_workflows/i);
    }
  });

  it('hides archived versions from overview while exact reads preserve their document',async()=>{
    const archived={id:'v1',hash:'frozen-hash',predecessorId:undefined,entrypoints:{}};
    const current={id:'v2',hash:'current-hash',predecessorId:'v1',entrypoints:{}};
    const space={id:'space',purpose:'Production',owner:'alice',status:'active',createdAt:'2026-01-01T00:00:00Z'};
    const queries:string[]=[];
    const pool={query:async(sql:string)=>{
      queries.push(sql);
      if(sql.includes('FROM ws_members'))return {rows:[{role:'viewer',document:space}]};
      if(sql.includes('FROM ws_workflows')){
        if(sql.includes('AND id=$2'))return {rows:[{document:archived}]};
        return {rows:sql.includes('archival IS NULL')?[{document:current}]:[{document:archived},{document:current}]};
      }
      return {rows:[]};
    }} as unknown as Pool;
    const service=new WorkflowSpaceService(pool,{} as ConstructorParameters<typeof WorkflowSpaceService>[1],{id:'alice',kind:'human'});
    expect((await service.overview('space')).workflows).toEqual([current]);
    expect(await service.readWorkflowVersion('space','v1')).toEqual(archived);
    expect(queries).toContain('SELECT document FROM ws_workflows WHERE space_id=$1 AND archival IS NULL');
    expect(queries).toContain('SELECT document FROM ws_workflows WHERE space_id=$1 AND id=$2');
  });
});
