---
name: space-business-understanding
description: 通过 Agent Workflow 的业务理解入口读取、形成和修订真实 Space 的业务正文；用于阶段 1 和目标变化，不发布方法或运行业务模型。
---

# 形成并修订 Space 业务理解

从项目根目录使用 `pnpm --silent operator`；在消费方仓库使用 `pnpm --silent --dir vendor/agent-workflow operator`。设置 `WORKFLOW_OPERATOR_BASE_URL` 与 `WORKFLOW_OPERATOR_SPACE_ID` 指向受支持的宿主；认证按 [Operator CLI](../../../docs/operator-cli.md) 配置。不要在正文、来源或交付记录中保存认证值。

空白 Space 宿主的已实现命令、请求示例与能力边界见 [当前操作合同](references/operator-contract.md)。先读此合同，避免将旧宿主能力当成新 Space 能力。

先核对目标 Space 与宿主能力，再用 `understanding` 读取当前正文和准确修订，必要时 `understanding-history`、`understanding --revision ID` 恢复旧依据。用户要求从空工作台开始时，通过宿主明确支持的 CLI 创建并记录业务记录为空，不自动复制旧理解、设计、版本或结果；接口暂不可用就报告具体缺口，不用私下注入数据代替。没有正文时先检查实际业务文档、请求和 Case，不能把共享底座的目标填成业务本身的目标。

说明值得获得的业务结果、使用者和情境、问题、范围、成功与不可接受条件，连接关键业务工作及其理由、已有想法、证据和未知。写的是这个业务为什么值得做、怎样产生价值、怎样知道做到了，不是教读者操作平台。业务步骤不自动对应技术节点；完整业务周期与当前首版范围分清，原本目标不可因暂时没有工具而消失。单个 Case 的题目或受众变化不自动成为 Space 长期目标变更。区分材料直接记录、当前分析和待确认假设；原作者没有记录的历史意图不得补造。具体业务内容不写进本通用 skill。

通过 `understanding-save --file /absolute/path/REQUEST.json` 保存新增修订；`pnpm --dir` 会改变工作目录，使用绝对路径。请求包含：

- `expectedRevisionId`：刚读到的准确 ID；初版用 `null`。
- `idempotencyKey`：本次保存唯一键。结果未知时，原请求与原键重试；正文改变用新键。
- `title`、`content`（Markdown）、`changeReason`：完整正文及本次改动理由。
- `sources`：至少一条 `{kind,ref,title,excerpt?}`，kind 为 `document`、`case`、`asset` 或 `user-request`；保存准确引用与支持本次判断的摘录，文档可附内容摘要。来源是声明依据，系统不自动核验其结论。
- `authorship`：Agent 使用 `{kind:"agent",name,sessionId?}`，不要伪装成人类。系统独立记录认证保存主体；保存仍是未确认状态。

在独立设计验收宿主中，外层 Agent 须使用可信本机凭据绑定的 `design` 角色；观察角色与旧版未标角色凭据只读。此时 `name` 必须等于受信 Agent ID，`sessionId` 必须等于受信会话 ID；CLI 会预检，API 仍独立校验，保存者由认证 service principal 记录。不要使用人类 Cookie、自由填写的 Agent 名字或本机 owner 身份绕过该边界。各操作权限以宿主的明确授权能力为准；理解写权限本身不授予方法发布、运行或采用权。

保存冲突时读取新修订、比较变化并重新形成内容；不能盲目换预期 ID 覆盖他人的判断。成功后读回返回的准确 ID，核对正文、来源、前驱与作者。从普通前端入口亲读目标、标准、业务心智模型和来源，退出／重开确认同一修订，核对 CLI 同一事实。交付可读页面与准确引用；功能测试、独立实用验收和业务效果分别成立。

此入口仅新增业务理解资产修订，不修改旧 Case、方法、评价或采用；创建理解不授权执行模型、发布或外发。宿主的 owner 首次显式登记通用 schema，读取和服务启动不登记数据。接入合同见 [业务理解修订](../../../docs/operator-cli.md#业务理解的共享接入)。
