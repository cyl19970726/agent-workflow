export interface ToolFieldSummary { name: string; type: string; required: boolean; choices: string[]; moreChoices: boolean }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const typeLabels: Record<string, string> = { string: '字符串', number: '数字', integer: '整数', boolean: '布尔值', object: '对象', array: '列表' };

/** A small readable projection of a recorded JSON Schema; the exact schema stays available below. */
export function toolFieldSummaries(schema: unknown): ToolFieldSummary[] {
  const root = record(schema);
  const properties = record(root?.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(root?.required) ? root.required.filter((part): part is string => typeof part === 'string') : []);
  return Object.entries(properties).map(([name, raw]) => {
    const field = record(raw);
    const values = Array.isArray(field?.enum) ? field.enum.filter((part): part is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof part)).map(String) : [];
    const type = typeof field?.type === 'string' ? typeLabels[field.type] || field.type : '类型未记录';
    return { name, type, required: required.has(name), choices: values.slice(0, 10), moreChoices: values.length > 10 };
  });
}
