# A1：空白 Space 与业务理解的操作合同

本参考只描述已经实现的入口。宿主先给设计 Agent 预配私有 v2 凭据并启动独立设计工作台；允许范围来自宿主与凭据的明确 Space ID 交集。身份、真实会话和 `role:design` 来自可信宿主，不能用保存文件中的署名取得权限。普通前端身份只读。

在 Creator Lab 根目录调用项目内 CLI，文件路径使用绝对路径：

```sh
export WORKFLOW_OPERATOR_BASE_URL='http://127.0.0.1:4400'
export WORKFLOW_OPERATOR_SPACE_ID='your-new-space-id'
export WORKFLOW_OPERATOR_TOKEN_FILE='/absolute/private/design-credential.json'
pnpm --silent --dir vendor/agent-workflow operator onboarding
pnpm --silent --dir vendor/agent-workflow operator space-create --file /absolute/private/space-create.json
pnpm --silent --dir vendor/agent-workflow operator space
pnpm --silent --dir vendor/agent-workflow operator understanding-history
```

创建文件严格只有以下字段。首次创建没有业务理解、设计、方法、Case、运行或业务资产；通用 schema 和成员属于基础设施。

```json
{
  "id": "your-new-space-id",
  "purpose": "工作台名称或简短用途",
  "scope": {"workflowId": "your-workflow-id", "entrypoint": "your-entrypoint"},
  "idempotencyKey": "unique-create-key"
}
```

`id` 与环境中的目标一致；`scope` 不生成执行定义。未知结果用同请求同键重试；改请求复用键或尝试接管已有 Space 会失败。创建回执记录八项初始计数和可信创建者。`space.businessState` 记录当前计数及理解 head；不要把通用 schema 当业务数据。

业务理解保存文件的完整格式：

```json
{
  "expectedRevisionId": null,
  "idempotencyKey": "unique-understanding-save-key",
  "title": "理解标题",
  "content": "以真实请求与材料形成的 Markdown 正文",
  "sources": [
    {"kind": "user-request", "ref": "准确请求引用", "title": "S1 请求标题", "excerpt": "相关原文摘录"}
  ],
  "authorship": {"kind": "agent", "name": "authenticated-agent-id", "sessionId": "authenticated-session-id"},
  "changeReason": "本次形成或改变判断的理由"
}
```

`sources.kind` 为 `document`、`case`、`asset` 或 `user-request`，至少一条；`ref`、`title` 必填，`excerpt` 可省略。正文由设计 Agent 从请求和材料形成，不从 Space purpose 或旧方法自动扩写。字段不替你判断业务目标、成功标准或未知。

```sh
pnpm --silent --dir vendor/agent-workflow operator understanding-save --file /absolute/private/understanding-save.json
pnpm --silent --dir vendor/agent-workflow operator understanding
pnpm --silent --dir vendor/agent-workflow operator understanding --revision EXACT_REVISION_ID
pnpm --silent --dir vendor/agent-workflow operator understanding-history
```

首次 `expectedRevisionId:null`；下一版填刚读取的准确当前 ID。CLI 和 API 都要求 `authorship.name/sessionId` 与受信设计 Agent 一致；服务端另记 `recordedBy`。同一请求的幂等重试返回原对象；旧 head 保存返回冲突，先读新版本再判断。旧版、前驱、hash、署名、来源和理由保留，`confirmation` 为 `unconfirmed`。

普通页面 `/space-workbench` 是目录；创建后进入对应 Space，空方法状态默认显示业务目标。保存后可读正文、来源与修订历史；准确历史链接不会被当前理解替代。文档路径是声明引用，不授予任意宿主文件读取；资产／Case 来源只有本 Space 准确对象可读时才提供入口。

业务理解本身可独立创建和修订，不因方法能力、设计或版本尚不存在而被阻断。后续方法能力、设计候选及登记由宿主的准确 `summary.capabilities` 和 [方法形成操作合同](../../method-first-design/references/operator-contract.md)约束；这些写入不由理解保存自动触发。Case 运行、评价和采用仍各需独立授权。技术测试通过与真实业务验收分开；认知负责人亲自创建、形成理解、修订和前端读回后记录 A1 验收。宿主接入详情见 [Operator CLI](../../../../docs/operator-cli.md)。
