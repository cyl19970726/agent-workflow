# Codex 与 Skills

`@signal-room/workflow-codex` 把 Codex TypeScript SDK 接到通用 `AgentRunner` 端口。工作流负责何时调用 Agent；runner 负责一次模型执行、私有 trace 和运行收据。研究方法、模型选择和质量门槛仍由消费项目定义。

## 定义 Agent

以下为配置片段：`ReviewInput`、`ReviewReceipt` 和 `reviewReceiptJsonSchema` 由消费项目定义。可直接类型检查的完整例子在文末。

```ts
import { defineAgent } from "@signal-room/workflow";
import { snapshotSkill, type CodexSdkAgentConfig } from "@signal-room/workflow-codex";

const skill = snapshotSkill("/absolute/project/.agents/skills/video-method");
const reviewer = defineAgent<ReviewInput, ReviewReceipt>({
  id: "post-reviewer",
  revision: "3",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  promptRevision: "review-prompt-4",
  skillsRevision: skill.sha256,
  permissionsRevision: "review-workspace-write-2",
  config: {
    prompt: "独立复核候选，并只返回合同允许的 JSON。",
    skills: [
      skill,
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

## 完整 skill 包与普通方法文件

Skill 是一个目录，不只是 SKILL.md。先用 `snapshotSkill(directoryOrSkillMd)` 冻结整个包，再把返回值放入 `config.skills`。快照包含 `references/`、`scripts/`、`assets/`、`schemas/` 等所有文件的原始字节和执行权限；仅忽略 `.git` 与 `.DS_Store`。包内符号链接会解引用，逃出包目录的链接或循环会报错。外部依赖须由消费项目显式准备，库不会自动安装依赖或全局 skill。

runner 在 SDK 启动前把包还原到 `<workingDirectory>/.agents/skills/<name>/`，使 Codex 原生目录发现和相对路径读取可用。提示词要求读取该处 SKILL.md，其他文件按需读取，不把所有二进制或 reference 内容塞进 prompt。源目录修改、移动或删除不影响已冻结的 bundle。收据记录完整文件清单、树摘要和交付目录；它证明交付，不证明模型读取或遵循了所有文件，具体执行要看工具事件与业务验证。

普通独立 Markdown 方法仍支持 `{ path, content }`。目录或 SKILL.md 的 `{ path }` 简写会在实际执行时捕获全包；生产 workflow 应在 `defineAgent` 前调用 `snapshotSkill`，避免 replay 判断早于磁盘读取。只冻结 SKILL.md 正文不能替代全包快照。

树摘要包含相对路径、文件内容和权限，reference、脚本、素材的变更都会改变摘要。将 `skill.sha256` 写入 `skillsRevision`。任何方法、嵌套模型或 prompt 变化还必须提升 workflow revision 并开启新 run：core 可以复用整个已完成 phase/group，不会执行其内部闭包重新发现依赖。线程 resume 也要求完整指纹一致。

已有低层适配器可用 `attachVerifiedSkillSnapshots(prompt, requiredPaths, { outputDirectory })`：它从所选文件向上找到最近的 SKILL.md，冻结并交付整个包，同时保留旧的指定文本与收据。务必传入实际 SDK cwd；两参数旧接口仅交付文本，不具备完整 skill 加载语义。

不同 skill 应使用不同目录名。建议每次 attempt 使用独立 cwd；若显式复用 outputDirectory，已有同名包必须与本次快照完全一致，否则报错，不会覆盖、混合或遗留上一版本文件。运行期间需要修改的文件应写到输出目录，不能修改冻结的 skill 包。文件私有权限为 0600，带执行位的脚本为 0700。

可运行完整包验证：

```bash
npm run build
WORKFLOW_SMOKE_MODEL=gpt-5.6-luna node examples/skill-package-smoke.mjs
```

这会真实调用模型并产生费用，日常 verify 不自动运行。例子先冻结一个包含规则、脚本和二进制素材的包，删除源目录，再通过 workflow 调用 Codex、校验随机 token 和脚本结果，并检查命令事件。

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

本次修复的复现、真实模型工具证据与验收边界见 [完整 Skill 包加载验证](./skill-package-verification.md)。
