# 前端与交互设计导览

前端使人从准确事实理解业务、作决定并继续工作。**正式交互要求由 [工作台产品与交互合同](workbench-presentation.md) 维护**；根目录的布局、状态、场景与线框保留具体方案及论证。这里串联它们，不将原型或线框中的动作宣布为已实现能力。

## 从产品关系走到页面

先读 [产品架构](product-architecture.md)，确定这次任务围绕哪个对象、需要作什么判断；再读交互合同的 [用户任务](workbench-presentation.md#用户来这里要完成什么)和 [Space 工作台分工](workbench-presentation.md#整个-space-的工作台分工)。方法预期、运行实例、资产关系、版本演进分别表达不同语义，不能混成一张意义不明的图。

## 现行设计的阅读顺序

1. [完整交互合同](workbench-presentation.md)：图中心、选择与详情、准确对象、业务与方法两条闭环，以及能力边界。
2. [整体布局推导](../../../docs/product-design/layout.md)：从责任和对象推导航、主体及跨入口路径。
3. [页面线框与推导原则](../../../docs/product-design/wireframes.md)：十二张 SVG，展示各页信息、选中状态与阅读路径。
4. [关键决定与状态](../../../docs/product-design/decisions-and-states.md)：冲突、缺证据与动作作用范围。
5. [场景走查](../../../docs/product-design/walkthroughs.md)：检查连续任务，保留合成样例与未验证事项的边界。

沿用 **Archify 主画布＋点选详情**：图承担关系及定位，详情承担准确对象的内容、评价和执行依据。资产可以展开阅读并回到原图选择；列表用于检索与对账，不替代已有图资产。实际查看器操作见 [Archify 指南](archify-viewer.md)。

## 方案、实现与验证各自在哪里

[设计导览](../../../docs/product-design/README.md)说明提案的权威边界；[历史原型](../../../docs/product-design/prototype-round.md)保留曾做过的观察，不作为现行 Archify 形态的替代。技术落地进入 [Space 前端技术架构](space-frontend-architecture.md)，安排进入 [分批实施](space-frontend-implementation-plan.md)，已实现与仍缺什么只由 [建设状态](harness-roadmap.md)汇总。局部页面可点击、工程测试通过和真实业务可用分别成立。
