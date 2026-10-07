# Agent Workflow

把真实业务做成能执行、能评价、能持续改进的工作流。共享项目的目标范围包含工作流执行、PostgreSQL 资产管理 harness、一般 Agent SDK 接入、版本评价与通用工作台；业务项目提供流程、工具、标准与展示扩展。

**先读 [产品定位](docs/product.md) → [Space 工作台产品与交互](docs/workbench-presentation.md) → [架构](docs/architecture.md) → [实现状态](docs/harness-roadmap.md)。** Space 支持用 workflow 完成业务并持续改进方法，覆盖从业务目的、首版设计到执行、稳定运营与持续改进的生命周期。工作流内以 Archify 画布切换方法、执行、运营观察和版本演进；业务与资产提供跨案例入口，评价在对象旁展开。现有存储、执行、阅读器和局部图可复用，整体前端尚未通过产品验收。SIWC 是应用自己的订阅登录与 Responses runner，尚不是一般 OpenAI Agents SDK；准确可用接口见 [Space 存储接入](docs/space-storage.md)，缺口只在[建设状态](docs/harness-roadmap.md)维护。

本库从 self-media 提交 `c460d1cd` 抽离；设计背景见 [Issue #71](https://github.com/cyl19970726/self-media-content-intelligence/issues/71)。该 Issue 包含设计草案和宿主产品要求，当前 API 与能力边界以这里的代码、文档和测试为准。

## 核心思想：workflow 是调出来的

把一项业务交给 workflow，**先做一个最简单、能真跑的第一版，再一轮一轮调优**。第一版需要在真实业务里检验；产物评价指出问题，trace 和资产帮助解释过程。每一轮：

1. 在**冻结输入**上真跑，由用户或独立 Agent A 记录好、不好、相对上轮提升与仍不满意；
2. **读 trace 和资产**：每个角色收到了什么、做了什么、交出了什么；
3. 把问题归到一层（输入与交接、角色、标准与审阅者、流程结构、运行环境），围绕一个主要假设修改并升版本，用同条件重跑对比；条件变化如实记录，最后决定采用或回退。

调优过程中要逐步定下三件事：

- **看哪些 trace 和资产**才能判断每个角色做得对不对；
- **关键流程怎么划分**，在全图中怎样理解定义与实际执行，点节点如何读产物、评价与证据；
- **哪些资产给用户看**，哪些只进审计层，哪些永不暴露。

内容始终由 workflow 里的 Agent 产出；主持调优的人或 Agent 只编排、评估和改 workflow，不替它补内容。具体做法见 **[调优循环](docs/tuning-loop.md)**；本库为此提供的支持：step key 防重复、按角色设置 Codex 环境、开跑前模型探针、trace 摘要与会话定位（见 [Codex 与 Skills](docs/codex-and-skills.md)），尚未解决的问题见 [Harness 路线](docs/harness-roadmap.md)。

## 先跑起来

完整 workspace 使用 Node.js 24；旧核心包仍兼容 ≥22.5。以下步骤不会调用真实模型：

```bash
git clone https://github.com/cyl19970726/agent-workflow.git
cd agent-workflow
npm ci
npm run verify
```

`verify` 会构建十个包、检查文档链接、类型检查 Codex 示例、运行测试，并执行无模型示例。

| 示例 | 能看到什么 |
| --- | --- |
| [最小并行流程](examples/document-check.mjs) | task、phase、具名并行、恢复时复用结果 |
| [Builder / Reviewer](examples/review-workflow.mjs) | 无意见交付、一次修订后重新复核、有问题保留 needs_review、精确资产依赖 |
| [Workflow 对照实验](examples/workflow-experiment.mjs) | 同一冻结案例比较两个版本；把独立 oracle 放在被测 workflow 之外；不调用真实模型 |
| [失败后恢复](examples/failure-recovery.mjs) | 保留成功分支资产、只重试失败角色、恢复阶段绑定、区分执行完成与内容仍有意见 |
| [前端工作台](examples/read-model-web.mjs) | 本机浏览器查看安全快照、失败 attempt、显式重试和增量更新；运行后打开终端显示的地址 |
| [PostgreSQL 存储](examples/postgres-run.mjs) | 确定性 task 写入 PG；新建连接读回并校验正文，再对同一 run replay；不调用模型。需设置 `WORKFLOW_DATABASE_URL` |
| [真实 Codex 接入](examples/codex-workflow.ts) | 显式模型配置、方法内容快照与哈希、独立 cwd、结构校验；默认只类型检查，调用导出函数才会运行模型 |

## 文档

现行定义、实现状态、API 指南和历史记录分开阅读。产品定义规定应如何使用，建设状态说明当前做到哪，日期化实施记录保存当时测试与交付证据，不能替代现行规范。工作台产品只在一份[交互定义](docs/workbench-presentation.md)维护；不要求拼读多个“下一步”报告才能理解整体。实际设计和调优再使用 [设计](docs/designing-workflows.md)、[评估](docs/evaluating-workflows.md)、[优化](docs/optimizing-workflows.md)和[调优循环](docs/tuning-loop.md)。

| 你要做什么 | 从这里开始 |
| --- | --- |
| 理解为什么建设共享底座、完整需求和当前取舍 | [产品目标与需求](docs/product.md) |
| 看 Space 的全貌、图中心使用方式、版本／Case／运行／资产／迭代如何联动 | [工作台产品与交互定义](docs/workbench-presentation.md) |
| 使用目前的 Archify 图、搜索、节点选择与导出 | [流程查看器](docs/archify-viewer.md) |
| 理解执行、资产 harness、SDK、评价、工作台与业务的关系 | [架构与职责](docs/architecture.md) |
| 区分已实现、待建设和待确认 | [建设顺序与当前状态](docs/harness-roadmap.md) |
| 使用空间存储、节点客户端与控制台 | [Space 存储接入](docs/space-storage.md) |
| 使用目前实现的 PostgreSQL workflow-run store | [PG 存储指南](docs/postgres-storage.md) |
| 查看完整资产 harness、SDK 与订阅接入方案 | [存储层与 SDK 执行闭环](docs/postgres-sdk-plan.md) |
| 在新项目中安装、运行第一个流程 | [快速开始](docs/getting-started.md) |
| 从 session 历史或新意图设计阶段、步骤和资产 | [设计 Workflow](docs/designing-workflows.md) |
| 编写小流程、并行、阶段、验证和资产 | [编写工作流与 API](docs/writing-workflows.md) |
| 给每个 Agent 配模型、业务 skill、cwd 和 trace | [Codex 与方法 skill](docs/codex-and-skills.md) |
| 评估 workflow 自身的质量、稳定性和效率 | [Workflow 评估指南](docs/evaluating-workflows.md) |
| 根据失败归因和对照实验改进流程 | [优化 Workflow](docs/optimizing-workflows.md) |
| 一轮调优的实际步骤：冻结输入、读 trace、归因、重跑、定工作台显示 | [调优循环](docs/tuning-loop.md) |
| 调优中暴露的 harness 问题及进展 | [Harness 路线](docs/harness-roadmap.md) |
| 接入已有队列、持久恢复、API 和阶段工作台 | [宿主集成](docs/integration.md) |
| 用共享读模型构建浏览器阶段工作台 | [前端读模型集成](docs/frontend-integration.md) |


## 当前十个包

| 包 | 职责 |
| --- | --- |
| `@signal-room/workflow` | 独立于模型提供方的合同、运行时、replay、phase、并行和 MemoryRunStore |
| `@signal-room/workflow-codex` | Codex SDK 调用、按角色的 Codex 环境、skill 快照、每次 attempt 的私有 trace 及其摘要、模型探针 |
| `@signal-room/workflow-sqlite` | Node SQLite 执行记录、事件与资产存储 |
| `@signal-room/workflow-postgres` | PostgreSQL run/step/attempt/event/artifact 存储、JSON 正文读取与可选原子步骤提交；不含完整 harness、调度或 SDK runner |
| `@signal-room/workflow-space-contracts` | JSON Schema 注册与依赖冻结、节点存储合同、字段视图与动作校验 |
| `@signal-room/workflow-spaces` | PG 空间领域、版本与会话、受限 client/tools、core 桥接、评价比较和只读控制台 |
| `@signal-room/workflow-agent-sdk` | 应用自持 SIWC OAuth 与有边界的 Responses runner；不是已验收的 OpenAI Agents SDK |
| `@signal-room/workflow-read-model` | 服务端范围查询与安全投影；`/contracts` 是浏览器安全类型入口 |
| `@signal-room/workflow-space-api` | Space 查询与受限业务命令的 HTTP 合同和服务适配 |
| `@signal-room/workflow-workbench-ui` | 共享 React 工作台、方法与运行画布、资产阅读和处理建议 |

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
- 当前 SQLite 账本不提供队列、租约或跨进程调度；新的 Space 服务、API 与 React 工作台提供独立的共享路径，业务注册领域阅读器和政策。当前实现与尚未完成的生产能力见建设路线，不能把原型路径验收等同于完整平台交付。
- `0.1.0` 保留抽离前的执行记录格式；兼容测试验证旧 SQLite 节点无需重新调用 Agent 即可复用。业务 metadata 原样保存，查询使用 `listRuns({ metadata: { creatorRunId: '...' } })`。
- 原始 prompt、事件 JSONL 和方法快照属于私有 trace。工作台提供安全投影，不能直接开放任意文件路径。
