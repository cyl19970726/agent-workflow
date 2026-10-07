# 第二轮流程与资产工作台实现记录

2026-10-05。依据 [流程、执行与资产设计](workflow-process-assets.md)，实施计划见 [本轮计划](workbench-process-implementation-plan-2026-10-05.md)。本记录由实施会话维护；核心设计与独立最终验收由主会话维护。本轮完成实现和确定性验证，未运行内容模型，不据此宣称作品质量改善。

## 已实现的结果

共享 Spaces 包提供 `ProcessContract → ProcessOccurrence → RelationProjection`。方法入口保存不可变流程合同及 hash；新运行绑定对应合同身份，展示版本独立。旧运行没有补写 processHash、实例、方法指纹或核心事件。历史解释明确携带 resolver 版本与依据；未知步骤仍保留。

流程声明复用冻结存储节点及端口，覆盖先后、并行、汇合、条件出口、有限返工、人工关口与多份结果。并行组和组内分支分别表达，CONTENT 的 `reviewers` 组包含 `reader`／`checker`；技术重试不成为新业务轮次。实例保留全部 step、attempt、context、session、准确输入输出及失败恢复证据。

新执行的语义关系与产物发布、核心收据在同一数据库事务内保存，先验证身份、端点、schema、片段及 cardinality，再确认幂等请求。显式片段引用不由普通依赖猜测。关系更正和撤回为追加记录，读取不会重新推导已撤回的新关系。新决策的实例与选择也和原生 `decision.recorded` 收据原子保存；`selectionOnly` 表明选择不等于已执行返工，实际执行预算继续由原生工作流控制。

统一 `service.process` 与 `assetNeighborhood` 查询供程序、operator、CLI 及页面消费。邻域有稳定分页及授权边界。通用页面没有 CONTENT 类型或业务路由判断；共享测试以采购报价演示并行、返工和多份结果。CONTENT 仅提供其流程、准确旧记录解析、引用声明、业务阅读和展示名称。

页面支持方法／实际执行切换，轮次、节点、产物与语义关系联动。修订前后、反馈和本轮审阅使用具体轮次、节点与版本，普通依赖及原始证据折叠。手机使用等价列表。引用定位到冻结父资产的 JSON Pointer 与正文锚点，返回链接保留所选产物和轮次。流程阅读不放置绑定最终结果的评价表单；用户从结果页作评价和接受。

稿件比较先显示运行、业务轮次、不可变版本与逻辑资产身份，再显示中文字段、连续口播和画面条目。没有稳定段落身份时明确按顺序对照，不能据此判断段落移动或质量改善。作者的改动声明、独立审阅、用户四问和接受分别保留。

## 文件归属

| 位置 | 本轮责任 |
| --- | --- |
| `packages/spaces/process-contract.ts`、`process-projection.ts`、`relation.ts` | 共享合同、实例与关系模型 |
| `packages/spaces/service.ts`、`types.ts`、`migration.ts`、`runtime.ts`、`operator.ts` | 合同冻结、授权事务、决策与关系持久化、统一查询及工具入口 |
| `packages/spaces/process-render.ts`、`console.ts` | 通用联动页面、精确片段和返回选择 |
| `packages/spaces/presentation.ts`、`workbench-model.ts`、`workbench-render.ts` | 比较声明与阅读、具体来源、运行身份和注意状态 |
| creation `src/spaces/process.ts`、`runtime.ts`、`content-workbench.ts`、`content-host.ts` | CONTENT 声明、准确执行映射、新方法与运行接线 |
| creation `src/spaces/presentation.ts`、`readers.ts`、`scripts/content-space.ts` | 中文展示、材料／研究／稿件阅读及 CLI |
| 对应共享与 creation 测试 | 端点／权限／幂等／事务、历史兼容、并行／重试／多结果、片段和阅读回归 |

此表描述本轮修改责任，不表示这些文件及未提交目录均由本轮新建。既有变更、私有历史与其他工作台均保留；未提交、推送、清理或安装全局 skill。

## 验证证据

使用 Node 24、root pnpm workspace 和独立测试 PostgreSQL。业务数据库没有承载合成运行。

| 检查 | 结果 |
| --- | --- |
| creation 完整 `check` | 23 文件、149 测试通过；类型检查及两个前端构建通过 |
| 共享相关测试最终集 | 9 文件、66 测试通过 |
| 最后阅读与页面回归 | 3 文件、21 测试通过；creation 流程 6 测试及最终类型检查通过 |
| 共享构建 | 完整包构建通过，末次 Spaces 类型构建通过 |
| 文档 | 内部链接构建通过；本记录加入后再次构建 |
| 浏览器实施核对 | 1728px 桌面及 390px 手机无页面横向溢出；方法、D2 关系、准确材料片段及返回、D1／D2 比较、第三轮失败证据均读取核对 |
| 历史保护 | 18 张既有业务／执行表的数量和内容哈希前后完全一致 |

完整检查曾发现并行组标识与组内分支混用，修正为独立的 `branch` 声明并增加错误分支声明回归后通过。新确定性 CONTENT 测试实际经过冻结合同、原生并行步骤、决策、发布、反馈修订及比较，不仅验证构建。

私有日志、查询结果、哈希快照及截图保留在 gitignored `.local/workflow-workbench/`：`round2-creation-check-verified.log`、`round2-shared-tests-final.log`、`round2-linked-final-tests.log`、`round2-process-final-test.log`、`round2-final-typecheck.log`、`round2-process-final.json`、`data-round2-before.json`／`data-round2-after.json`、`round2-browser-final.json`。连接参数、模型输出及完整执行证据未进入公开文档。浏览器核对使用 ego-browser TaskSpace 44，已完成关闭；主会话独立验收仍需另行判断。

## MiMo 只读核对与服务

固定案例仍是一次运行、三份稿件、一份研究复用、六条冷读／核查分支。D2 关联准确 D1、第一轮主编意见、第二轮冷读／核查／主编意见及后续 D3；研究和材料来自冻结输入。第三轮的作者失败与失败发布都保留在第三轮，恢复后没有第四稿。原生状态为轮次用尽、尚未收敛，用户没有接受。

历史查询的合同来源为 `retrospective`，`run.process` 仍不存在；第三轮原始选择是改稿，停止解释来自原生终态预算证据。现有业务库只增加必要迁移及独立展示 revision 2 绑定，没有发布新业务方法或启动运行。新方法的流程冻结与决策关系记录已在隔离数据库验证。

服务保留：工作台 `http://127.0.0.1:4393/workbench`，文档 `http://127.0.0.1:4340/docs/site/index.html`，原有业务 PostgreSQL 持续运行。可从案例的过程页选择第二轮，或直接使用 CLI 的 `process --run` 与 `neighborhood --asset --run` 查询同一模型。

## 尚未证明的边界

本轮没有重新运行内容模型，未改变 prompt、审阅标准或原生业务路由，未证明内容质量改善。反馈使用关系仅证明准确输入，不能自动证明反馈已落实或问题已解决。没有生产部署、多用户身份产品、图编辑器、自动段落语义对齐、多 workflow 浏览器演示、B3 或 VM 扩展。

共享全库 `verify` 之前的例子包解析、read-model SQLite 包解析和 Codex SDK 版本读取问题仍按 [路线文档](harness-roadmap.md)披露；相关构建与测试通过不等于共享库完整发布验收。本轮不重复扩测或改动这些无关限制。
