---
name: agent-workflow
description: 使用 agent-workflow TypeScript 库编写、组合、验证和维护多 Agent 流程；配置每步模型与方法 skill，组织 parallel、phase 和资产，并接入持久恢复及宿主工作台。用于已采用或明确要采用此库的项目，不用于 Codex 桌面定时任务或通用 GitHub Actions。
---

# Agent Workflow

把用户的任务实现成小型、可组合的 workflow，并交付可运行代码与验证结果。本 skill 指导编写工作流；运行时每个 Agent 的业务方法 skill 是另一层，不要自动给所有 Agent 注入本 skill。

## 找到本项目的接口和接入点

确认当前项目、已有任务队列、运行目录及 workflow 入口。共享仓库可能在当前根目录，也可能在 `vendor/agent-workflow`；以本文件的**真实路径**向上三级定位共享根目录，符号链接入口也适用。读共享及宿主 AGENTS.md。

- 首次接入：读 [快速开始](../../../docs/getting-started.md)。使用公共包名，先构建共享包；不要复制核心实现。
- 编写流程：读 [Workflow 编写](../../../docs/writing-workflows.md) 和 [实际类型合同](../../../packages/core/src/contracts.ts)。Issue #71 是设计背景，不是可直接复制的当前 API。
- 配模型、skill、cwd 或 trace：读 [Codex 与方法 skill](../../../docs/codex-and-skills.md)。
- 接入队列、恢复和工作台：读 [宿主集成](../../../docs/integration.md)。
- 安装及调用本 skill：读 [Skill 使用](../../../docs/using-the-skill.md)。只做项目内接入，不安装到用户级目录。

按任务需要读取，不要求每次加载全部文档。

## 定义最小执行合同

从用户目标和现有代码确定：冻结输入、角色职责、可读产物、实际验证、失败后的动作，以及模型/资源预算。普通文件读取或确定性变换用 `task`；需要模型判断才用 `agent`。多个可单独恢复的过程用 `call` 组合；不要为简单顺序任务添加队列或新 DSL。

- Workflow 组织执行，AgentDefinition 描述一次模型工作的配置，Phase 组织用户目的与关键资产，Artifact 保留成果和来源。这四者不要合并成一个巨型 Agent。
- 保留业务自己的审阅和修订规则。可以参考 [Builder/Reviewer 示例](../../../examples/review-workflow.mjs)，但示例的一次修订预算不是库的强制政策。
- 沿用用户选定的模型和推理强度，不自动升级或回退。缺少会影响成本或正确性的配置时先查宿主配置，再请求缺失信息。

## 写实际可运行的代码

使用 `workflow(id, { revision }, async (ctx, input) => ...)` 和 `runWorkflow({ workflow, input, store, agentRunner })`。

1. 给 `task/agent/call/validate/publish/decide` 每次逻辑操作显式稳定 key。循环用稳定业务标识和轮次；同 scope 下不得把一个 key 用于不同操作。
2. AgentDefinition 明确 `id/revision/model/reasoningEffort/promptRevision/skillsRevision/permissionsRevision`。Codex 配置放在 `config`，不是虚构的 `skill:` 顶层字段。
3. `ctx.agent` 输出默认仍待验证。对返回的同一个对象调用 `ctx.validate`；标量或变换后的输出需用相同 scope 的 `producerStepKey` 绑定。结构通过不等于独立审阅通过。
4. 发布候选时保留其真实 `validation` 与 `review`，不因为函数执行结束就标为 `passed`。`publish` 返回引用，不返回业务正文；上游资产通过精确的 id/revision/sha256 传递。
5. `phase` 要有 `title` 和 `purpose`。在 phase 回调中使用传入的 phase context，再 `bindArtifact` 已发布的准确引用；不要用外部 ctx 绕过阶段关联。`expectedArtifacts.required` 只声明预期，缺失资产需要业务显式检查。关键资产先可读，执行细节后展开。
6. 同类输入用 `mapSettled(key, inputs, { concurrency, itemKey }, callback)`；不同职责用 `parallel/parallelSettled(key, namedBranches, { concurrency })`。分支内部也必须走有 key 的 task/agent/call。检查每个 settled 结果，明确部分交付、修订或阻塞；不要把失败替换为空成功。
7. `blocked` / `needsReview` 返回的是终态对象，必须由流程返回或显式处理；不是自动向父级抛出的异常。不要用宽泛 catch 把取消或持久子流程暂停转成研究失败。

## 保证重放含义正确

- `resumeRunId` 只接受相同 workflow id、revision 和输入指纹。输入或语义变化创建新 run；旧任务用旧定义恢复。
- 恢复从函数开头重放，只复用可匹配且验证为 valid 的成功节点。Phase/parallel 控制节点可能直接复用整个结果；改其内部逻辑、模型或方法时必须提升 workflow revision，不能只改内部配置后强行 resume。
- 方法文件应在定义构建前冻结为 `{ path, content }`，把实际内容摘要纳入 `skillsRevision`。只给文件路径，文件变化未必使旧缓存失效。独立执行 cwd 也不等于自动加载宿主 skill。
- `task` 提供 `signal` 和 `idempotencyKey`；宿主负责外部写操作对账/幂等。运行时不承诺任意副作用恰好一次。
- SQLite 是执行记录存储，不是持久队列。跨进程父子调度需宿主实现 `ChildWorkflowDispatcher`、定义注册、租约/唤醒和真实资源上限。组内 concurrency 不是全局模型槽限制。
- 阶段恢复时，成功并行分支可能整体复用而跳过回调。分支返回资产引用后，在汇合处重新 `bindArtifact`，避免新 phase attempt 丢失已复用资产的关联；见 [失败恢复示例](../../../examples/failure-recovery.mjs)。
- 私有 prompt、原始事件与方法快照保留在 trace 目录。工作台只展示安全投影，不把任意本地文件变成公开 URL。

## 验证和交付

先用 fake AgentRunner 验证可观察行为：正常路径、实际涉及的失败分支、修订边界、已验证节点复用、资产来源/阶段绑定。不要为本来不存在的业务策略添加测试或约束。

共享仓库使用 `npm run verify` 和 `npm run examples`；宿主运行自己的集成检查。文档中的真实 Codex 示例默认只做类型检查；只有任务已授权实际运行和相应模型成本时再调用模型，明确区分模拟验证和真实执行。

交付流程入口、使用方式、实际通过的检查和剩余限制。修改共享源码时先提交/推送共享仓库，再更新已授权宿主的 submodule 指针；安装 skill 只创建该项目内链接，说明实际路径。
