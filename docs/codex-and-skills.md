# Codex 与 Skills

`@signal-room/workflow-codex` 把 Codex TypeScript SDK 接到通用 `AgentRunner` 端口。工作流负责何时调用 Agent；runner 负责一次模型执行、私有 trace 和运行收据。研究方法、模型选择和质量门槛仍由消费项目定义。

## 定义 Agent

以下为配置片段：`ReviewInput`、`ReviewReceipt` 和 `reviewReceiptJsonSchema` 由消费项目定义。可直接类型检查的完整例子在文末。

```ts
import { defineAgent } from "@signal-room/workflow";
import type { CodexSdkAgentConfig } from "@signal-room/workflow-codex";

const reviewer = defineAgent<ReviewInput, ReviewReceipt>({
  id: "post-reviewer",
  revision: "3",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  promptRevision: "review-prompt-4",
  skillsRevision: "video-method-8",
  permissionsRevision: "review-workspace-write-2",
  config: {
    prompt: "独立复核候选，并只返回合同允许的 JSON。",
    skills: [
      { path: "/absolute/project/.agents/skills/video-method/SKILL.md" },
    ],
    outputSchema: reviewReceiptJsonSchema,
    receiptFiles: ["evaluation.json"],
    timeoutMs: 10 * 60_000,
    threadOptions: {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    },
  } satisfies CodexSdkAgentConfig,
});
```

`defineAgent` 要求显式 `model` 和 `reasoningEffort`，并且 AgentDefinition 的 ID、revision、prompt/skills/permissions revision 都是必填合同。共享库没有默认模型，也不会自动回退到更昂贵模型。消费项目应选择符合任务的模型，并在变更方法或 prompt 时提升相应 revision。

`outputSchema` 约束 SDK 最终响应；`receiptFiles` 只观察指定输出文件是否存在并记录哈希。两者都不等同于业务合同或研究质量验证，后者必须由 workflow 中显式的 `ctx.validate` 和独立 Reviewer 完成。

## 业务方法快照

每个业务 Agent 可以在 `config.skills` 中声明它此次执行必须收到的方法文件。runner 会读取文件内容，将内容嵌入有效 prompt，并记录路径、SHA-256、字节数和 prompt anchor。这证明某个确切方法版本被交付给该 attempt；它不证明模型遵守了方法。

若方法依赖其他 reference 文件，也应将本次必需文件逐项冻结交付，或提供经过权限验证的读取路径；嵌入 SKILL.md 不会自动递归加载其引用文件。

生产配置应在 `defineAgent` 前读取并冻结 `{ path, content }`，同时把内容摘要写入 `skillsRevision`。若只传 `{ path }`，文件内容要到实际执行时才读取，core 在复用外层 phase/group 控制步骤前无法感知文件已变化。任何方法正文、嵌套模型或 prompt 变化都必须同步提升 workflow revision，并开启新 run；不要尝试用新定义恢复旧 revision 的 run。


也可以先用 `attachVerifiedSkillSnapshots(prompt, requiredPaths)` 生成带收据的 prompt，适合已有适配器逐步迁移。不要把“文件位于 cwd”或模型自述当成方法已加载的证据。

## cwd 与冻结输入

`CodexSdkRunner` 默认给每个 attempt 建立独立目录：

```text
<traceRoot>/<runId>/<stepRunId>/<attemptId>/
```

如果 `config.outputDirectory` 未指定，这个 attempt 目录也作为 SDK 的 `workingDirectory`。指定了 outputDirectory 时会使用其绝对路径作为 cwd。runner 默认传入 `workspace-write` 与 `never` approval policy，调用者可在 `threadOptions` 中显式覆盖支持的选项。

workflow 输入会稳定序列化后嵌入 prompt，并写入私有 `input.json`。图片不是 `CodexSdkRunner` 的高层 Agent 配置项；需要低层图片调用的现有适配器可使用 `invokeCodexSdk` 的 `imagePaths`。

## 可追溯配置与私有 trace

每次 attempt 会记录：

- Agent ID/revision、实际模型与推理强度；
- prompt、skills、permissions revision；
- SDK 包版本和所选 Codex CLI/runtime 版本；
- output directory、输入/prompt/skill 哈希与整体 fingerprint；
- Codex thread ID、公开事件投影、token usage（不可用时为 `null`）；
- 原始事件 JSONL、最终响应和指定文件收据。

trace 文件权限设为私有，并应保留在宿主的私有运行目录。不要从通用资产端点直接暴露 prompt、原始工具输出、凭据、任意本地路径或完整 JSONL。工作台只读取安全投影。

线程 resume 只有在 role 与完整 fingerprint 都匹配时才允许；不匹配会报错，而不是静默继续旧上下文。workflow 的节点 replay 与 Codex thread resume 是不同层次：前者复用已验证步骤，后者在一个符合指纹的模型线程上继续。

一个不自动发起真实模型请求的配置示例见 [`examples/codex-workflow.ts`](../examples/codex-workflow.ts)。完整的 workflow 编写原则见 [编写工作流](./writing-workflows.md)。
