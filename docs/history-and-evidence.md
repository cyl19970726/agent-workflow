# 历史与验证证据导览

历史回答当时做过什么、观察到什么以及判断为何改变；现行定义回答现在采用什么。日期化记录和 raw 材料不冒充正式设计，完整论证也不因篇幅长就降格为 raw。当前能力与下一步仍只查 [建设状态](harness-roadmap.md)。

## 按问题追证据

| 需要追溯什么 | 记录入口 | 证据范围 |
| --- | --- | --- |
| 产品判断如何形成、怎样审阅与修正 | [认知六章](../../../docs/product-understanding.md)、[认知审阅与验证](../../../docs/product-understanding/review-and-validation.md) | 包含完整推导、反例与当次核查；具体源码观察有时点 |
| 原工作台使用为何不能说明产品已完成 | [认知实用审查](cognition-execution-loop.md) | 实际阅读路径、失败与局部改善；不代替现行交互合同 |
| 首轮页面、方法图、过程资产怎样交付 | [页面交付](workbench-implementation-2026-10-05.md)、[方法图交付](workbench-method-implementation-2026-10-05.md)、[过程资产交付](workbench-process-implementation-2026-10-05.md) | 日期化实现与检查结果，保留当时限制 |
| 执行管理、验证比较怎样建设 | [执行交付](workbench-execution-implementation-2026-10-06.md)、[验证比较交付](workbench-validation-implementation-2026-10-06.md) | 有界工程交付，不推导完整业务有效 |
| 当时计划与交付差异 | [过程资产计划](workbench-process-implementation-plan-2026-10-05.md)、[验证比较计划](workbench-validation-plan-2026-10-06.md)、[Archify 接入记录](archify-integration-plan.md) | 保留原安排及核查时点，当前进度回到 roadmap |
| 方法包是否实际送达 Codex | [Skill 包加载验证](skill-package-verification.md) | 包交付与回归证据，不等于业务效果得到验证 |
| 旧交互原型怎样被检验 | [历史原型与走查](../../../docs/product-design/prototype-round.md) | 历史方案与观察，当前设计仍沿用 Archify |
| 本次文档怎样重组 | [文档架构依据与实施记录](../../../docs/documentation-architecture.md) | 阅读职责、原路径及图资产保留，文档验收不等于产品验收 |

## 图资产与原来源

[生命周期与方法形成原文](../../../docs/product-understanding/lifecycle-and-methods.md)保留两张图及完整论述；新入口分别在 [产品架构](product-architecture.md)和 [工作路径](workflow-practice.md)。[线框文章](../../../docs/product-design/wireframes.md)保留十二张 SVG。图的编辑源、candidate JSON、生成器与历史版本原位保存，不作为当前正式规则逐一进入导航。

## 私有历史与两类 trace

Workflow 的完整执行 trace（包括节点）用于迭代 workflow，私有材料留在受控运行存储，文档只引用可公开的合同、结论及证据范围。外层设计 Agent 的 skill＋CLI session trace 暂保留原记录及可找回来源，未来用于提升设计 skill；当前不新增统一入库、结构化建模、自动关联或前端栏目。保留历史不等于全文可公开，也不等于自动进入后续节点上下文。


## 架构文档整理前的完整快照

2026-10-10 对架构正文重新组织：现行机制进入[系统总览](architecture.md)与各专题，旧推导、讨论与目标协议完整保留在以下快照。快照反映整理前文字，旧能力判断和拟议 API 不作为当前合同。

- [系统总览](architecture-history-2026-10-10.md)
- [Space 领域与业务交接](workflow-spaces-history-2026-10-10.md)
- [方法、执行与资产的设计推演](workflow-process-assets-history-2026-10-10.md)
- [存储、SDK 和恢复的原方案](postgres-sdk-plan-history-2026-10-10.md)
- [R2 接入后的原存储说明](storage-architecture-history-2026-10-10.md)
- [前端技术原提案](space-frontend-architecture-history-2026-10-10.md)
- [Space 接入原说明](space-storage-history-2026-10-10.md)
