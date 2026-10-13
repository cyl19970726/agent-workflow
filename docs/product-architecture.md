# 产品架构：对象、责任与生命周期

产品架构解释怎样完成业务并积累方法。它连接正式定义和使用路径；**对象、生命周期与版本规则的唯一规范仍在 [产品定义](product.md)**，详细字段与存储行为在系统合同中维护。

## 从长期目标到具体工作

Space 对应长期业务目标，组织相关 workflow、方法版本、Case、运行、资产和改进证据。一次 Case 表达本次业务要求；run 绑定准确方法与输入，保存实际节点执行和成果。资产的逻辑身份与准确正文版本分开；评价绑定准确被评对象和条件，不能把后来修订的成品当作原运行成果。

阅读正式 [对象定义](product.md#必须分清的对象)与 [完整版本对象](product.md#准确版本是完整的认知对象)，再读 [Space 合同](workflow-spaces.md)、[方法／执行／资产三个层次](workflow-process-assets.md#2-通用模型同一件业务的三个层面)。本页不另建字段表或一套版本评分规则。

## 谁承担哪些判断

业务使用者明确要求并判断成果的用途；设计 Agent 用 skill＋CLI 形成预期和可执行首版。节点按输入、工具、权限、输出及结束合同工作。观察诊断对照预期、实际构建、实际运行及业务效果，Evaluator 在明确范围内提供评价证据。候选验证检验原因假设，有权者依据验证证据决定采用、继续试验、回退或不改。

同一个人或 Agent 可以承担多项责任，但评价结论、诊断解释与采用决定不能混为一次自动通过。正式要求见 [设计 Agent 的观察者视角](product.md#设计-agent-保持观察者视角)、[判断责任](product.md#当前由谁完成判断)，推导理由见 [场景、责任与对象](../../../docs/product-understanding/responsibilities-and-objects.md)。

## 生命周期与可视化入口

![Workflow 生命周期：首版、真实运行、评价诊断、候选验证、采用和稳定服务，以及 dogfood 分流。](../../../docs/diagrams/workflow-paradigm-20261007/workflow-lifecycle-final4.svg)

[打开原交互生命周期图](../../../docs/diagrams/workflow-paradigm-20261007/workflow-lifecycle-final4.html) · [完整论述与阶段转换依据](../../../docs/product-understanding/lifecycle-and-methods.md#完整生命周期研发与稳定服务持续相连) · [正式生命周期](product.md#工作流的完整生命周期)

首版是可执行假设；稳定版持续处理业务，候选可以并行研发和验证。发布候选不自动替换采用版本，每次 Case 不必重走实验管理。反馈可晚于运行到达，周期复盘可决定继续旧版或停止改进。操作步骤沿 [方法工作路径](workflow-practice.md) 阅读。

## 三个循环与两类 trace

本次业务循环交付可用结果；方法改进循环从 workflow 的真实执行证据形成、验证和采用候选；共享产品循环把底座能力缺口分流为 dogfood issue，交付后回原业务复验。它们共享证据，责任与完成条件不同。详见 [调优循环](tuning-loop.md)及 [跨层分流理由](../../../docs/product-understanding/learning-and-dogfood.md)。

**Workflow 执行 trace 包含各节点，用于后续迭代 workflow。外层设计 Agent 通过 skill＋CLI 工作的 session trace 暂保留，未来用于提升设计 skill。** 后者目前不要求统一入库、结构化建模、自动关联或新增前端栏目；保留来源与必要引用即可。设计背景、运行事实和后来解释仍需区分，完整边界见 [两类历史](product.md#构建历史与运行历史共同成为证据)。

## 从场景进入交互与系统

日常业务从 Case 与成果进入，设计研发从准确方法进入，复用从资产进入，接手从目标、当前采用、未解问题及依据进入。场景理由见 [对象与责任论证](../../../docs/product-understanding/responsibilities-and-objects.md)，其具体呈现进入 [前端与交互设计](interaction-design.md)。模块责任、存储和执行合同进入 [系统技术架构](architecture.md)；当前能支持到哪只查 [建设状态](harness-roadmap.md)。
