# Workflow Space 存储：当前实现与接入

本页只说明当前 `@signal-room/workflow-space-contracts` 与 `@signal-room/workflow-spaces` 的可用接口。更广的业务设计见 [Workflow Space](workflow-spaces.md)，执行账本见 [PG 存储指南](postgres-storage.md)。Space 以一个业务目的为单位；一个 Space 可保存多个已发布 workflow 版本、case、run、资产版本、会话、评价和采用记录。`workflowId` 仍是底层执行身份。

## 启动与权限边界

使用 Node 24 和本 workspace 已安装的依赖。宿主提供一个由自己创建和关闭的 `pg` pool；先调用 `migrateWorkflowSpaces(pool)`，再迁移选定的 BlobStore。最小服务装配如下，数据库连接值由部署环境提供，不写入仓库：

```ts
import { Pool } from 'pg';
import { migrateWorkflowSpaces, PostgresBlobStore, WorkflowSpaceService } from '@signal-room/workflow-spaces';

const pool = new Pool({ connectionString: process.env.WORKFLOW_DATABASE_URL });
await migrateWorkflowSpaces(pool);
const blobs = new PostgresBlobStore(pool);
await blobs.migrate();
const principal = { id: authenticatedUserId, kind: 'human' as const }; // 宿主认证结果，不来自请求正文或模型
const spaces = new WorkflowSpaceService(pool, blobs, principal);
// 宿主停止时 await pool.end();
```

宿主必须在每个调用者边界绑定真实 `SpacePrincipal`。服务检查成员身份和 owner / creator / operator / viewer 角色；数据库没有 RLS，持有 pool 的代码属于可信宿主。节点不能拿到 `WorkflowSpaceService`、pool、`runtimeLedger()`、可任选 `spaceId` 的通用接口或凭证。宿主通过 `nodeClient(spaceId, contextId)` 给节点一个经服务验证的限定客户端：`read(slot)`、`readFull(slot)`、`submit(commit)`、`act(action,input)`。投影视图不能用 `readFull` 绕过；`nodeReadTools(client)` 可把绑定输入阅读变成执行器工具。`act` 当前只允许合同批准的 `evaluate`，且评价对象与证据必须是该节点绑定输入；人工接受、修订和采用由认证为 human 的宿主服务完成。

`createSpaceConsole(service)` 只渲染只读页面，逐次通过已绑定的服务读取；它不认证 HTTP 请求。单用户本机可绑定 loopback；多用户部署须在 HTTP 宿主按请求认证并绑定对应服务，不能让所有访问者共用一个人的服务实例。没有内置队列、租约或多租户数据库隔离。

节点能力约束适用于经本服务发起的操作，不会自动沙箱化执行器已有的文件系统、shell 或其他工具。宿主必须避免再向节点提供可以读取完整资产或凭证的旁路。本轮真实 SIWC 探针只注入绑定的资产阅读工具；Codex 环境隔离与临时 VM 不属于这次验收。

控制台可通过 `createSpaceConsole(service, { readers })` 注入按 `namespace@revision` 选择的业务阅读器，返回标题和正文分节；缺少专用阅读器时显示结构化正文。它不会改变资产原文或授权范围。

## 一次确定性的写入链

1. owner 调用 `createSpace({purpose})`、`registerSchemas(spaceId, definitions)` 与 `publishWorkflow(spaceId, draft)`。发布时每个 entrypoint 包含 `workflowId`、`codeRevision`、`storageContract`；合同在登记的 schema 上冻结节点输入/输出槽、字段投影、状态与动作。已发布同名版本不能改内容。可运行的最小合同和 schema 见 [`spaces.test.ts`](../packages/spaces/spaces.test.ts)。
2. 宿主调用 `createCase`，以准确的同 Space 资产版本 ID 调用 `freezeInputs(spaceId, caseId, {slot: versionId})`，然后以 workflow 版本、entrypoint、manifest ID 和幂等键调用 `startRun`。预先输入可以由 `importAsset` 写入；显式转换使用 `transformAsset`。输入清单在运行中不自动追踪最新版。
3. 宿主对本轮节点调用 `startNode(spaceId, {runId,nodeId,key,inputs,producer,instructions,effectiveConfig,...})`。输入只能来自冻结清单或该 run 已有节点产物，并且必须匹配合同声明的 schema、状态和槽；服务记录实际交付的字段视图、版本/hash、知识、指令、配置、step/attempt/session 身份。`NodeContext` 的 `effectiveConfig` 和 `instructions` 是宿主提供的实际声明，另存 `declaredConfigHash` 对应 run 冻结配置；两者**没有密码学证明**，不能把动态配置写成已受 workflow 签名认证的内容。宿主应控制谁能提供覆盖值，并避免把密钥放进会话配置正文。
4. 仅向节点传 `NodeClient` 或绑定工具。`read` 返回该槽的准确版本与角色视图；`submit({idempotencyKey,outputs:[{slot,payload,dependencySlots,...}]})` 验证输出 schema、槽、所需依赖与 append 版本冲突，原子写入资产版本、来源、绑定、会话事件和 core step 收据。附件先由宿主 `uploadBlob`，再传 blob ID；读回时核对实际字节 hash。`recordSessionEvent` 属于可信宿主的可观测记录入口。
5. 由人以 `transition(...action:'accept'|'requestRevision')` 决定具体资产状态；`recordReview`、`compare`、`recordIteration`、`adopt` 分别保存评价、基线比较、改动与采用。评价不能代替人类接受或自动更改采用指针。历史读取使用 `overview`、`readAsset`、`readContext`、分页 `sessionEvents` 和只读控制台。

### 独立方法预览与版本页面

`WorkflowVersionDraft.entrypoints` 可保存 `process` 与 `nodeDefinitions`。前者冻结节点、控制边、存储端口及可选数据绑定；后者保存按节点 ID 对应的用途、声明指令、模型、工具和配置。旧版本未保存的字段保持缺失，不从当前宿主补写。`predecessorId` 须指向同 Space 中具有共同 workflow 身份的已发布版本，不能指向自身。

`InteractiveWorkflowHost.methods` 是可选的 `WorkflowMethodHost`：宿主提供只读 `preview()`、显式 `publish({expectedVersionId,predecessorId,changeReason})` 和 `availability(versionId,entrypoint)`。共享页面 `/spaces/:spaceId/workflows` 组织版本，`/spaces/:spaceId/workflows/:versionId/:entrypoint` 从保存的定义生成图；候选入口为 `/workbench/workflows/preview`。发布动作经过现有来源与 CSRF 校验，和运行／采用分别处理。展示页面不负责执行任意旧代码；没有匹配执行器的版本仍可阅读。

`ProcessContractDraft.runInputs` 将命名的冻结运行输入绑定到准确 schema；`dataBindings` 指定输入来自某节点输出或冻结输入，并用有限的 `selection` 和首次／后续轮次条件表达来源。发布校验引用、schema 一致性与条件是否重叠。这是声明合同，实际消耗的资产版本仍以节点 context 收据为准；通用运行时差异检查和自动调度尚未实现。完整范围与验证见[方法工作台实施记录](workbench-method-implementation-2026-10-05.md)。

旧 core workflow 可用 `createSpaceRuntime(service, spaceId, {workflowVersionId,entrypoint,inputManifestId}, {underlyingRunner,resolveAgent,resolvePublication})` 接入。两个 resolver 在可信宿主中把 core 的 agent / artifact 映射到准确节点、输入版本与输出槽；Agent 原始观察结果与程序发布产物分开记录。当前桥接把已观察的 Agent 原始输出和 core 完成收据放在同一 PG 事务，另把程序发布的 Space 资产和 core artifact 收据放在同一 PG 事务。确定性丢失回执测试验证：已持久化的 Agent 结果可复用，不会再次调用 runner。格式不合格的模型输出连同 schema 错误原子保存为失败记录；不把确定的格式错误混同为提交结果未知。外部模型/工具副作用、原生 SDK 会话状态不因此获得 exactly-once 或任意恢复能力。creation 已用现有 CONTENT 流程通过确定性 PG 接入、多轮返工与反馈回归；作品档案和独立 B3 程序样例也已读写验证，完整 B3 媒体运行仍未验收。接口示例见 [`runtime.test.ts`](../packages/spaces/runtime.test.ts)。`SiwcResponsesRunner` 是可选的 SIWC Responses 适配器，不是一般 OpenAI Agents SDK。

2026-10-04 的可选实跑已用应用自行授权的 ChatGPT 订阅连接和 `gpt-6-astra` low 完成一轮**合成材料**生产探针：一个绑定资产读取、两个 Responses 回合、原始文本/工具/读取事件及产物均保存到 Space。随后在新的独立 Agent session 中，审阅者读取冻结的来源和候选版本，四问原始回答按绑定评价动作保存。此证据验证了这条有限链路，不表示创作质量通过，也没有人类接受或采用动作。生产云部署、完整媒体及原生 SDK 会话恢复仍待完成。

实跑脚本为显式 opt-in，会发起实际模型请求并在指定数据库留存合成探针记录；不属于 `npm test` 或普通 examples。先在本地环境设置 `WORKFLOW_DATABASE_URL` 与明确选择的 `WORKFLOW_SIWC_MODEL`，完成 `node packages/agent-sdk/dist/cli.js login`，再运行：

```bash
node examples/space-siwc.mjs
```

脚本会输出本次的 Space ID 和 run ID。需要独立审阅时，再把这两个 ID 分别设为本地环境变量 `WORKFLOW_PROBE_SPACE_ID`、`WORKFLOW_PROBE_RUN_ID`，运行：

```bash
node examples/space-siwc-review.mjs
```

审阅脚本会核对来源 run 与准确资产版本，使用新的 reviewer 会话，验证两次绑定读取后保存评价；不执行人工接受或采用。不把数据库连接值、账号凭证、探针 ID 或合成正文写入文档。

## 重试、恢复与大小限制

`startRun`、`submitNode`、资产导入/转换、状态转换及采用使用持久幂等键：相同请求重试返回同一收据，改动内容复用同键会冲突。`startNode` 以 run 中的 step key 或既有 attempt 对账，相同请求返回已有 context；不应在未知提交结果后换 key 重启模型。core 原子步骤提交已保存时，优先读回收据；若外部模型或工具的结果仍未知，先对账，不能据数据库事务推断外部 exactly-once。`freezeInputs` 按 case 和准确输入槽／版本计算清单 ID，同一请求重复调用返回同一清单。跨 Space 引用和未绑定的节点依赖会拒绝；状态变化按发布版本合同和认证主体判定。

`PostgresBlobStore` 确实保存字节，但默认单对象上限为 16 MiB，只适合小素材和集成基线。大媒体需要私有持久对象存储的 `BlobStore` 实现，并完成部署、备份及上传对账；当前未提供 provider，也未完成完整媒体链路。BlobStore 的 durable `put` 先于资产提交，数据库只能原子提交自身记录；外部副作用和孤儿对象须由宿主对账。

使用专用、可丢弃的 PostgreSQL 测试库设置 `WORKFLOW_TEST_DATABASE_URL`，在 `agent-workflow` 根目录运行：

```bash
npm run build
npm run test:spaces
npm run check:docs
```

`test:spaces` 在未设置测试库变量时会报错，不会静默跳过；测试是确定性的，不调用模型。最终隔离安装验证的共享 `npm run verify` 已通过 16 个测试文件、123 个测试，其中包含 16 个真实 PG Space 领域测试与 6 个 ledger 测试；共享构建、文档链接、示例类型检查及离线示例也通过。这些检查验证存储合同、权限边界和恢复行为，不代表 creation 业务效果或生产部署已验收。


## 准确执行器与持久运行任务

`WorkflowExecutorRegistry<T>` 登记可信部署提供的 `{versionId, entrypoint, config, definition, executor, verify}`；`definition` 是已规范化的冻结入口。`resolve(publishedVersion, entrypoint)` 对比准确配置与整个入口，再检查部署资源。它只返回已登记工厂，不从数据库 prompt、任意路径或旧版本号动态加载代码。相同 `codeRevision` 不构成兼容证明。

共享服务的任务接口：

| 接口 | 当前作用 |
| --- | --- |
| `enqueueExecution(spaceId, binding, queuedRunDraft, {executorKey})` | 原子保存排队 run、Space 绑定、命令回执及任务；相同请求幂等，修改输入或执行器的重试拒绝 |
| `executionTasks` / `getExecutionTask` | 读取任务；用数据库时间将已失去心跳的任务投影为 `interrupted`，`leaseExpired` 标明该观察，无需读请求改写历史 |
| `claimExecution` | 只领取匹配已部署执行器的排队任务；共享 Space 锁与持久并发限额 |
| `heartbeatExecution` / `finishExecution` | 按领取 token 续期与确认结束；原生业务状态与任务结束状态分别保存 |
| `cancelExecution` | 未执行任务直接取消；正在执行的任务记录取消请求，待回调停止后确认 |
| `reconcileExecutions` | 将已过期领取持久记录为中断；不会重新派发或推断外部副作用没有发生 |

`WorkflowExecutionManager` 构造时不运行。宿主显式 `wake()` 后派发，`completion(runId)` 等待结果，`waitIdle()` 等待本次派发可继续的工作，`cancel(runId)` 只影响目标运行，`stop()` 停止领取并中止本宿主持有的任务。已存在但没有开始的排队记录可以在新进程里再次显式派发；失去心跳的执行记录不能自动重领。

当前并发限额是每 Space 的 workflow run 数，首次领取时保存，后续宿主必须使用相同值；在线修改限额的管理命令尚未提供。`interrupted` 保留占用，直到准确执行结果经核对确认；没有通用的一键重试／恢复按钮。该层不宣称外部工具 exactly-once，也不提供进程强杀或多租户资源隔离。任务全生命周期事件写入已有 run ledger，心跳不逐次制造业务 trace。

详情和验收见[准确版本与多选题执行记录](workbench-execution-implementation-2026-10-06.md)。
