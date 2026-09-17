# 快速开始

`agent-workflow` 是一个薄的 TypeScript 工作流运行层。业务流程仍是普通 TypeScript；这个库负责给步骤稳定身份、记录运行/尝试/事件、复用已验证结果，并通过端口接入 Agent 与持久子流程。它不会替宿主应用建立任务队列、HTTP 服务或研究质量规则。

## 环境与包

需要 Node.js 22.5 或更高版本。在仓库根目录安装、构建并运行无模型示例：

```bash
npm ci
npm run verify
npm run examples
npm run check:examples
```

三个包的职责如下：

- `@signal-room/workflow`：合同、运行时和内存存储；不依赖 Codex、SQLite 或业务仓库。
- `@signal-room/workflow-codex`：Codex TypeScript SDK 的 `AgentRunner` 适配器与低层调用入口。
- `@signal-room/workflow-sqlite`：执行账本的 SQLite `RunStore`；不负责队列、租约和 worker 调度。

仓库里的 [`examples/document-check.mjs`](../examples/document-check.mjs) 是最小可运行示例：它只使用内存存储和确定性任务，不需要 Codex 账号。

## 第一个 workflow

```ts
import {
  MemoryRunStore,
  runWorkflow,
  workflow,
} from "@signal-room/workflow";

const inspect = workflow(
  "document.inspect",
  { revision: "1" },
  async (ctx, input: { text: string }) => {
    const words = await ctx.task(
      "count-words",
      ({ text }) => text.trim().split(/\s+/u).length,
      input,
    );
    const route = ctx.decide("length-route", words > 100 ? "long" : "short");
    return { words, route };
  },
);

const store = new MemoryRunStore();
const agentRunner = {
  run(): never {
    throw new Error("This workflow has no agent step");
  },
};

const result = await runWorkflow({
  workflow: inspect,
  input: { text: "hello workflow" },
  store,
  agentRunner,
});

console.log(result.run.state, result.output);
```

`workflow()` 必须同时给出稳定 ID 和显式 `revision`。步骤也必须使用稳定、非空 key。不要用时间戳、随机数或并发完成顺序生成 key；循环中可用业务 ID 或固定轮次，如 `review:${round}`。

## 恢复与复用

传入 `resumeRunId` 会从函数开头再次执行：

```ts
const resumed = await runWorkflow({
  workflow: inspect,
  input: { text: "hello workflow" },
  store,
  agentRunner,
  resumeRunId: result.run.id,
});
```

这不是把 JavaScript 堆栈冻结后继续。运行时会按 workflow revision、步骤 key、步骤种类、输入指纹和配置指纹寻找成功且 `validation === "valid"` 的节点并复用。恢复要求 workflow ID、revision 和顶层输入指纹与原运行完全一致。

当 task、validator、phase/并行分支闭包、嵌套 Agent 配置或流程判断的语义变化时，必须提升 workflow revision。运行时无法可靠地给任意函数闭包做内容哈希，而且已复用的 phase/group 控制步骤不会重新进入回调检查内部节点配置。旧 run 只能按原定义恢复；新 revision 应创建新 run。

## 接下来读什么

- [编写工作流](./writing-workflows.md)：全部 `ctx.*` 方法、并发、阶段、资产和 replay 规则。
- [Codex 与 Skills](./codex-and-skills.md)：Agent 定义、方法快照、cwd 和私有 trace。
- [接入宿主应用](./integration.md)：队列、dispatcher、SQLite、读模型和 UI 边界。
- 项目内的 [workflow authoring skill](../.agents/skills/agent-workflow/SKILL.md)：交给 Codex 等开发 Agent 使用的编写检查清单。

## 作为 submodule 接入项目

在消费项目根目录添加共享源码：

```bash
git submodule add https://github.com/cyl19970726/agent-workflow.git vendor/agent-workflow
```

将以下字段合并进消费项目的 package.json，保留已有 workspace、脚本及依赖。这里是使用全部三个包的最小配置；只用 core 的项目可省去其他两个包及其构建步骤。

```json
{
  "private": true,
  "type": "module",
  "workspaces": ["vendor/agent-workflow/packages/*"],
  "dependencies": {
    "@signal-room/workflow": "0.1.0",
    "@signal-room/workflow-codex": "0.1.0",
    "@signal-room/workflow-sqlite": "0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "@types/node": "^24.2.1"
  },
  "scripts": {
    "build:workflow": "npm run build -w @signal-room/workflow && npm run build -w @signal-room/workflow-codex && npm run build -w @signal-room/workflow-sqlite",
    "prepare": "npm run build:workflow"
  }
}
```

首次接入后运行 `npm install` 并提交 lockfile。其他克隆使用 `git submodule update --init --recursive` 后 `npm ci`。依赖从 workspace 解析，不能脱离共享源码直接向 npm registry 安装这些包。

包导出编译后的 JavaScript 和类型。共享源码修改后重新运行 `npm run build:workflow`，重启消费服务；可将它加入现有 dev/test 入口的前置脚本。若宿主已有 prepare 或 pretest，合并原流程，不覆盖已有工作。

要在 submodule 内独立开发与验证，可进入该目录运行 `npm ci && npm run verify`；这是共享仓库自己的工具依赖。项目内 authoring skill 的接入见 [使用 Skill](./using-the-skill.md)。
