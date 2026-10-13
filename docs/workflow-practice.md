# 工作流设计与调优：完整工作路径

这组指南服务业务方法的操作者与设计 Agent。目标是让 workflow 实际完成业务，再依据证据改善它；不同于“怎样认知这个产品”的方法论。节点可以使用 prompt＋tools、可选 skill 和已支持的执行器，不强制所有节点 skill 化。

## 从目标到持续服务

| 阶段 | 使用指南与需要留下的材料 |
| --- | --- |
| 明确业务目标、形成预期与首版 | [设计 Workflow](designing-workflows.md)：从新意图或 session 历史恢复方法，说明职责、交接、标准、结束条件和设计理由 |
| 构建与实际执行 | [编写 API](writing-workflows.md)、[Codex 与 Skills](codex-and-skills.md)、[Space 接入](space-storage.md)：绑定准确方法、输入及能力，让节点产生业务成果 |
| 评价与观察诊断 | [评估指南](evaluating-workflows.md)、[调优循环](tuning-loop.md)：读结果和整个 workflow trace，对照预期、实际构建与运行；评价者也需校准 |
| 形成并验证候选 | [优化指南](optimizing-workflows.md)：区分修本次产物与改以后方法，提出可推翻假设，解释条件差异、收益和退化 |
| 采用与持续服务 | [每轮有范围的决定](optimizing-workflows.md#每轮给出有范围的决定)、[稳定使用窗口复盘](evaluating-workflows.md#稳定使用窗口的复盘)：决定采用、继续旧版、补证据或停止，保持稳定版与候选并存 |

第一次使用已有方法不必先建立实验。已有运行的恢复、重试和新运行取决于执行器当前语义，不能仅凭指南承诺任意暂停续作。当前运行接口和保证见 [接入导览](usage-and-integration.md)；完整目标见 [生命周期规范](product.md#工作流的完整生命周期)。

## 形成候选执行方案

![在已有能力内形成候选执行方案与 skill，共享能力缺口分流为 dogfood issue，验证之后决定采用。](../../../docs/diagrams/workflow-paradigm-20261007/skill-development-final4.svg)

[打开原候选方案与 skill 开发图](../../../docs/diagrams/workflow-paradigm-20261007/skill-development-final4.html) · [完整方法形成论述与候选选择依据](../../../docs/product-understanding/lifecycle-and-methods.md#候选执行方案怎样形成skill-怎样在其中开发)

调优可以改变流程结构、节点职责、Prompt、工具、上下文、可选 skill 或已支持的执行器。新增共享执行器、存储或接口属于 harness dogfood issue；交付以后回到原业务复验，不能把 issue 关闭当作方法改善。具体分流见 [调优与 Dogfood](../../../docs/product-understanding/learning-and-dogfood.md)。

## 正确使用两类 trace

Workflow 执行 trace 包含节点，是评价和迭代该 workflow 的依据；外层设计 Agent 使用 skill＋CLI 的 session trace 暂保留，未来改善设计 skill。当前不要求后者统一入库、自动关联或新前端栏目。不要以宿主补做的成果证明 workflow 已独立完成。现有 trace 使用步骤保留在 [调优循环](tuning-loop.md)和 [Codex 指南](codex-and-skills.md)，私有原始记录不复制进文档站。
