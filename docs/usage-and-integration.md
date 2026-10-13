# 使用与开发接入导览

本组回答当前如何运行、编写与接入。产品目标不是 API 完成声明；在选接口前读 [系统架构](architecture.md)的模块边界，再用 [建设状态](harness-roadmap.md)核对能力范围。

## 按接入任务选择指南

| 要完成的工作 | 当前指南 | 需要注意的边界 |
| --- | --- | --- |
| 第一次运行或以 submodule 使用 | [快速开始](getting-started.md) | 使用 Node 24、固定共享版本；示例是否调用真实模型分别说明 |
| 编写步骤、并行、阶段和恢复 | [编写工作流与 API](writing-workflows.md) | replay 按节点复用，不恢复任意 JavaScript 堆栈 |
| 查询目标、准确版本、节点与预期资产 | [最小只读 Operator CLI](operator-cli.md) | 复用宿主认证与安全 HTTP 查询，不发布、不运行、不采用 |
| 配置 Codex 节点、方法包及 trace | [Codex 与 Skills](codex-and-skills.md) | 方法包交付、实际遵循和成果质量分别验证 |
| 接入 Space 服务、节点 client、运行任务和 HTTP | [Space 存储接入](space-storage.md) | 以当前导出与权限合同为准，不能将底层记录当作完整业务闭环 |
| 使用 PostgreSQL 执行账本 | [PG 存储指南](postgres-storage.md) | 这是有界的 run store，不等于完整资产 harness |
| 接入宿主、队列与现有工作台 | [宿主集成](integration.md) | 消费者提供领域工具、政策、schema、评价与阅读器 |
| 使用服务端安全投影与浏览器合同 | [前端读模型](frontend-integration.md) | 浏览器不直接访问数据库、任意文件或私有 trace |
| 操作已有图查看器 | [Archify 查看器](archify-viewer.md) | 当前操作能力与交互目标分开 |

## 从接口回到合同

[Space 存储合同](workflow-spaces.md)解释版本与资产归属；[流程、执行与资产关系](workflow-process-assets.md)解释方法声明、节点实例和实际关系；[存储与 SDK 方案](postgres-sdk-plan.md)说明目标方案与未决选择。SIWC Responses runner 是当前有边界的适配器，不能被称为一般 OpenAI Agents SDK 已完成。前端技术方案见 [Space 前端架构](space-frontend-architecture.md)。

## 验证接入的范围

指南保留原命令、示例和操作说明。确定性测试与无模型示例可以检查结构、存储和接口；运行真实模型需明确授权及条件。接入成功以后仍需按 [方法工作路径](workflow-practice.md)检查实际成果和评价；共享产品的完整验收与第二业务复用另有证据要求。
