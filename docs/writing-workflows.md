# 编写工作流

浏览器展示阶段时使用共享 [前端读模型](./frontend-integration.md)，不要把原始步骤、事件或 artifact URI 直接交给页面。

工作流是普通的异步 TypeScript 函数。顺序、条件与有界循环使用语言本身表达；需要记录、复用或隔离副作用的工作通过 `ctx` 方法执行。

## 定义与运行签名

当前公开签名的核心形态是：

```ts
workflow<Input, Output>(
  id: string,
  options: { revision: string },
  execute: (ctx: WorkflowContext, input: Input) => Promise<Output>,
): WorkflowDefinition<Input, Output>

runWorkflow<Input, Output>({
  workflow,
  input,
  store,
  agentRunner,
  signal?,
  resumeRunId?,
  metadata?,
  parent?,
  childDispatcher?,
}): Promise<{ run: RunRecord; output?: Output }>
```

当传入的 `AbortSignal` 被中止，运行时在检查点停止执行，并把 signal 交给 task/runner。任意用户代码不会被强制终止，task/runner 必须配合取消；跨进程取消、后代传播和轮询由宿主适配器负责。

## `WorkflowContext` 方法

以下签名以 [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) 为准。

```ts
ctx.task(key, implementation, input): Promise<Output>
ctx.agent(key, definition, input): Promise<Output>
ctx.call(key, workflow, input): Promise<Output>

ctx.mapSettled(key, inputs, {
  concurrency,
  itemKey: (input, index) => string,
}, callback): Promise<PromiseSettledResult<Output>[]>

ctx.parallel(key, branches, { concurrency }): Promise<NamedResults>
ctx.parallelSettled(key, branches, { concurrency }): Promise<NamedSettledResults>

ctx.phase(key, definition, async phaseCtx => output): Promise<Output>
phaseCtx.bindArtifact(artifact, binding): Promise<void>

ctx.validate(key, value, validator, { producerStepKey? }): Promise<ValidationResult>
ctx.publish(key, artifactType, payload, provenance?): Promise<ArtifactRef>
ctx.decide(key, decision): decision
ctx.blocked(details): WorkflowTerminal<never>
ctx.needsReview(details): WorkflowTerminal<never>
```

选择方法时可遵循这些边界：

- `task`：确定性计算或由宿主管控的副作用。实现会收到 `signal`、`idempotencyKey`、run/step/attempt ID；外部写操作应使用该幂等键。
- `agent`：通过注入的 `AgentRunner` 执行模型。Agent 结果初始校验状态默认为 `pending`。
- `call`：调用子 workflow。未配置 dispatcher 时内联运行；配置后会派发持久子运行并让父运行进入 `waiting`。
- `decide`：记录影响路径的决定。普通局部计算无需包装成步骤。
- `blocked`：缺材料或前置条件，当前无法完成；`needsReview`：已有可读结果，但仍需人工或后续处理。两者都与技术失败不同。

`ctx.call` 返回子 workflow 自己的输出，不会自动包装为 `{ ok: true, output }`。`blocked/needsReview` 只是返回对象；父流程要检查并传播业务终态。普通技术错误会在记录失败状态后抛出；持久子运行等待则让 `runWorkflow` 返回 `run.state === "waiting"`，此时没有 output。不要对两者使用同一种恢复判断。

## 验证不是质量保证

```ts
const draft = await ctx.agent("builder", builder, input);
const checked = await ctx.validate(
  "candidate-contract",
  draft,
  validateCandidate,
  { producerStepKey: "builder" },
);

if (!checked.valid) {
  return ctx.needsReview({ draft, findings: checked.details });
}
```

`validate` 通过对象身份把结果绑定到生产它的 Agent 步骤；对象被复制、反序列化或存在歧义时，使用 `producerStepKey` 明确生产者。schema 校验只说明结构满足合同，不能证明事实正确、证据充分或研究有用。质量复核应是独立业务步骤，并绑定确切候选版本。

若要判断某个 Reviewer、Builder 或整条流程是否有效，应另设评估协议：冻结案例与证据，对照被测版本，并由流程外的独立判据裁定。流程内质量复核是被测对象之一，不是 workflow 自身有效性的证明。参见 [Workflow 评估指南](./evaluating-workflows.md)。

## 发布不可变资产

```ts
const artifact = await ctx.publish(
  "publish-candidate",
  "post-candidate",
  candidate,
  {
    schemaVersion: "2",
    revision: "candidate-7",
    dependsOn: [evidenceDependency],
    validation: "valid",
    review: "pending",
  },
);
```

运行时规范化 payload、计算 SHA-256，并记录生产 run/step/attempt。SQLite 适配器会核对依赖资产的 ID、revision 与 SHA-256，以及 payload 的实际哈希；MemoryRunStore 是轻量测试实现，不执行全部持久化完整性检查。`validation` 与 `review` 是两条独立状态轴；不要把结构有效写成复核通过。

`publish` 的 `validation` 和 `review` 默认都是 `pending`。只有在对应检查已经完成后，才应像上例一样显式写入真实状态；发布动作本身不会替你运行 schema 校验或质量复核。

## 同类列表并发与具名并发

同类输入用 `mapSettled`。`itemKey` 必须稳定、非空且唯一：

```ts
const posts = await ctx.mapSettled(
  "posts",
  samples,
  { concurrency: 2, itemKey: sample => sample.postId },
  sample => ctx.call(`post:${sample.postId}`, analyzePost, sample),
);
```

同一阶段中职责不同的分支用 `parallel` 或 `parallelSettled`：

```ts
const research = await ctx.parallelSettled(
  "research-angles",
  {
    knowledge: () => ctx.call("knowledge", knowledgeWorkflow, frozenInput),
    expression: () => ctx.call("expression", expressionWorkflow, frozenInput),
    metrics: () => ctx.task("metrics", calculateMetrics, frozenInput),
  },
  { concurrency: 2 },
);
```

分支名称会排序后派发，并成为稳定控制步骤的一部分。`parallel` 等待已启动工作收束后，只要有分支失败就抛出组失败；`parallelSettled` 返回每个具名分支的 fulfilled/rejected 结果，由调用方决定阻塞、修复或部分交付。

持久子任务等待时仍占当前并发槽；未派发分支留到下一次恢复。这里的 `concurrency` 只约束该组的推进，真正的 worker 数、模型全局上限和公平性仍由宿主 scheduler 控制。

## Phase：面向阅读的阶段

```ts
return ctx.phase(
  "build",
  {
    title: "构建候选",
    purpose: "生成一份可阅读、可复核的候选报告",
    order: 20,
    expectedArtifacts: [{ role: "candidate", title: "候选报告", required: true }],
  },
  async phase => {
    const candidate = await phase.call("builder", buildWorkflow, input);
    await phase.bindArtifact(candidate, {
      role: "candidate",
      title: "候选报告",
      primary: true,
    });
    return candidate;
  },
);
```

Phase 给用户一个稳定的阶段目的、路径、预期产物与已发布资产入口。内部步骤会带上 phase ID/path；绑定资产只保存精确引用，不复制正文，也不改变 `producedBy`。循环中的 phase 要使用稳定且不同的业务 key。

`expectedArtifacts` 是供宿主展示预期成果的元数据；`required: true` 本身不会阻止缺少该资产的 phase 完成。业务需要强制完整性时，应在流程里显式校验，并由读模型显示未产出项。

Phase 不创建调度器，不占模型槽，也不会自动成为事务或全阶段屏障。返回 `blocked` 或 `needs_review` 时，phase 控制步骤会保留相应状态，避免把“执行结束”误写成“研究已通过”。

### 恢复后重新绑定已复用分支的资产

如果资产绑定只放在 parallel 分支回调里，整个成功分支被复用时该回调不会再执行；新建的 phase attempt 就可能缺少这条资产绑定。让分支返回资产引用，在 `parallelSettled` 汇合后，按 fulfilled 结果在当前 phase 再做 `bindArtifact`。发布资产仍可复用，不需要复制正文或重新调用 Agent。

完整可运行的 [失败恢复示例](../examples/failure-recovery.mjs) 验证：第一次内容检查成功、引用检查临时失败，内容资产仍可阅读；恢复只调用引用检查一次，并在新 phase attempt 绑定两个结果及汇总报告。`run.state === "succeeded"` 表示检查执行完毕，报告仍保留内容意见。

## Replay 规则

恢复时，workflow 函数从头执行。节点只有在以下条件都相同时才能复用：

- 同一个 run、workflow ID 与 workflow revision；
- 相同稳定 key 和 step kind；
- 相同输入指纹与配置指纹；
- 旧节点成功，并且 validation 为 `valid`。

因此所有 `ctx.*` 都要用稳定 key。单独执行到 Agent 节点时，其配置指纹包括 Agent ID/revision、模型、推理强度、prompt/skill/permission revision 与额外 config。但 phase、map 和 parallel 的外层控制步骤也可以整体 replay；一旦外层已复用，其回调不会再次进入，不能依赖内部 Agent 新配置来自动击穿缓存。

闭包捕获值不会被完整识别。task、validator、phase/并行分支回调、嵌套模型/prompt/skill 配置或流程逻辑改变时，必须提升 workflow revision，并以新 run 执行；旧 run 只恢复原来的精确定义。把外部副作用放进有 key 的 `task`、`agent` 或 `call`，并使用幂等键。

## Issue #71 草案与当前 API 对照

[self-media #71](https://github.com/cyl19970726/self-media-content-intelligence/issues/71) 是本库的设计动机与产品集成目标，不是已交付能力清单。主要落点如下：

| #71 中的草案 | 当前共享库 | 范围说明 |
| --- | --- | --- |
| `workflow('id', fn)` | `workflow('id', { revision }, fn)` | revision 必填，用于安全 replay。 |
| `ctx.map(...)` / 同类并发构想 | `ctx.mapSettled(...)` | 当前只有 settled 版本；调用方显式处理单项失败。 |
| 具名 `parallel` / `parallelSettled` | 已提供 | 并发槽与持久子运行等待语义已在 core；全局调度仍属宿主。 |
| `ctx.phase(...)` 草案 | 已提供作用域 phase 与 `bindArtifact` | 提供账本合同；具体页面和读模型仍属宿主。 |
| `defineAgent` 中 input/output schema | `defineAgent` 记录版本化配置，Codex config 可传 `outputSchema` | 输出 schema 与业务文件校验分开；input schema 不是 core 自动执行项。 |
| `publish(..., provenance)` | 已提供 payload、依赖、验证/复核状态与生产者追踪 | URI 是 `workflow-artifact://` 引用；对外文件服务由宿主控制。 |
| step retry HTTP API、SSE、取消传播 | 未内置 | core 提供 replay、事件列表、`AbortSignal` 与端口；路由、轮询/SSE、重试政策由宿主实现。 |
| 队列、租约、worker 上限 | 未内置 | 继续使用宿主唯一 scheduler，避免第二套任务系统。 |
