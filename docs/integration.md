# 接入宿主应用

接入前用 [设计](./designing-workflows.md)、[评估](./evaluating-workflows.md)、[优化](./optimizing-workflows.md)三份指南明确意图、交付和验收。方法建议与库已实现能力分别记录；下面说明现有执行基础设施的边界。

新持久执行统一使用 **PostgreSQL + 官方 OpenAI Agents SDK**：PostgreSQL `RunStore`／Space 服务记录 run 与资产，`OpenAIAgentsSdkRunner` 负责 Agent/tool loop，SIWC 只负责当前 runner 所用的 ChatGPT 授权与 Responses model transport。三个工作台的代码接线、PG + SDK 迁移及指定回归已完成，具体证据见[建设路线](harness-roadmap.md)；creation launcher 已切换新配置。单帖主执行和浏览器报告阅读已完成，候选仍为 `revised_unverified`，独立审阅未通过，少量精度备注仍在质量调优。SQLite 只用于明确启动的只读历史导入，Codex 历史 trace 由 read-model 只读解码；二者都不是新的执行路径或 fallback。接口边界见[Space 存储指南](space-storage.md)、[执行 harness 架构](postgres-sdk-plan.md)与[架构](architecture.md)。

下文的“宿主”表示装配和运行应用的服务层，负责唯一任务队列、租约、worker 并发、HTTP 权限与读模型接入。它可以由 agent-workflow 的共享服务模块提供；research、analysis、creation 的业务流程、资产类型、政策和阅读器仍由各自工作台维护。

## 推荐组合

```text
业务 API / Host
  ├─ 现有任务队列、租约、取消与 worker 上限
  ├─ workflow registry（按 id + revision 注册定义）
  ├─ ChildWorkflowDispatcher（把子运行交给同一队列）
  ├─ PostgreSQL RunStore + Space 服务
  │    └─ run / attempt / event / asset / evidence 的持久记录
  ├─ AgentRunner
  │    └─ OpenAIAgentsSdkRunner（官方 SDK Agent / Runner / tool）
  ├─ SIWC model transport
  │    └─ 当前 ChatGPT authorization + Responses 路由；无 Codex/API-key/SQLite 执行 fallback
  ├─ skill bundle snapshot
  │    └─ @signal-room/workflow-skill-snapshot；由宿主冻结并绑定 revision
  └─ 安全读模型
       ├─ run / step / attempt / event 投影
       ├─ phase 与资产引用投影
       └─ 已注册 artifact reader
```

启动 worker 时，从 registry 解析任务保存的 workflow ID + revision，再调用 `runWorkflow`。持久 dispatcher 的 `ensureChild` 必须按 `parentStepRunId` 幂等：重复推进同一父步骤时返回同一个子运行，而不是创建副本。传给队列的输入必须冻结且可序列化；不要序列化函数闭包。

父 workflow 遇到仍在 queued/running/waiting 的子运行时会写入 `waiting` 并返回宿主。宿主必须结束当前 job、释放 scheduler 租约；core 本身不操作租约。子运行发生状态变化后，宿主重新入队父 run；父函数从头 replay，已验证节点会被复用。

## 端口边界

[`RunStore`](../packages/core/src/ports.ts) 持久化 run、step、attempt、event 和 artifact 引用。事件序号必须在单个 run 内严格递增并由 store 原子分配。新持久执行使用 `PostgresWorkflowRunStore`；它保存执行账本，但不负责任务领取、租约续期或调度。

`AgentRunner` 接受冻结输入、AgentDefinition、AbortSignal、运行元数据与事件回调，并返回 output、可选 validation 和 metadata。共享 core 不依赖具体 Agent provider，也不读取业务仓库。

`ChildWorkflowDispatcher` 只定义 `ensureChild` 和可选 `cancelChildren`。队列优先级、网络重试次数、模型并发上限、后代取消轮询与死信处理都由宿主实现。不要在共享库旁再建一套会与现有 worker 竞争的 scheduler。

## 历史 SQLite 与 Codex 数据

`@signal-room/workflow-sqlite` 与 `@signal-room/workflow-codex` 已从共享执行包集合移除。SQLite 仅在用户明确选择时，由消费项目的只读历史导入工具读取并转换到 PostgreSQL；导入不得回写源库、参与新 workflow 执行、被自动选为 `RunStore`，或在 PG 连接失败时成为 fallback。每个消费项目需要核对导入范围、数量、状态与内容 hash。

既有 Codex attempt trace 仍可作为历史证据。共享 `@signal-room/workflow-read-model` 提供只读 decoder，可摘要显式指定的旧 attempt 目录；它不会继续 Codex session、运行命令、改写 trace 或创建可执行 run。当前模型执行由官方 Agents SDK runner 管理，skill bundle 由 `@signal-room/workflow-skill-snapshot` 独立捕获和物化。

## HTTP 与事件读取

core／PostgreSQL／read-model 组合没有内置 HTTP、SSE 或 step-retry 路由；Space 层提供可选的只读 HTTP 控制台。宿主可围绕 `RunStore` 提供自己的授权 API，例如运行快照、`listEvents(runId, afterSeq)`、资产索引、取消和允许的修复动作。SSE 与增量轮询都可以基于事件 seq 实现；客户端必须按 seq 去重并支持刷新恢复。

不要把“重试某一步”实现为直接把数据库状态改成通过。当前 core 的恢复单位是 workflow run：重新推进同一个 run，按指纹复用有效节点，对失败/失效路径创建新步骤或 attempt。业务上的定向修复通常应建成显式 repair workflow，并产出新资产版本。

取消执行时把宿主管理的 AbortSignal 传入 `runWorkflow`，同时由 dispatcher/queue 传播到持久子任务。仅中止当前进程内 signal 不能替代跨进程取消协议。

## 读模型与 UI

UI 应从同一执行账本和已发布资产生成安全读模型，但不能直接把内部表或 trace 暴露给浏览器。

建议分别投影：

- 执行：run state、真实 step/Agent、attempt、等待原因、安全错误和已知用量；未知用量显示未知，不记作零。
- 阶段：phase title/purpose/order、预期产物、已绑定精确资产、完成/阻塞/待复核状态。
- 资产：type、schemaVersion、revision、SHA-256、producer、dependencies、validation 与 review。
- 阅读器：按 `type + schemaVersion` 注册；未知类型只显示安全元数据和允许访问的入口，不猜成旧格式。

Phase 是用户理解成果的入口，workflow/step/attempt 是执行审计层。已发布中间资产可以在整个父流程结束前阅读；候选可读、结构有效、独立复核通过和当前交付版本必须分别显示。阶段引用资产而不复制内容，也不改变真实生产者。

私有 trace、prompt、工具原始输出、凭据和任意文件路径不进入公共 artifact API。业务正文遵守消费项目自己的事实来源和生产者约定；共享层不得改写报告结论。此处的 read-model 包只投影引用和来源链；可选 Space 服务已持久保存并按节点权限读取正文与版本，不能把原读模型边界误解为资产永远只存本机路径。

## 与 self-media #71 的关系

[self-media #71](https://github.com/cyl19970726/self-media-content-intelligence/issues/71) 描述了单帖/博主研究、定向修复、阶段工作台和生产迁移目标。本仓库提供可组合 workflow、replay、具名并发、phase、资产来源、PostgreSQL 持久账本与官方 Agents SDK runner；三个消费工作台的代码迁移与指定回归、单帖主执行及浏览器报告阅读已完成。当前候选仍为 `revised_unverified`，独立审阅未通过，少量精度备注仍在质量调优。下列是消费宿主需持续承担的实现与验收责任：

- 复用现有研究任务队列、租约和全局模型并发限制的 dispatcher；
- 单帖与博主的 prepare/build/review/repair 业务 workflow 及晋升规则；
- 失败评估的定向修复、实际来源缺失阻塞和有限重试政策；
- HTTP/SSE 或轮询、取消传播、授权和安全读模型；
- 阶段式工作台、业务 artifact reader 与三 Lens 的既有事实源约束；
- 真实端到端运行、崩溃恢复、成本/用量和阅读质量验收。

因此“库里有某个 API”不表示 #71 已完成。集成验收必须以宿主的真实队列、真实资产和实际页面为证据。可参考 [`examples/review-workflow.mjs`](../examples/review-workflow.mjs) 理解候选—验证—复核的组合方式；它是演示，不是 self-media 的生产研究流程。
