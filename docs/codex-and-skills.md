# Codex 与 Skills

`@signal-room/workflow-codex` 把 Codex TypeScript SDK 接到通用 `AgentRunner` 端口。工作流负责何时调用 Agent；runner 负责一次模型执行、私有 trace 和运行收据。研究方法、模型选择和质量门槛仍由消费项目定义。

**本文描述当前文件型 runner。** 新共享服务要求 Codex 默认把可观察执行过程、配置、资产和来源接入统一存储，详见[Codex 接入的默认行为](postgres-sdk-plan.md#51-codex-接入的默认行为)。目前原生详细事件保存在本地，RunStore 接收的是精简事件投影；文件收据也不等于输出正文已进入资产库。不要把以下当前 API 说明当成共享存储模式已经实现。

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

已有低层适配器可用 `attachVerifiedSkillSnapshots(prompt, requiredPaths, { outputDirectory })`。这是“选定 operator/schema 文件”模式：所选文件全文作为角色指令；适配器从它们向上找到最近的 SKILL.md，冻结并交付整个包，使 references、scripts、assets 与 schemas 仍可按需读取，但不会额外要求模型读取主 SKILL.md。原 prompt 和所选文本中指向这些包的绝对源路径会投影到冻结副本，包外合同路径保持不变。冻结目录中的文件始终保留 bundle 原始字节，不会为了提示词投影而改写。收据的 `path`、`sha256`、`bytes` 记录原始来源以及与之相同的冻结文件字节；`effectivePath`、`effectiveSha256`、`effectiveBytes` 只记录实际呈现在 prompt 中的路径和投影后文本。务必传入实际 SDK cwd；两参数旧接口仅交付文本，不具备完整包资源与路径投影语义。

需要以 SKILL.md 作为原生入口时，使用 `snapshotSkill(...)` 并把 bundle 放入 `config.skills`。该模式仍明确要求模型读取冻结副本中的 SKILL.md。不要把这两种入口模式混用：业务 prompt 明确选择 operator 时，应调用 `attachVerifiedSkillSnapshots`；任务明确选择整个 skill 时，应使用 `config.skills`。

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

## 每个角色的运行环境

一个 Agent 看到的不只是 prompt：Codex 还会注入沿途目录的 `AGENTS.md`、用户级 `~/.codex/AGENTS.md`、用户级 skills，以及浏览器、computer-use 等工具。写作、审稿这类非工程角色拿到工程协作规范后，会把“区分事实与推断”“写明限制”写进内容里。角色环境要显式设置，并且以 trace 首条注入为准核对，不以宿主环境为准。

```ts
const runner = new CodexSdkRunner(undefined, traceRoot, {
  // 所有 Agent 共用：指定实际使用的 Codex 可执行文件；trace 记录的就是它的版本。
  codexOptions: { codexPathOverride: "/path/to/codex", config: { project_doc_max_bytes: 0 } }
});

const writer = defineAgent({
  id: "writer", revision: "v3", model: "gpt-6-sol", reasoningEffort: "medium",
  config: {
    prompt: "…",
    threadOptions: { sandboxMode: "read-only", webSearchMode: "disabled" },
    // 只对这个角色生效，合并在 runner 的 codexOptions.config 之上。
    codexConfig: { project_doc_max_bytes: 0 }
  }
});
```

| 要控制的东西 | 设置位置 | 说明 |
| --- | --- | --- |
| 使用哪个 Codex CLI | runner `codexOptions.codexPathOverride` | 未另给 `cliBinary` 时，记录的版本就取自这个可执行文件 |
| 仓库 `AGENTS.md` 注入 | `codexConfig` / `codexOptions.config` 的 `project_doc_max_bytes: 0` | 用户级 `~/.codex/AGENTS.md` 仍会注入，无法按调用关闭；需要时在角色 prompt 里声明它不适用 |
| 读写范围 | `threadOptions.sandboxMode`、`additionalDirectories` | 产出文件的角色给 `workspace-write` 与工程目录；其他角色只读 |
| 联网与搜索 | `threadOptions.webSearchMode`、`networkAccessEnabled` | 只给需要查资料的角色 |
| 其他 Codex 配置 | `codexConfig` | 原样作为 `--config` 覆盖传给 CLI；只有设置了才进入 fingerprint |

给 Agent 的工具提示（“可以用某脚本自检”）必须在**它自己的沙箱里**实际跑通过一次。宿主能用的命令，在无网络的只读或工作区沙箱里可能挂住；Agent 随后会自己找替代工具，把一次调用耗到超时。

### 开跑前确认模型可用

```ts
import { probeCodexModel } from "@signal-room/workflow-codex";

const probe = await probeCodexModel({ model: "gpt-6-sol", runnerOptions: { codexOptions } });
if (!probe.ok) throw new Error(`${probe.model} 不可用（${probe.codexRuntimeVersion}）：${probe.error}`);
```

探针用只读沙箱发一次极短调用，返回可用与否、实际 CLI 版本和拒绝原因，不抛异常。账号不支持某模型时，在运行开始前几秒内就能发现；否则失败发生在 run 中途，宿主 Agent 往往会自己接手把活做完，workflow 就被绕过了。

## 可追溯配置与私有 trace

每次 attempt 会记录：

- Agent ID/revision、实际模型与推理强度；
- prompt、skills、permissions revision；
- SDK 包版本和所选 Codex CLI/runtime 版本；
- output directory、输入/prompt/skill 哈希与整体 fingerprint；
- Codex thread ID、公开事件投影、token usage（不可用时为 `null`）；
- 实际使用的 Codex 可执行文件路径、合并后的 Codex 配置与 thread 选项；
- 原始事件 JSONL、最终响应和指定文件收据。

### 读 trace

```ts
import { codexSessionFile, summarizeCodexAttempt } from "@signal-room/workflow-codex";

const attempt = summarizeCodexAttempt(attemptDir, { ignoreErrors: /unrecognized configuration setting/ });
// { agentId, model, codexRuntimeVersion, state, usage, chars, items, searches, commands, filesChanged, errors, … }
const session = attempt.threadId ? codexSessionFile(attempt.threadId, { startedAt }) : undefined;
```

`summarizeCodexAttempt` 把一个 attempt 目录变成调优要看的事实：执行了哪些命令、哪些失败、搜了什么、改了哪些文件、读写了多少字符、遇到什么错误。`ignoreErrors` 过滤每次调用都会出现的本机配置噪音。`codexSessionFile` 按 thread id 找到完整的 Codex 会话文件，用于逐行查证。不要按“最新修改的会话文件”去找：同一台机器上其他项目的会话会被误认成这个 Agent。

trace 文件权限设为私有，并应保留在宿主的私有运行目录。不要从通用资产端点直接暴露 prompt、原始工具输出、凭据、任意本地路径或完整 JSONL。工作台只读取安全投影。

线程 resume 只有在 role 与完整 fingerprint 都匹配时才允许；不匹配会报错，而不是静默继续旧上下文。workflow 的节点 replay 与 Codex thread resume 是不同层次：前者复用已验证步骤，后者在一个符合指纹的模型线程上继续。

一个不自动发起真实模型请求的配置示例见 [`examples/codex-workflow.ts`](../examples/codex-workflow.ts)。完整的 workflow 编写原则见 [编写工作流](./writing-workflows.md)。

本次修复的复现、真实模型工具证据与验收边界见 [完整 Skill 包加载验证](./skill-package-verification.md)。
