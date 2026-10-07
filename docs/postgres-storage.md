# PostgreSQL workflow-run 存储切片

本指南描述当前已实现的窄接口。`@signal-room/workflow-postgres` 是 execution ledger 原语，不是 WorkflowSpace / Workflow 的领域模型或通用 harness。`workspaceId` 是调用方提供的可信技术分区键；调用方必须先完成认证与授权。它不启用 PostgreSQL RLS，也不能隔离一个持有 pool 的恶意或错误调用者。

## 已实现内容

- `migratePostgresWorkflowStore(pool)` 以事务和 advisory lock 执行增量 schema migration。
- `PostgresWorkflowRunStore(pool, { workspaceId })` 实现 run、step、attempt、event 和 artifact reference 存储，并保存 JSON artifact payload。
- payload 按 core 的 canonical JSON 规则处理并验证 SHA-256；读取器在返回 payload 前再次校验 hash。
- producer attempt 与 dependency 的存在及版本/hash 关系会在所属技术分区内核对；事件序号由数据库按 run 分配。
- 可选 `commitStepResult` 在同一事务内提交 artifact、step/attempt 完成状态、完成事件和幂等收据。同一 run 内同一键和相同请求返回同一收据；同键不同请求冲突。PG 事务只保证数据库内的原子性。

调用方创建、持有并关闭 `pg` pool。**本账本包**不创建 pool，不管理连接配置、身份、RLS、队列、租约、BlobStore、业务资产版本、Agent 配置/会话/trace 或评价对象。另一个可选的 `@signal-room/workflow-spaces` 包已经在 PG 上实现 Space 领域身份、workflow 版本、资产版本、冻结节点上下文、会话与评价等基础能力；其范围和剩余缺口见[Space 存储指南](space-storage.md)。`workflowId` 仍是底层执行身份。详见[领域模型](workflow-spaces.md)和[当前路线](harness-roadmap.md)。

## 无模型示例

要求 Node.js 24、可用的开发 PostgreSQL 数据库，以及安装好的 workspace 依赖。示例会迁移 schema、生成唯一技术分区、执行确定性的 task、关闭并重开连接、读回并校验 JSON payload，然后 replay 同一 run。它不调用模型，也不会清理数据库中的示例数据。

```bash
npm ci
npm run build
npm run example:postgres
```

先在本地 shell 设置 `WORKFLOW_DATABASE_URL` 指向开发数据库；指南不记录连接值。

脚本在 `finally` 中关闭 pool。长生命周期服务应由创建 pool 的宿主统一管理其启动、错误处理和关闭；store 不拥有连接池的生命周期。

## 集成测试

测试需要一个专用、可丢弃的 PostgreSQL 测试数据库。通过本地环境管理 `WORKFLOW_TEST_DATABASE_URL`，不要把连接配置写进仓库：

```bash
npm run test:postgres
```

先在本地 shell 设置 `WORKFLOW_TEST_DATABASE_URL` 指向专用测试数据库；指南不记录连接值。

该命令在环境变量缺失时直接报错，不会静默跳过真实 PostgreSQL 测试。运行前确认连接指向专用测试库；测试会创建并操作 schema 数据。

## 恢复与保证边界

PG store 可以用幂等收据消除同一 run 内重复的数据库提交。它不能让外部模型调用、第三方工具或数据库共同获得 exactly-once 保证。请求已经发出而调用方没有收到回执时，外部操作是否发生仍可能未知；不能据此盲目重试。

若 atomic commit 已提交但客户端没拿到响应，同键同内容可读回已有收据；键相同但内容不同会报冲突。core 会先核对已保存结果；恢复时若仍有未判明结果的 `running` 步骤，会抛出 `AtomicStepReconciliationRequiredError`，保留原 step / attempt 而不自动再次执行。上层需要先对账。PG 的新完成提交要求 producer 仍为 `running`；这项写入检查不提供外部调用的自动续跑或去重。

## 下一步

Space 领域存储和节点冻结上下文已经落地为可选层；后续仍需完整媒体 BlobStore、一般 Agents SDK、生产级 harness 与工作台。当前实现见[Space 存储指南](space-storage.md)，完整目标和验收见[存储与 SDK 方案](postgres-sdk-plan.md)。
