# Agent Workflow：产品全貌与阅读路径

Agent Workflow 让真实业务的方法能执行、能评价、能持续改进，并让有效方法持续服务。**Space 承载长期业务目标，workflow 是在真实经营中逐步检验的可执行假设。** 设计 Agent 通过 skill＋CLI 构建方法，从观察者视角对照预期、实际构建与实际运行；Evaluator 提供评价证据，验证与采用分别承担责任。

这份导览按读者任务组织现有知识，不改变产品定义或 API。正式目标、对象和生命周期由 [product.md](product.md) 维护；当前能力与缺口只由 [建设状态](harness-roadmap.md) 汇总。内容创作是当前验证业务，工程通过不代表完整产品或业务效果已验收。

## 按任务开始

| 你现在要完成什么 | 连续阅读路径 | 读完能作什么判断 |
| --- | --- | --- |
| 第一次了解产品 | [目标与原则](product.md) → [产品架构](product-architecture.md) → [建设状态](harness-roadmap.md) | 为什么存在、怎样积累业务能力、目标与现状的差别 |
| 设计产品或检查交互 | [产品架构](product-architecture.md) → [前端与交互](interaction-design.md) → [线框](../../../docs/product-design/wireframes.md) → [场景走查](../../../docs/product-design/walkthroughs.md) | 对象与判断怎样落到图、详情、状态和连续任务 |
| 设计、执行和改进业务方法 | [方法工作路径](workflow-practice.md) → 设计 → 执行与交接 → 评价诊断 → 候选验证 → 采用与持续服务 | 本次结果如何归属，下一版为什么改，哪些证据支持采用 |
| 开发或接入能力 | [系统架构](architecture.md) → [接入导览](usage-and-integration.md) → 对应合同与 API → [建设状态](harness-roadmap.md) | 系统责任、当前可用接口、尚需建设的能力 |
| 接手、排障或审阅判断 | 当前定义／状态 → [认知方法与依据](../../../docs/product-understanding.md) → [历史与验证证据](history-and-evidence.md) | 哪些是现行规则，为什么形成，证据支持到哪里 |

## 系统架构从这里读

架构正文按一条具体业务怎样进入、执行、保存和被人读取来组织。先读[系统总览](architecture.md)，再按当前问题进入专题；接入例和历史讨论不再混在主线里。

| 阅读次序 | 本篇解释什么 | 细节边界 |
| --- | --- | --- |
| [总览](architecture.md) | 模块责任、准确身份、一次节点执行和一致性边界 | 不复制各专题字段和日期交付总结 |
| [1. Space 与合同](workflow-spaces.md) | 业务归属、schema、Case／输入冻结及节点访问 | 产品目标由 product.md 维护，API 在接入指南 |
| [2. 方法、执行与资产](workflow-process-assets.md) | 声明流程、实际轮次、准确生产消费和关系证据 | 图的布局与交互进入工作台合同 |
| [3. 执行 harness](postgres-sdk-plan.md) | 输入装配、执行器、trace、发布、失败与恢复 | 已实现协议与未来 SDK／恢复条件分开 |
| [4. 存储与一致性](storage-architecture.md) | PG 与对象字节、版本绑定、共同提交及跨存储故障 | 部署参数和命令在 Space 接入指南 |
| [5. 工作台与 API](space-frontend-architecture.md) | 授权 DTO、URL、缓存、图 bridge 和准确阅读 | 产品菜单与具体布局由展示合同维护 |

[Space 接入指南](space-storage.md)与[PG 账本接口](postgres-storage.md)用于调用；[建设状态](harness-roadmap.md)用于阶段判断；整理前的完整论述在[历史与验证证据](history-and-evidence.md)。历史保留推导和未完成协议的依据，不用来替代现行架构。

## 知识职责与维护位置

| 文档组 | 回答的问题 | 主要来源 |
| --- | --- | --- |
| 产品目标与原则 | 为什么做，为谁做，凭什么认为有价值 | [产品定义](product.md)，[目标推导](../../../docs/product-understanding/goals-and-paradigm.md) |
| 产品架构 | 哪些对象、责任、场景与生命周期共同完成业务 | [架构导览](product-architecture.md)，正式对象仍在 product.md |
| 前端与交互设计 | 人怎样找到、理解并操作准确对象 | [交互导览](interaction-design.md)，交互合同与具体线框 |
| 系统技术架构 | 模块如何实现责任，数据与控制怎样流转 | [系统架构](architecture.md)，Space／过程资产／执行器合同 |
| 工作流设计与调优 | 操作者怎样形成首版、运行、评价与改法 | [方法工作路径](workflow-practice.md)，原有完整指南 |
| 使用与开发接入 | 当前命令、接口及适配方式 | [接入导览](usage-and-integration.md)，当前 API 指南 |
| 建设状态与路线 | 已交付、缺口、下一阶段和验收范围 | [唯一状态入口](harness-roadmap.md)，[实施安排](space-frontend-implementation-plan.md) |
| 认知方法与设计依据 | 怎样推导、反驳、检验与修正判断 | [认知六章](../../../docs/product-understanding.md)，完整论证原位保留 |
| 历史与验证证据 | 当时发生什么，哪些观察支持当前判断 | [证据导览](history-and-evidence.md)，日期化记录与历史原型 |

网站各组可以展开；它们是阅读分类，不是工作台菜单或强制操作顺序。规范、候选设计、当前实现与某次验证结果分别标明，不能因为放进某个目录就升级为已实现能力。

## 图与可审阅设计

[Workflow 生命周期与职责](product-architecture.md#生命周期与可视化入口)保留原生命周期图；[候选方案与 skill 方法图](workflow-practice.md#形成候选执行方案)解释已有能力内调优与 dogfood 分流；[十二张页面线框](../../../docs/product-design/wireframes.md)继续展示 Archify 图中心、点选详情与阅读返回路径。原图、交互 HTML、编辑源和历史版本不因文档重组而替换。
