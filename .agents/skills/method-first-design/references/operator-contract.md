# 方法形成的 Operator 合同

先按 [业务理解操作合同](../../space-business-understanding/references/operator-contract.md)保存并读回有来源支持的准确理解修订。空白 Space 的创建和理解不依赖方法能力或设计；`summary.capabilities` 决定当前宿主是否已开放后续写入和登记。不要把其他宿主的能力、旧 CONTENT 方法或 Case 当成这个 Space 已具备的状态。

在 Creator Lab 根目录使用项目内 CLI。`--file` 必须指向绝对路径，因为 `pnpm --dir` 会改变工作目录：

```sh
pnpm --silent --dir vendor/agent-workflow operator capability
pnpm --silent --dir vendor/agent-workflow operator capability --revision EXACT_CAPABILITY_REVISION_ID
pnpm --silent --dir vendor/agent-workflow operator capability-history
pnpm --silent --dir vendor/agent-workflow operator capability-prepare --file /absolute/private/capability-authored.json --out /absolute/private/capability-ready.json
pnpm --silent --dir vendor/agent-workflow operator capability-prepare --file /absolute/private/capability-ready.json
pnpm --silent --dir vendor/agent-workflow operator capability-save --file /absolute/private/capability-ready.json
pnpm --silent --dir vendor/agent-workflow operator design
pnpm --silent --dir vendor/agent-workflow operator design --revision EXACT_DESIGN_REVISION_ID
pnpm --silent --dir vendor/agent-workflow operator design-prepare --file /absolute/private/design-authored.json --out /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator design-prepare --file /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator design-save --file /absolute/private/design-ready.json
pnpm --silent --dir vendor/agent-workflow operator design-definition --revision EXACT_DESIGN_REVISION_ID
pnpm --silent --dir vendor/agent-workflow operator method-preview --design EXACT_DESIGN_REVISION_ID
pnpm --silent --dir vendor/agent-workflow operator method-publish --design EXACT_DESIGN_REVISION_ID --expected EXACT_CANDIDATE_ID
```

常规保存先使用 prepare。能力输入提供已选 provider、节点的指令／输出 schema／模型／推理等级、验证计划、准确前驱或首版 `null`、改动理由；指令、schema 与验证文本可直接写原文字符串，由 CLI 计算原始 UTF-8 字节 hash。设计输入提供标题、说明正文、来源（使用 `ref` 字段）和改动理由。完整最小示例及可选字段以 [Operator CLI](../../../../docs/operator-cli.md) 为准，不在本 skill 重写整套请求 schema。

省略的 workflow 范围、受信作者、当前提交 head 和依据由认证接口读取并固定；业务提供方和前驱选择仍由 Agent 决定。若要沿用特定历史理解／能力，应显式提供准确修订选择，CLI 补齐并核对 hash，不用当前版本替换。设计引用的能力必须基于同一份理解；不一致时先决定正确依据，不能靠省略字段掩盖冲突。没有能力引用的旧式设计不能被解释成已有专业指令。

`--out` 新建私有请求文件，不覆盖已有文件；已准备文件使用不带 `--out` 的相应 prepare 命令复检。复检不改写内容和幂等键。核对正文差异、准确依据和前驱后，再交给原有 save；准备和复检均不向服务端写业务记录，不发布方法、不启动模型。prepare 的结构与引用检查不保证 provider 能执行任意节点、工具或拓扑，仍需下述完整定义核对。

准备后若 head 已变化，读回变化并判断是否形成新请求，不把重做 prepare 当成无条件覆盖许可。保存结果未知时先核对原收据／准确修订，再原样重试；更改正文、引用或操作意图需使用新的请求。准备文件和业务正文保持私有。服务端继续验证真实设计 Agent 署名、权限、准确依据、head 与幂等；本地检查不能替代它。草案保存仍为 `unconfirmed`。

`design-definition --revision ID` 根据固定设计／能力与当前 provider 实现编译完整候选；同一设计修订在实现变化后可能对应新的候选 ID，只有登记后的准确方法版本才冻结。DTO 包含：`candidateId`、准确设计／理解／能力修订与 hash、provider 契约和 fingerprint、完整 `version`、全部 `schemas`、`presentation`、预期资产合同 `expectedAssets`、执行 `availability` 及准确 `diagramUrl`。用同一设计 ID 读取过程图，逐节点核对实际指令、模型、推理等级、schema、工具允许列表、上下文策略、路由、返工上限、预算和冻结依据；不能以 `method-preview` 的短摘要代替。`method-preview` 保留旧调用兼容。

登记使用 `method-publish --design ID --expected CANDIDATE_ID`，带能力的候选 ID 取刚读到的 `design-definition.candidateId`，并与重新读取的 `method-preview.versionId` 核对一致。只有保存这份草案的同一受信 `role:design` Agent 与会话、匹配的系统保存者才能登记；发布权限来自宿主委托和同源 CSRF，不由请求文件中的署名自行授予。后继候选还须有准确前驱。登记只形成方法版本，不启动 Case 或运行，也不表示已经验证、采用或可执行。当前早期候选在受保护的运行入口接入并核验匹配部署之前保持不可执行。

v3 计划要求研究节点试做与正式 Case 首轮使用同一冻结指令、输出 schema、首轮上下文投影和 `read_bound_asset` 工具合同；不得用无工具捷径。试做最多 2 次实际 provider POST：首次原尝试；第二次只可用于工具续轮或一次技术修复，修复最多一次且不增加第三次请求。试做与同一 Case 共用 15 次已预留 provider POST 上限，失败、工具续轮与技术修复均计数；工具函数调用另记，不增加模型 POST 数。60 分钟从首次成功预留请求开始，等待与诊断期间不停表。受保护运行入口要持久核验这些限制，它们不是 token 或金额上限。

私有 runtime 的 `enableExplanatoryExecution` 默认 false；只有明确设 true 才允许执行变更命令。旧 v1/v2 历史保留；方案、构建和候选可读不表示模型试做或正式 Case 已通过。

普通阅读入口 `/space-workbench/:spaceId` 展示准确设计和候选。公开文档只放字段形状与示例，不复制私有业务正文、来源、凭据、宿主特定 ID 或 trace。建设与验收边界见 [建设路线](../../../../docs/harness-roadmap.md)。
