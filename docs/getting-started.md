# 快速开始

本文从 TypeScript 执行核心开始：给步骤稳定身份、记录运行／尝试／事件、复用已验证结果，并通过端口接入 Agent 与持久子流程。生产运行统一使用 PostgreSQL 持久存储和官方 OpenAI Agents SDK runner；SIWC 是当前受限 runner 的 ChatGPT 授权与 Responses model transport。三个工作台的代码接线与 PG + SDK 迁移已完成，并通过各自的回归和数据／阅读检查；creation launcher 已切换新配置。单帖主执行和浏览器报告阅读已完成，候选仍为 `revised_unverified`、独立审阅未通过，质量调优继续。SQLite 仅允许明确选择的只读历史导入，不是新 run store 或 fallback。见[Space 存储指南](space-storage.md)、[产品](product.md)和[架构](architecture.md)。业务项目继续定义自己的业务方法与质量标准。

## 环境与包

需要 Node.js 24。在 `vendor/agent-workflow` 根目录安装、构建并运行确定性示例：

```bash
npm ci
npm run verify
npm run examples
npm run check:examples
```

当前共享包的职责如下：

- `@signal-room/workflow`：合同、运行时和内存存储；不依赖 provider、PostgreSQL 或业务仓库。
- `@signal-room/workflow-postgres`：PostgreSQL 执行账本 store；新持久 workflow runs 使用此路径。
- `@signal-room/workflow-read-model`：执行账本到浏览器的安全读模型，接入见[前端指南](frontend-integration.md)。
- `@signal-room/workflow-space-contracts`：JSON Schema Registry 与冻结的 workflow storageContract。
- `@signal-room/workflow-spaces`：PostgreSQL Space 领域服务、节点客户端、core runtime bridge 与只读控制台，见[Space 存储指南](space-storage.md)。
- `@signal-room/workflow-agent-sdk`：官方 `@openai/agents` SDK 驱动的 `AgentRunner`，使用受限 SIWC Responses model transport。
- `@signal-room/workflow-skill-snapshot`：provider-independent skill bundle capture、校验与落盘；不会调用 Agent，也不会安装全局 skill。
- `@signal-room/workflow-space-api` 与 `@signal-room/workflow-workbench-ui`：认证边界后的 HTTP contracts/services 与共享阅读组件。

已退役的 `@signal-room/workflow-codex` 与 `@signal-room/workflow-sqlite` 不提供执行 fallback。旧 SQLite 数据只能由显式只读导入流程处理；旧 Codex trace 只能由 read-model 解码为历史证据。

仓库里的 [`examples/document-check.mjs`](../examples/document-check.mjs) 是最小可运行示例：它只使用内存存储和确定性任务，不需要模型授权。官方 SDK workflow 组合见 [`examples/agents-sdk-workflow.ts`](../examples/agents-sdk-workflow.ts)；该导出函数仅在宿主显式调用时请求模型，示例检查不会调用模型。

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
- [Agent SDK 与历史 trace](./codex-and-skills.md)：官方 SDK runner、独立 skill snapshot 包与只读 Codex 历史 trace。
- [接入宿主应用](./integration.md)：PostgreSQL、官方 SDK、队列、dispatcher、只读导入、读模型和 UI 边界。

## 作为 submodule 接入项目

在消费项目根目录添加共享源码：

```bash
git submodule add https://github.com/cyl19970726/agent-workflow.git vendor/agent-workflow
```

将共享包加入消费项目已有的 workspace 和依赖，保留已有脚本及依赖。Creator Lab 使用仓库根目录的 pnpm workspace，配置已包含 `vendor/agent-workflow/packages/*`；不要在根目录另建 npm workspace 或 lockfile。新建 pnpm 消费项目可按下面配置共享目录与生产运行所需的包：

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@signal-room/workflow": "workspace:*",
    "@signal-room/workflow-postgres": "workspace:*",
    "@signal-room/workflow-space-contracts": "workspace:*",
    "@signal-room/workflow-spaces": "workspace:*",
    "@signal-room/workflow-agent-sdk": "workspace:*",
    "@signal-room/workflow-skill-snapshot": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "@types/node": "^24.2.1"
  },
  "scripts": {
    "build:workflow": "pnpm --filter @signal-room/workflow build && pnpm --filter @signal-room/workflow-postgres build && pnpm --filter @signal-room/workflow-space-contracts build && pnpm --filter @signal-room/workflow-spaces build && pnpm --filter @signal-room/workflow-agent-sdk build && pnpm --filter @signal-room/workflow-skill-snapshot build"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - vendor/agent-workflow/packages/*
```

首次接入后用项目自己的包管理器安装并提交 lockfile。其他克隆使用 `git submodule update --init --recursive` 后按项目包管理器冻结安装。依赖从 workspace 解析，不能脱离共享源码直接向 npm registry 安装这些私有工作区包。

包导出编译后的 JavaScript 和类型。共享源码修改后重新运行项目的 `build:workflow`（Creator Lab 为 `pnpm build:workflow`），重启消费服务；可将它加入现有 dev/test 入口的前置脚本。若宿主已有 prepare 或 pretest，合并原流程，不覆盖已有工作。

要在 submodule 内独立开发与验证，可进入该目录运行 `npm ci && npm run verify`；这是共享仓库自己的工具依赖。可运行示例位于 `examples/`；编写流程时直接参考本仓库文档。
