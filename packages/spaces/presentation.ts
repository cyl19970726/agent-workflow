import { artifactPayloadSha256 } from '@signal-room/workflow';
import { JSON_SCHEMA_DIALECT, SchemaRegistry, type JsonValue, type FrozenSchemaRevision, type SchemaRef } from '@signal-room/workflow-space-contracts';

export type PresentationComponent = 'paragraphs' | 'fields' | 'list' | 'items' | 'table' | 'status' | 'source-links' | 'attachments';
export interface PresentationField { path: string; label: string; component: Exclude<PresentationComponent, 'fields' | 'items'>; emptyText?: string }
export type PresentationSection = PresentationField | {
  component: 'fields'; label: string; fields: PresentationField[];
} | {
  component: 'items'; path: string; label: string; headingPath?: string; fields: PresentationField[]; emptyText?: string;
};
/** Bounded display layout; item fields are JSON Pointers relative to each array item. */
export interface PresentationComparisonSection {
  path:string; label:string; kind:'paragraphs'|'items'; fields?:string[]; labels?:Record<string,string>;
}
export interface PresentationComparison {
  fields:string[]; labels?:Record<string,string>; sections?:PresentationComparisonSection[];
}
export interface PresentationAssetView {
  schema: SchemaRef; label: string; titlePath?: string; summaryPath?: string;
  /** ID of a reader supplied by the host, never executable source in this document. */
  reader?: string; sections: PresentationSection[]; compare?: PresentationComparison;
}
export interface WorkflowPresentationDraft {
  id: string; revision: string; entrypoint: string; label: string; purpose?: string;
  assetViews: PresentationAssetView[];
  /** These names are role slots resolved to exact asset versions by the host read model. */
  results: { primary: string; supporting: string[]; assessments: string[] };
  stages?: { id: string; label: string; description?: string }[];
}
export interface WorkflowPresentation extends WorkflowPresentationDraft {
  spaceId: string; hash: string; createdAt: string; createdBy: string;
}
export interface PresentationBinding {
  id: string; spaceId: string; workflowVersionId: string; entrypoint: string;
  presentationId: string; presentationRevision: string; presentationHash: string;
  actorId: string; createdAt: string;
}
export interface ResolvedPresentation { presentation: WorkflowPresentation; binding: PresentationBinding; history: PresentationBinding[] }

const textShape:JsonValue={type:'string',minLength:1};
const labelsShape:JsonValue={type:'object',additionalProperties:textShape};
const comparisonSectionShape:JsonValue={type:'object',additionalProperties:false,required:['path','label','kind'],properties:{path:textShape,label:textShape,kind:{enum:['paragraphs','items']},fields:{type:'array',minItems:1,uniqueItems:true,items:textShape},labels:labelsShape}};
const fieldShape:JsonValue={type:'object',additionalProperties:false,required:['path','label','component'],properties:{path:textShape,label:textShape,component:{enum:['paragraphs','list','table','status','source-links','attachments']},emptyText:textShape}};
/** Machine-readable shape, separately versioned from business payload schemas and workflow methods. */
export const WORKFLOW_PRESENTATION_JSON_SCHEMA:JsonValue={
  $schema:JSON_SCHEMA_DIALECT,type:'object',additionalProperties:false,required:['id','revision','entrypoint','label','assetViews','results'],
  properties:{id:textShape,revision:textShape,entrypoint:textShape,label:textShape,purpose:textShape,
    results:{type:'object',additionalProperties:false,required:['primary','supporting','assessments'],properties:{primary:textShape,supporting:{type:'array',items:textShape,uniqueItems:true},assessments:{type:'array',items:textShape,uniqueItems:true}}},
    assetViews:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['schema','label','sections'],properties:{
      schema:{type:'object',additionalProperties:false,required:['namespace','revision','hash'],properties:{namespace:textShape,revision:textShape,hash:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
      label:textShape,titlePath:textShape,summaryPath:textShape,reader:textShape,
      sections:{type:'array',items:{oneOf:[fieldShape,
        {type:'object',additionalProperties:false,required:['component','label','fields'],properties:{component:{const:'fields'},label:textShape,fields:{type:'array',minItems:1,items:fieldShape}}},
        {type:'object',additionalProperties:false,required:['component','path','label','fields'],properties:{component:{const:'items'},path:textShape,label:textShape,headingPath:textShape,emptyText:textShape,fields:{type:'array',minItems:1,items:fieldShape}}}]}},
      compare:{type:'object',additionalProperties:false,required:['fields'],properties:{fields:{type:'array',minItems:1,uniqueItems:true,items:textShape},labels:labelsShape,sections:{type:'array',items:comparisonSectionShape}}},
    }}},
    stages:{type:'array',items:{type:'object',additionalProperties:false,required:['id','label'],properties:{id:textShape,label:textShape,description:textShape}}},
  },
};
const presentationShapeRegistry=new SchemaRegistry();
const presentationShape= presentationShapeRegistry.registerSchema({namespace:'workflow/presentation',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:WORKFLOW_PRESENTATION_JSON_SCHEMA});

const fail = (message: string): never => { throw new Error(`Invalid workflow presentation: ${message}`); };
const object = (value: unknown, location: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`${location} must be an object`);
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[], location: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${location} has unsupported property ${key}`);
};
const nonempty = (value: unknown, location: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(`${location} must be a nonempty string`);
  return value;
};
const strings = (value: unknown, location: string): string[] => {
  if (!Array.isArray(value)) return fail(`${location} must be an array`);
  return value.map((item, i) => nonempty(item, `${location}[${i}]`));
};
const unique = (values: string[], location: string): void => {
  if (new Set(values).size !== values.length) fail(`${location} contains duplicates`);
};
function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === undefined) return fail('definition must contain only JSON data');
  const record = value as object;
  if (seen.has(record)) fail('definition contains a cycle');
  if (!Array.isArray(record) && Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) fail('definition must contain only plain JSON objects');
  seen.add(record);
  for (const item of Object.values(record)) assertJson(item, seen);
  seen.delete(record);
}

/** Deliberately bounded JSON Pointer subset: object property segments only. */
export function presentationPointer(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') return fail(`unsupported field path ${String(path)}`);
  const parts = path.slice(1).split('/');
  for (const part of parts) {
    if (!part || part === '*' || /^\d+$/.test(part) || /~(?![01])/.test(part)) fail(`unsupported field path ${path}`);
  }
  return parts.map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

type Shape = Record<string, unknown>;
function schemaAt(root: unknown, path: string): Shape {
  let node = object(root, 'schema');
  for (const segment of presentationPointer(path)) {
    if ('$ref' in node || 'allOf' in node || 'anyOf' in node || 'oneOf' in node || 'if' in node || 'then' in node || 'else' in node || 'not' in node || 'patternProperties' in node) {
      fail(`complex schema at ${path}; use a registered reader`);
    }
    if (node.type !== 'object' || !node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      fail(`cannot resolve ${path} through a non-object or open schema; use a registered reader`);
    }
    const child = (node.properties as Record<string, unknown>)[segment];
    if (child === undefined) fail(`field ${path} does not exist in frozen schema`);
    node = object(child, `schema field ${path}`);
  }
  if ('$ref' in node || 'allOf' in node || 'anyOf' in node || 'oneOf' in node || 'if' in node || 'then' in node || 'else' in node || 'not' in node) {
    fail(`complex schema at ${path}; use a registered reader`);
  }
  return node;
}
function itemSchema(schema: Shape, path: string): Shape {
  if (schema.type !== 'array' || !schema.items) fail(`${path} must be an array with a defined item schema`);
  return object(schema.items, `items of ${path}`);
}
function checkComponent(component: PresentationComponent, schema: Shape, path: string): void {
  const type = schema.type;
  const accepted: Record<PresentationComponent, string[]> = {
    paragraphs: ['string', 'array'], fields: ['object'], list: ['array'], items: ['array'],
    table: ['array'], status: ['string', 'boolean', 'number'], 'source-links': ['array'], attachments: ['array'],
  };
  if (!accepted[component].includes(String(type))) fail(`${component} cannot display ${path} with schema type ${String(type)}`);
  if (component === 'paragraphs' && type === 'array' && itemSchema(schema, path).type !== 'string') fail(`paragraphs requires string items at ${path}`);
  if (component === 'items' && itemSchema(schema, path).type !== 'object') fail(`items requires object items at ${path}`);
  if(component==='table'&&itemSchema(schema,path).type!=='object')fail(`table requires object items at ${path}`);
  if(component==='source-links'&&itemSchema(schema,path).type!=='string')fail(`source-links requires string identifiers at ${path}`);
  if(component==='attachments'){const item=itemSchema(schema,path);if(item.type!=='string'&&(item.type!=='object'||schemaAt(item,'/id').type!=='string'))fail(`attachments requires managed blob identifiers at ${path}`);}
}
function checkField(field: unknown, schema: Shape, location: string): void {
  const value = object(field, location);
  keys(value, ['path', 'label', 'component', 'emptyText'], location);
  const path = nonempty(value.path, `${location}.path`);
  nonempty(value.label, `${location}.label`);
  if (value.emptyText !== undefined) nonempty(value.emptyText, `${location}.emptyText`);
  if (!['paragraphs', 'list', 'table', 'status', 'source-links', 'attachments'].includes(String(value.component))) fail(`unknown field component ${String(value.component)}`);
  checkComponent(value.component as PresentationComponent, schemaAt(schema, path), path);
}
function checkSection(section: unknown, schema: Shape, location: string): void {
  const value = object(section, location);
  if (value.component === 'fields') {
    keys(value, ['component', 'label', 'fields'], location);
    nonempty(value.label, `${location}.label`);
    if (!Array.isArray(value.fields) || !value.fields.length) fail(`${location}.fields must be a nonempty array`);
    (value.fields as unknown[]).forEach((field, i) => checkField(field, schema, `${location}.fields[${i}]`));
  } else if (value.component === 'items') {
    keys(value, ['component', 'path', 'label', 'headingPath', 'fields', 'emptyText'], location);
    const path = nonempty(value.path, `${location}.path`);
    nonempty(value.label, `${location}.label`);
    if (value.emptyText !== undefined) nonempty(value.emptyText, `${location}.emptyText`);
    const items = itemSchema(schemaAt(schema, path), path);
    if (items.type !== 'object') fail(`items requires object items at ${path}`);
    if (value.headingPath !== undefined) checkComponent('status', schemaAt(items, nonempty(value.headingPath, `${location}.headingPath`)), `${path} heading`);
    if (!Array.isArray(value.fields) || !value.fields.length) fail(`${location}.fields must be a nonempty array`);
    (value.fields as unknown[]).forEach((field, i) => checkField(field, items, `${location}.fields[${i}]`));
  } else checkField(value, schema, location);
}

/** Verify shape and meaning against exact frozen schema revisions before persistence. */
export async function validateWorkflowPresentation(draft: WorkflowPresentationDraft, registry: SchemaRegistry,
  readerIds: readonly string[] = [], resultRoleIds?: readonly string[]): Promise<string> {
  // JSON roundtrip rejects code and unsupported values before hashing or storing the definition.
  assertJson(draft);
  let serial: WorkflowPresentationDraft;
  try {
    const serialized = JSON.stringify(draft);
    if (serialized === undefined) fail('definition must be serializable JSON');
    serial = JSON.parse(serialized) as WorkflowPresentationDraft;
  } catch { return fail('definition must be serializable JSON'); }
  if (JSON.stringify(serial) !== JSON.stringify(draft)) fail('definition must be serializable JSON');
  const data = object(serial, 'definition');
  keys(data, ['id', 'revision', 'entrypoint', 'label', 'purpose', 'assetViews', 'results', 'stages'], 'definition');
  for (const field of ['id', 'revision', 'entrypoint', 'label'] as const) nonempty(data[field], field);
  if (data.purpose !== undefined) nonempty(data.purpose, 'purpose');
  const results = object(data.results, 'results');
  keys(results, ['primary', 'supporting', 'assessments'], 'results');
  const roleNames = [nonempty(results.primary, 'results.primary'), ...strings(results.supporting, 'results.supporting'), ...strings(results.assessments, 'results.assessments')];
  unique(roleNames, 'result roles');
  if (resultRoleIds) for (const role of roleNames) if (!resultRoleIds.includes(role)) fail(`result role ${role} is not deployed`);
  if (!Array.isArray(data.assetViews) || !data.assetViews.length) fail('assetViews must be a nonempty array');
  const viewKeys: string[] = [];
  for (const [i, raw] of (data.assetViews as unknown[]).entries()) {
    const location = `assetViews[${i}]`, view = object(raw, location);
    keys(view, ['schema', 'label', 'titlePath', 'summaryPath', 'reader', 'sections', 'compare'], location);
    const ref = object(view.schema, `${location}.schema`);
    keys(ref, ['namespace', 'revision', 'hash'], `${location}.schema`);
    const frozen: FrozenSchemaRevision = registry.resolve(ref as unknown as SchemaRef);
    viewKeys.push(`${frozen.namespace}@${frozen.revision}`);
    nonempty(view.label, `${location}.label`);
    if (view.reader !== undefined && !readerIds.includes(nonempty(view.reader, `${location}.reader`))) fail(`reader ${String(view.reader)} is not deployed`);
    if (!Array.isArray(view.sections)) fail(`${location}.sections must be an array`);
    if (!view.reader && (view.sections as unknown[]).length === 0) fail(`${location} requires sections or a deployed reader`);
    if (view.reader && ((view.sections as unknown[]).length || view.titlePath || view.summaryPath)) fail(`${location} cannot mix a dedicated reader with generic reading fields`);
    for (const field of ['titlePath', 'summaryPath'] as const) if (view[field] !== undefined) checkComponent('status', schemaAt(frozen.schema, nonempty(view[field], `${location}.${field}`)), `${location}.${field}`);
    (view.sections as unknown[]).forEach((section, n) => checkSection(section, object(frozen.schema, 'frozen schema'), `${location}.sections[${n}]`));
    if (view.compare !== undefined) {
      const compare = object(view.compare, `${location}.compare`);
      keys(compare, ['fields','labels','sections'], `${location}.compare`);
      const fields = strings(compare.fields, `${location}.compare.fields`);
      unique(fields, `${location}.compare.fields`);
      for (const path of fields) schemaAt(frozen.schema, path);
      const checkLabels=(raw:unknown,paths:string[],where:string)=>{
        if(raw===undefined) return;
        const labels=object(raw,where);
        for(const [path,label] of Object.entries(labels)) {
          if(!paths.includes(path)) fail(`${where} labels an undeclared field ${path}`);
          nonempty(label,`${where}.${path}`);
        }
      };
      checkLabels(compare.labels,fields,`${location}.compare.labels`);
      if(compare.sections!==undefined) {
        if(!Array.isArray(compare.sections)) fail(`${location}.compare.sections must be an array`);
        for(const [n,raw] of (compare.sections as unknown[]).entries()) {
          const where=`${location}.compare.sections[${n}]`,section=object(raw,where);
          keys(section,['path','label','kind','fields','labels'],where);
          const path=nonempty(section.path,`${where}.path`);
          nonempty(section.label,`${where}.label`);
          if(!['paragraphs','items'].includes(String(section.kind))) fail(`${where}.kind is unsupported`);
          const target=schemaAt(frozen.schema,path);
          const projected=section.fields===undefined?[]:strings(section.fields,`${where}.fields`);
          unique(projected,`${where}.fields`);
          if(section.fields!==undefined&&!projected.length) fail(`${where}.fields must be nonempty`);
          if(section.kind==='items'||projected.length) {
            const items=itemSchema(target,path);
            if(items.type!=='object'||!projected.length) fail(`${where} requires object items and declared fields`);
            for(const field of projected) {
              const type=schemaAt(items,field).type;
              if(!['string','number','integer','boolean'].includes(String(type))&&!(section.kind==='items'&&type==='array'&&itemSchema(schemaAt(items,field),field).type==='string')) fail(`${where} requires text or scalar item fields`);
            }
          } else checkComponent('paragraphs',target,path);
          checkLabels(section.labels,projected,`${where}.labels`);
        }
      }
    }
  }
  unique(viewKeys, 'asset views');
  if (data.stages !== undefined) {
    if (!Array.isArray(data.stages)) fail('stages must be an array');
    const stageIds = (data.stages as unknown[]).map((stage, i) => {
      const value = object(stage, `stages[${i}]`);
      keys(value, ['id', 'label', 'description'], `stages[${i}]`);
      nonempty(value.label, `stages[${i}].label`);
      if (value.description !== undefined) nonempty(value.description, `stages[${i}].description`);
      return nonempty(value.id, `stages[${i}].id`);
    });
    unique(stageIds, 'stages');
  }
  presentationShapeRegistry.validatePayload(presentationShape,serial);
  return artifactPayloadSha256(serial);
}
