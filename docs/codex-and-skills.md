# Agent SDK 与历史 Codex trace

新 Agent 执行使用官方 `@openai/agents` SDK，通过 `OpenAIAgentsSdkRunner` 接入 workflow `AgentRunner`。新持久运行写入 PostgreSQL。当前 runner 的 SIWC model transport 使用应用自持的 ChatGPT 授权与 Responses 路由；它不读 Codex credential，也不在授权失败时回退到 API key、Codex 或 SQLite。SDK runner 的已实现边界见[执行器包说明](../packages/agent-sdk/README.md)。三个工作台的代码接线、PG + SDK 迁移及指定回归已完成，creation launcher 已切换新配置。单帖主执行和浏览器报告阅读已完成；候选为 `revised_unverified`，Reviewer finding 被驳回且未通过独立审阅，少量精度备注仍在质量调优。完整 Agents SDK 能力面和原生 session 恢复仍有明确边界。

共享 `@signal-room/workflow-codex` execution package 已退役。不要用旧 `CodexSdkRunner` 配置创建新 workflow、恢复历史 Codex 线程，或把旧文件型 trace 当成 PostgreSQL run。旧 Codex trace 只能当只读历史证据；其 decoder 属于 `@signal-room/workflow-read-model`，见[decoder 实现](../packages/read-model/src/legacy-codex-trace.ts)。

## 冻结 skill bundle

完整 skill 是目录资源，不只是 `SKILL.md`。provider-independent 的 `@signal-room/workflow-skill-snapshot` 提供 `snapshotSkill`、验证和物化能力。它只捕获、校验和落盘 bundle；不调用 Agent、不注册全局 skill，也不自动注入模型上下文。宿主需明确决定怎样给某个 Agent 使用 bundle，并把其 hash 绑定到配置 revision。

```ts
import { defineAgent } from "@signal-room/workflow";
import { snapshotSkill } from "@signal-room/workflow-skill-snapshot";

const skill = snapshotSkill("/absolute/project/.agents/skills/research-method");
const researcher = defineAgent({
  id: "researcher",
  revision: "1",
  model: selectedModel,
  reasoningEffort: "medium",
  promptRevision: "research-prompt-1",
  skillsRevision: skill.sha256,
  permissionsRevision: "read-only-v1",
  config: {
    instructions: `Use this method:\n\n${skill.content}\n\nAnalyze the frozen input.`,
    outputFormat: "json",
  },
});
```

`snapshotSkill` 会捕获 skill 目录下的所有普通文件，包括 references、scripts、schemas 和资源文件，并记录权限与内容摘要。`.git` 和 `.DS_Store` 会被忽略。只有目标仍位于 bundle 内部的符号链接才会解析；外部链接、循环、无效路径和摘要不匹配都会被拒绝。之后源目录变化不会改变已冻结的 bundle。摘要只能证明捕获了哪些字节，不能证明模型读取或遵循了这些内容。

如果宿主需要为受限工作区工具准备文件副本，应显式调用 `stageSkill(bundle, attemptDirectory)` 或 `materializeSkill(bundle, destination)`，并将目标路径绑定到对应 attempt。这些 helper 不提供操作系统级 sandbox；进程权限、可读取目录和允许的命令仍由宿主控制。维护中的可执行示例会冻结 skill、将摘要绑定到 Agent 定义，并使用调用方提供的 PostgreSQL 存储：[`agents-sdk-workflow.ts`](../examples/agents-sdk-workflow.ts)。

## 只读查看旧 Codex 证据

read-model decoder 会汇总显式指定的历史 attempt 目录。它不会执行命令、恢复线程、改写文件或创建 workflow run。

```ts
import { summarizeCodexAttempt } from "@signal-room/workflow-read-model";

const evidence = summarizeCodexAttempt("/private/traces/run-id/step-id/attempt-id");
```

摘要包含记录中的 runtime 身份、状态、可用时的用量、条目数、搜索、命令、文件变更和错误。未记录的用量保持为 `null`。摘要只是本地 trace 的派生视图，不是权威的 PG 事件流，也不能证明业务结果已被接受。请保留源 trace 的私密性，并仅通过获授权的 reader 传递所需证据。

历史 Codex session lookup 仅用于按 thread ID 检查旧证据。不要按“最新文件”选择 session，不要将用户 session 自动扫描进 workflow，也不要把 decoder 用作 runtime fallback。新的 Agents SDK 事件和输出遵循 [执行 harness 架构](postgres-sdk-plan.md)中描述的 PostgreSQL workflow trace 路径。
