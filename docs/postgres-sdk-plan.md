# 执行 harness 与执行器架构

**状态：现行架构与已实现边界，执行器代码更新于 2026-10-12。** 本文说明一次节点执行从编排到证据、资产提交和恢复由谁负责。[改写前的完整方案](postgres-sdk-plan-history-2026-10-10.md)保留订阅认证、媒体协议与分段验收的历史依据。当前存储分工见[存储全貌与 Workflow 配合](storage-architecture.md)，可用接口见[Space 服务接入](space-storage.md)与[PG 存储指南](postgres-storage.md)。

共享层首先服务执行器。业务项目定义方法、节点、schema、工具和判据；harness 绑定准确身份与输入，执行器只在此范围内运行。模型回答、已观察的原始响应、已发布资产、评价和人工采用是不同事实，各有自己的记录。

## 1. 四层职责与实际接缝

| 层 | 已实现的责任 | 边界与待建能力 |
| --- | --- | --- |
| core | workflow 阶段与步骤、RunStore、attempt、事件、replay、可选原子 `commitStepResult`；提交结果未知时要求对账 | 不知道 Space、PG、对象存储或 provider |
| Space 领域服务 | 认证主体下的 Space 权限、schema 和节点合同、方法版本、冻结输入、`NodeContext`、会话事件、资产版本与来源；协调 PG ledger 事务 | `workspaceId` 只是可信技术分区键；没有数据库 RLS，也不沙箱化执行器 |
| `createSpaceRuntime` harness 桥接 | 映射 core run／step／attempt 到 Space run、context 和资产；包裹 runner、保存可观察事件与原始响应，程序发布时提交资产和 core 收据 | 依赖可信宿主的 `resolveAgent`／`resolvePublication`；不能猜出未记录的工具调用或隐藏模型状态 |
| runner 与宿主 | 官方 Agents SDK 的 `OpenAIAgentsSdkRunner`、程序节点执行具体工作；宿主装配身份、SIWC model transport、准确 executor registry 和可选 worker | 官方 `Agent` / `Runner` / `tool` 驱动新 Agent 执行；SIWC 仅适配 ChatGPT 授权和单次 Responses 请求。三个工作台的代码接线与 PG + SDK 迁移已完成并有各自回归证据。单帖新运行和浏览器报告阅读已完成；候选仍为 `revised_unverified`，Reviewer finding 被驳回且独立审阅未通过。质量调优仍在进行；完整 SDK 能力覆盖与统一原生会话恢复尚未交付 |

`createSpaceRuntime(service, spaceId, {workflowVersionId, entrypoint, inputManifestId}, {underlyingRunner, resolveAgent, resolvePublication})` 返回 core 可用的 `store` 和 `agentRunner`，并要求 ledger 具备原子步骤提交。持久任务派发是可选的宿主层，不是节点存储的前提。[桥接实现](../packages/spaces/runtime.ts)与[core 运行时](../packages/core/src/runtime.ts)是当前行为依据。

## 2. 一次节点执行的生命周期

1. **选定身份与输入。** 宿主选择准确发布的 workflow 版本和 entrypoint，将 Case 输入冻结成 `InputManifest`。Run 保存版本、入口、清单和配置；后续资产 head 改变不会改写它。`WorkflowExecutorRegistry` 只解析可信部署登记的准确版本、入口、配置和定义，不从数据库 prompt 动态加载代码。
2. **装配并保存上下文。** `resolveAgent` 或 `resolvePublication` 将 core 步骤映射到节点、输入槽与执行配置。`startNode` 核对同 Space、冻结清单或同 Run 已有输出，以及 schema、状态、合同和投影；保存 `NodeContext` 的 run、step、attempt、session、`producer`、输入 hash、instructions、effectiveConfig 与实际交付视图。动态配置是宿主报告的声明，不具备密码学真实性证明；密钥不进配置正文。
3. **执行并观察。** runner 得到限定的 `NodeClient` 或绑定工具，不得到 PG pool、R2 凭据或可任选 Space 的服务。`read(slot)` 与 `readFull(slot)` 按合同交付准确资产；字段投影不能被 `readFull` 绕过。harness 按 context、session、attempt 保存可观察消息、工具、trace 和错误。分页、截断与缺失必须显式展示；“提供了工具”不等于“调用了工具”。
4. **保存原始结果，再发布。** Agent 的 `completeObservedAgent` 保存可观察的原始输出与校验状态，尚未发布资产。程序发布或授权节点 `submit` 校验输出 schema、端口、依赖、附件及预期 head；`commitRuntimePublication` 将 Space 资产版本、绑定与 core artifact／步骤完成收据放在一个 PG 事务。格式错误与不完整失败分别记录。`producer:'agent'` 与 `producer:'program'` 即使使用同一节点名，也不是同一次模型运行。
5. **下游与判断。** 下游只读已提交的准确版本。评价、基线比较、人工接受、采用和交付是后续记录，不随 runner 成功自动发生。安全读模型不能暴露私有原始 trace、凭据或数据库权限。

受管路径之外的脚本和隐式子调用不会自动进入账本。需要质量归因或独立评价的行为，应成为显式 workflow 节点，或接入具备可观察与授权合同的执行接缝。

## 3. 配置、过程与事务边界

### 3.1 生效配置

冻结方法可声明 prompt、模型、工具名称及 schema、skills、限制和权限。Run 与 `NodeContext` 保存冻结配置和本次生效配置；SIWC `started` trace 还可能记录 provider 实际指令与工具定义。这些来源必须分开，不能用现行代码回填旧版本，也不能把未记录字段显示为已确认。单次覆盖由可信宿主控制，不能扩大节点合同或宿主授权。

### 3.2 可观察过程

`SessionEvent` 保存适配器可观察的消息、工具、trace 与错误；工具调用按 attempt 加 call ID 配对，分页未扫完时结果仍未知。隐藏内部推理、适配器未暴露的子调用、provider 远端状态和原生恢复材料不会因有 trace 表而自动变成已采集证据。当前官方 Agents SDK 执行沿用 `siwc.*` 事件有界持久化，并在新运行记录 SDK 身份；没有默认开启独立的 SDK 云端 trace 导出。历史事件不回填 SDK 身份。

### 3.3 PostgreSQL 与对象存储的分工

PG 是 Space 身份、版本、正文、依赖、上下文、执行账本和收据的权威事实源；私有 R2 保存新附件字节，旧 PG BlobStore 的小附件仍按历史 key 读取。当前 R2 是 **16 MiB 上限的单对象**、内容寻址、写后读回校验；资产版本冻结 manifest，下载须先证实 blob 绑定准确版本。对象先持久化，PG 后登记与提交，PG 事务无法回滚 R2 PUT。写对象成功但 PG 失败时按同 hash 重试并对账，未引用对象可能遗留。multipart／断点上传、自动 GC、跨存储迁移及备份恢复演练尚未实现。详细路径与隔离验收以[存储全貌与 Workflow 配合](storage-architecture.md)为准。

## 4. replay、resume、未知结果与租约

`startRun`、资产写入和节点提交使用持久幂等键；同键不同请求冲突。core replay 只能复用已提交且可校验的结果。若步骤完成的客户端回执丢失，先按原 commit 身份读收据；Space 桥接能读回已持久化 context 和观察结果，避免确定性重播时再次调用 runner。结果未知的 running attempt 不能被当成成功，也不能换 key 绕过不确定性。

| 观察到的断点 | 当前协议的判定与处理 | 仍需建设的能力 |
| --- | --- | --- |
| 输入、schema 或配置准备失败，runner 未发起 | 保留准备失败，不声称模型已运行；修复后明确新尝试 | 更统一的部署前配置诊断 |
| `startNode` 写入成功，调用者丢了回执 | 按同一 run／step／attempt 与输入、指令和配置读回 context；不同内容冲突 | 跨所有执行器的统一准备收据 |
| runner 请求已发出，最终响应没有回执 | 留下 running／未知结果，不把超时或取消当作远端未执行；core 在 replay 前要求对账 | provider 查询 ID 与原生状态的统一对账端口 |
| 运行中事件写入失败 | Space 桥接把持久化错误变成 `AtomicStepReconciliationRequiredError`，保留待核对 attempt，不把可能已执行的模型调用直接改写为普通失败 | 有界本地缓冲、补传和完整性覆盖协议 |
| 收到完整响应，但违反注册的输出 schema | `completeObservedAgent` 在 PG 事务中保存原始回答、校验错误和失败状态；它是确定失败，不发布资产 | 对更多 runner 的一致结构化错误适配 |
| 原始响应及 core Agent 完成收据已保存，程序发布未做 | 准确读取已保存响应和收据，按原步骤身份继续或核对发布；不要默认再次请求模型 | 跨进程原生会话恢复与完整过程归档 |
| R2 对象已写并读回，但 PG manifest／资产提交失败 | 相同 Space 与 SHA-256 键重试并校验；对象可能成为孤儿，不能假称跨系统回滚 | 上传意图、引用扫描、保留与自动 GC |
| PG 发布事务成功，调用端没有回执 | 读准确资产与步骤幂等收据；相同键同内容返回既有结果，不制造第二个版本 | 更完整的运维对账视图 |
| 第三方工具有副作用，但回执丢失 | 按业务操作键查询或人工核对；无法确认时暂停相关分支，不盲重试 | 通用外部操作意图／回执登记与 provider-specific 查询 |
| 执行任务失去心跳或旧 worker 迟到 | 任务显示 `interrupted`；领取 token 阻止旧 worker 结束任务。租约到期不证明模型或工具没执行 | 对未知外部结果的人工／自动协调流程 |
| 取消请求到达正在执行的任务 | `cancel_requested` 触发本宿主 AbortSignal；仍需核对 native run 终态，不能以请求已发送表示远端已停止 | provider 原生取消回执及副作用证明 |

当前领取 `claimToken` 只限定任务心跳和任务结束，尚未传入 `submitNode`／`commitRuntimePublication`。资产发布检查 context 的执行主体、running attempt、预期 head 和幂等收据，**没有租约 fencing 的统一保证**；不能据任务 token 推断所有旧 worker 的迟到资产提交都被阻止。

PG 原子步骤提交只覆盖 PG 记录，不提供模型调用或第三方工具的 exactly-once。不可撤回副作用应先保存操作意图和幂等身份，再执行并记录回执。SDK、worker 与工具的重试预算不能叠加放大调用。**会话 resume** 沿可用历史或原生状态继续；**core replay** 复用既有步骤结果；两者不能混称。

可选 `WorkflowExecutionManager` 在显式 `wake()` 后领取持久任务、心跳、取消和完成；构造与只读查询不派发。`claimExecution` 按已部署 executor key 和 Space 并发限额领取，领取 token 限定心跳与完成；租约过期可协调为 `interrupted`，但不会自动重领或推断远端没有副作用。`stop()` 只停止本宿主领取并中止本宿主任务；worker 崩溃和旧 worker 迟到仍需准确 token 与结果对账。[执行任务实现](../packages/spaces/execution-tasks.ts)说明当前保证。

## 5. 执行器接入的验收边界

当前 `OpenAIAgentsSdkRunner` 已使用官方 `@openai/agents` 管理角色内部的模型与工具循环，并接入冻结上下文、限定工具和原始响应保存。SIWC 仅保留授权与单请求传输；运行身份与 SDK 版本写入新事件，旧历史不回填。research、analysis、creation 的代码迁移与指定回归已完成；验证包括 shared 600 项实际 PG 测试、analysis 613 项回归加 9 项定向 Reviewer 修复检查、research 33 项及历史导入／UI 阅读、creation PG 回归与配置迁移。Creation launcher 已切换到新配置。单帖 run `a33ae133-94a8-401d-b5f2-eebc1e572854` 完成 36 次模型请求，历时 546.287 秒；报告和三 Lens 图片可在浏览器阅读。候选状态为 `revised_unverified`；Reviewer 的相矛盾 minor finding 被正确驳回，独立审阅未通过。只读审计确认之前的完整性缺口已修复，仍有少量精度备注；质量调优继续。完整 SDK 功能与原生恢复协议也仍需另行实现和验证。凭据只由可信宿主持有，不进入资产或 trace。

<a id="51-codex-接入的默认行为"></a>

### 5.1 历史 Codex trace 的只读读取

共享 Codex execution adapter 已退役；新执行不得回退到 Codex、扫描本地 Codex 会话或将 Codex trace 当作可恢复 run。已有 Codex attempt 目录和 JSONL 是只读历史证据。`@signal-room/workflow-read-model` 保留限定的 legacy decoder，可从显式给定的 attempt 目录生成安全概要；它不执行命令、不续接线程、不修改原文件，也不把摘要冒充 PG 账本记录。实现见 [`legacy-codex-trace.ts`](../packages/read-model/src/legacy-codex-trace.ts)。

完整 skill bundle snapshot 已从 Codex runner 拆为 provider-independent 的 `@signal-room/workflow-skill-snapshot`，负责 capture、validate 和 materialize。Agent 配置和业务输入仍由消费项目绑定并冻结；包本身不调用 Agent，也不安装全局 skill。当前 SDK 用法见 [快速开始](getting-started.md) 与 [`agents-sdk-workflow.ts`](../examples/agents-sdk-workflow.ts)。

程序节点也要登记独立 `producer` 与准确输入输出，不能借 Agent context 让发布步骤看起来发起模型调用。执行器能力分别由确定性故障测试、真实 PG 测试和有上限的 provider 实测验证；任何一类都不能替代另外两类，也不能证明产出质量。
