# Workflow Space contracts

`@signal-room/workflow-space-contracts` contains serializable schema and node-storage declarations. It has no database or consumer-specific schema. The registry validates JSON Schema draft 2020-12 with Ajv. Published contracts include the exact transitive schema closure and a hash; services can store the result as JSON and call `verifyStorageContract` when loading it.

```ts
import { JSON_SCHEMA_DIALECT, SchemaRegistry, publishStorageContract } from '@signal-room/workflow-space-contracts';

const registry = new SchemaRegistry();
const note = registry.registerSchema({
  namespace: 'example/note', revision: '1', dialect: JSON_SCHEMA_DIALECT,
  schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
});
const contract = publishStorageContract(registry, {
  workflowVersion: 'example-v1',
  nodes: {
    writer: {
      actorKinds: ['agent'], inputs: {},
      outputs: { note: { schema: note, requiredInputs: [], appendVersions: true, initialState: 'candidate' } },
      actions: ['appendOutputVersion'],
    },
  },
  stateRules: [],
});
```

External `$ref` values use `aw://schema/<namespace>@<revision>#/...` and must name a declared dependency with an exact hash. Local `#` references are allowed. HTTP references, dynamic references, and nested `$id` values are rejected; no remote schema is fetched. A namespace and revision cannot be overwritten with different content. `validateNodeWrite` checks the complete persisted payload, required input-slot dependencies, output permissions, and append permissions. Host services still bind exact asset-version IDs, actor identity, space membership, and transaction boundaries. `projectBoundInput` returns only declared JSON Pointer fields; use `*` within array paths.
