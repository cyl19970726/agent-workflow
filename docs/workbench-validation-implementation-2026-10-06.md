# 第 4 步：固定验证计划与版本比较

本轮实现 [认知执行合同第 5—7 节](cognition-execution-loop.md)。工程交付与认知侧产品验收分别记录；确定性执行器不证明 CONTENT 内容质量。私有夹具、截图、运行回读及实际通知结果保存在主项目 `.local/cognition-loop/round-04/`，不提交到仓库。

## 人的操作路径

从工作台进入“验证计划”，选择两个已发布准确版本及入口，固定案例、input manifest、计划重复次数、评价标准、判者、允许变化的配置键和排除规则。草稿及冻结条件均不可覆盖；修订使用新的计划 ID，可引用被替换计划。

冻结之后，计划项先显式排队，再由原持久任务管理器派发。缺项始终存在，同一 run 不能重复计数，失败和重试保留全部 attempt。页面按案例及计划重复序号成对展示基线／候选，直接打开最终产物或完整方法图；准确输入、任务、native run、会话与身份可展开。

对准确最终结果填写人工四问，选择同案例同重复序号的准确基线评价；随后保存逐判者成对比较。观察与原因假设独立保存，有跨案例证据和下一轮假设，不推断已解决。采用由可信人类明确提交理由及同候选版本的比较证据，CAS 使用实际 adoption head，保留历史与未知项。发布和运行不会自动采用。

## 持久事实与边界

共享层增加 `ws_validation_plans/runs/reviews/comparisons/issues/exclusions`，复用既有 run、execution task、review、comparison、iteration 和 adoption。前瞻计划使用数据库原生单调 run 序号冻结界限，不用易冲突的客户端时间判断先后。事后集合必须明确标记，旧 run 显式关联并核对 Space、case、版本、入口、manifest 与准确配置。

配置变化采用准确的顶层键，例如 `models`、`nodeDefinitions`。不声明的额外条件差异拒绝比较。页面同时显示实际顶层差异；不能把示例中的点路径误当成支持的键。

状态读取任务及 native run；取消请求、中断、失败、取消优先于评价齐全。只有执行已结束并且所有所需判者有可信评价，条目才投影为已评价；每种判者各有成对比较才算配对完成。案例数、计划配对数、两版条目数与所有尝试数分别呈现；局部排除不把整个案例投影为已排除。

Agent 判者的冻结条件包含实际配置、指令与工具定义。SIWC adapter 在调用 harness 的工具回调后，把实际指令、工具 name/description/parameters 快照与工具 hash 留在可信运行事件中，使用同一快照发送请求。关联评价时核对独立完整 session、节点权限、目标资产、标准和实际 profile。历史评价缺少可核验 profile 时保留来源与差异／未知原因，但不计完整覆盖或公平配对；网页不能通过选择 Agent 标签冒充判者。人类身份来自 host 主体，表单／CLI 无权覆盖身份或冻结标准。

CONTENT 适配只负责已有 manifest 的业务解析、准确部署选择、入队及最终稿评价门槛。验证计划不会重新导入同一材料，不要求共享层理解稿件 schema，不新增自动 Agent 评价调度。没有历史准确执行器时拒绝替换为当前代码。

## 实现文件

- 共享持久合同与边界：`packages/spaces/types.ts`、`migration.ts`、`validation.ts`、`service.ts`。
- 通用协调及入口：`validation-workbench.ts`、`operator.ts`、`index.ts`。
- 页面及表单：`validation-render.ts`、`interactive-console.ts`、`console.ts`。
- 实际判者工具证据：`packages/agent-sdk/src/responses.ts`。
- 主项目 CONTENT 消费者：`workbenches/creation/src/spaces/content-workbench.ts`、`content-app.ts`、`scripts/content-space.ts`，及对应已有测试。

CLI 支持 `freeze-input`、`validation-create`、`validation-freeze`、`validation-plans/show/run/dispatch/review/link-run/link-review/compare/issue/exclude/iteration/adopt`。`validation-run` 只入队；`validation-dispatch` 才执行。`validation-plans` 只返回计划列表，`validation-show` 只返回该计划的完整 summary，不嵌入整个 Space overview；资产、上下文、会话和事件按准确 ID 用已有入口查询。连接与认证配置保存在私有 host 配置中，不作为模型输入或公开证据。

## 验证与已知限制

共享完整验证通过 227/227；最后补齐运行中状态的页面计数及 SDK 正向证据后，共享全套 PostgreSQL 测试再次通过 228/228（33 文件）。全部 8 包构建、30 份 Markdown 内链、示例类型及确定性示例通过。CONTENT 原全套 161/161 通过；最后 CLI 改动后，类型与两个前端构建再次通过，150 个常规测试及另行配置隔离数据库的 12 个 PostgreSQL 测试全部通过，共 162 项、25 文件。隔离计划身份、浏览器操作与重启证据以私有执行交接为准。验收包括：至少三个案例、同案例重复、失败和取消、缺跑和待评价；真实浏览器创建／冻结／排队／派发／四问／比较／问题／两次显式采用；CLI 创建与回读；服务和浏览器重启；真实历史 18 张业务表数量与内容 hash 前后相同。

自动测试覆盖准确条件和跨 Space 拒绝、重复 link、标准／身份错配、缺失执行器、独立 Agent 正向及多判者不足、同模型不同提示词／工具、无法核验历史 profile、active run 已有评价、过期 lease、中断统计和局部排除。Agent 正向测试实际执行 SIWC runner，以 stub HTTP 返回响应，可信 session 事件由 SDK 生成后持久化；没有真实模型调用。新增 CLI 回归通过实际命令验证完整 scoped JSON，与共享 summary 完全一致且无整 Space `data` 字段。

最终隔离服务停止并重启后，CLI、服务与浏览器均读回同一冻结计划：3 案例、4 计划配对、8 条目、7 尝试；已评价 4、待评价 1、失败 1、取消 1、缺跑 1，两个比较、两个问题与两次显式采用保留。重启没有新建运行或替换准确版本。页面窄屏仍保持同案例成对关系，实际点击打开完整方法和最终结果可读。主项目文档构建通过，网站含 59 页；CLI 帮助明确列出 validation-dispatch 可以调用模型。

当前 host 是可信本机操作者入口；本轮不扩展为公网认证服务。人类配置没有可独立观测的执行 profile，保留可信人类身份及冻结标准。工具配置证据覆盖提供给模型的定义，不声称证明外部工具服务的行为永不改变。Agent 自动调度、外层 chat 全文自动入库、VM、多 workflow 迁移与真实业务质量判断不在本轮范围。
