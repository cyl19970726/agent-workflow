/** Handler-local, bounded read reuse. Authorization must be checked before every get. */
export class ScopedReadCache {
  private readonly scopes=new Map<string,true>();
  private readonly reads=new Map<string,{scope:string;promise:Promise<unknown>;expiresAt:number}>();
  constructor(private readonly clock:()=>number,private readonly maxScopes=32,private readonly maxReads=128){}
  static scopeKey(value:{principal:{kind:string;id:string};cacheScope:string;spaceId:string;workflowId:string;entrypoint:string;adoptionSlot?:string}):string{
    return JSON.stringify([value.principal.kind,value.principal.id,value.cacheScope,value.spaceId,value.workflowId,value.entrypoint,value.adoptionSlot??null]);
  }
  clearScope(scope:string):void{
    this.scopes.delete(scope);
    for(const [key,value] of this.reads)if(value.scope===scope)this.reads.delete(key);
  }
  private touchScope(scope:string):void{
    this.scopes.delete(scope);this.scopes.set(scope,true);
    while(this.scopes.size>this.maxScopes){const oldest=this.scopes.keys().next().value;if(oldest)this.clearScope(oldest);}
  }
  get<T>(scope:string,resource:string,ttlMs:number|((value:T)=>number),load:()=>Promise<T>,onAccess?:(hit:boolean)=>void):Promise<T>{
    this.touchScope(scope);
    const key=JSON.stringify([scope,resource]);
    const prior=this.reads.get(key);
    if(prior&&prior.expiresAt>this.clock()){
      onAccess?.(true);
      this.reads.delete(key);this.reads.set(key,prior);
      return prior.promise as Promise<T>;
    }
    onAccess?.(false);
    if(prior)this.reads.delete(key);
    const record:{scope:string;promise:Promise<unknown>;expiresAt:number}={scope,promise:Promise.resolve(),expiresAt:Number.POSITIVE_INFINITY};
    const promise=Promise.resolve().then(load).then(value=>{
      record.expiresAt=this.clock()+Math.max(0,typeof ttlMs==='function'?ttlMs(value):ttlMs);
      return value;
    },error=>{
      if(this.reads.get(key)===record)this.reads.delete(key);
      throw error;
    });
    record.promise=promise;
    this.reads.set(key,record);
    while(this.reads.size>this.maxReads){const oldest=this.reads.keys().next().value;if(oldest)this.reads.delete(oldest);}
    return promise;
  }
}
