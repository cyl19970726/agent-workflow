# Agent Workflow

用普通 TypeScript 组合小型 Agent 工作流：顺序、分支、并行、阶段、资产交接和已验证节点恢复。提供 Codex 执行器与 SQLite 存储适配器，业务方法、调度队列和工作台由消费项目掌握。

本库从 self-media 提交 `c460d1cd` 抽离；设计背景见 [Issue #71](https://github.com/cyl19970726/self-media-content-intelligence/issues/71)。该 Issue 包含设计草案和宿主产品要求，当前 API 与能力边界以这里的代码、文档和测试为准。

## 先跑起来

需要 Node.js ≥22.5。以下步骤不会调用真实模型：

```bash
git clone https://github.com/cyl19970726/agent-workflow.git
cd agent-workflow
npm ci
npm run verify
```

`verify` 会构建四个包、检查文档链接、类型检查 Codex 示例、运行测试，并执行无模型示例。

| 示例 | 能看到什么 |
| --- | --- |
| [最小并行流程](examples/document-check.mjs) | task、phase、具名并行、恢复时复用结果 |
| [Builder / Reviewer](examples/review-workflow.mjs) | 无意见交付、一次修订后重新复核、有问题保留 needs_review、精确资产依赖 |
| [Workflow 对照实验](examples/workflow-experiment.mjs) | 同一冻结案例比较两个版本；把独立 oracle 放在被测 workflow 之外；不调用真实模型 |
| [失败后恢复](examples/failure-recovery.mjs) | 保留成功分支资产、只重试失败角色、恢复阶段绑定、区分执行完成与内容仍有意见 |
| [前端工作台](examples/read-model-web.mjs) | 本机浏览器查看安全快照、失败 attempt、显式重试和增量更新；运行后打开终端显示的地址 |
| [真实 Codex 接入](examples/codex-workflow.ts) | 显式模型配置、方法内容快照与哈希、独立 cwd、结构校验；默认只类型检查，调用导出函数才会运行模型 |

## 文档

| 你要做什么 | 从这里开始 |
| --- | --- |
| 在新项目中安装、运行第一个流程 | [快速开始](docs/getting-started.md) |
| 编写小流程、并行、阶段、验证和资产 | [编写工作流与 API](docs/writing-workflows.md) |
| 给每个 Agent 配模型、业务 skill、cwd 和 trace | [Codex 与方法 skill](docs/codex-and-skills.md) |
| 评估 workflow 自身的质量、稳定性和效率 | [Workflow 评估指南](docs/evaluating-workflows.md) |
| 接入已有队列、持久恢复、API 和阶段工作台 | [宿主集成](docs/integration.md) |
| 用共享读模型构建浏览器阶段工作台 | [前端读模型集成](docs/frontend-integration.md) |


## 四个包

| 包 | 职责 |
| --- | --- |
| `@signal-room/workflow` | 独立于模型提供方的合同、运行时、replay、phase、并行和 MemoryRunStore |
| `@signal-room/workflow-codex` | Codex SDK 调用、skill 快照、每次 attempt 的私有 trace |
| `@signal-room/workflow-sqlite` | Node SQLite 执行记录、事件与资产存储 |
| `@signal-room/workflow-read-model` | 服务端范围查询与安全投影；`/contracts` 是浏览器安全类型入口 |

包通过 npm workspace 消费，当前不发布到 npm registry。浏览器只使用 `/contracts` 类型入口；服务端使用各包公共入口，不跨目录引用内部源码。

## 多项目共享源码

```bash
git submodule add https://github.com/cyl19970726/agent-workflow.git vendor/agent-workflow
```

把 `vendor/agent-workflow/packages/*` 加入消费项目的 npm workspaces，声明所需包依赖并在安装/启动前构建。可复制的配置见 [消费项目接入](docs/getting-started.md#作为-submodule-接入项目)。

每个项目固定一个提交，升级由该项目主动选择。直接编辑 submodule 时：

1. 建立命名分支，修改源码后运行共享包与消费项目检查。
2. **先提交并推送共享仓库，再提交并推送消费项目的 submodule 指针。**
3. 其他项目 fetch 后选择明确的提交，构建、验证并更新自己的指针。

新克隆用 `git clone --recurse-submodules`；已有工作树或切换分支后用 `git submodule update --init --recursive`。不要自动跟随远端 main。接入只需按文档配置项目依赖与构建，无需安装编排 skill。

## 能力边界

- 按节点 replay，不恢复任意 JavaScript 堆栈，也不保证外部副作用 exactly-once。
- 修改流程逻辑、闭包或内部方法配置时提升 workflow revision；新 revision 创建新 run，旧任务用旧定义恢复。
- 执行成功、结构有效和独立质量复核通过是不同状态。
- SQLite 账本不代替队列、租约或跨进程调度；HTTP/SSE、取消传播和资产阅读器属于宿主。
- `0.1.0` 保留抽离前的执行记录格式；兼容测试验证旧 SQLite 节点无需重新调用 Agent 即可复用。业务 metadata 原样保存，查询使用 `listRuns({ metadata: { creatorRunId: '...' } })`。
- 原始 prompt、事件 JSONL 和方法快照属于私有 trace。工作台提供安全投影，不能直接开放任意文件路径。
