# Operator CLI：准确取证、业务理解与方法候选

这个入口让设计 Agent 从宿主已认证的 Space API 取得业务目标、准确方法版本及其预期资产合同。目标／版本／节点查询发送 GET 请求，复用服务端的 Space 成员、方法范围和安全投影。业务理解、方法能力与设计草案分别保存不可变修订；宿主开放相应能力时，可阅读完整候选并明确登记准确版本。保存草案不表示用户确认；登记版本不表示可执行、已运行、已验证或已采用。Case 取证命令读取共享 API 投影的准确运行、资产及有界 session 事件；评价与处置命令另行记录可读回的判断，不运行模型、不采用方法，也不直接读取数据库或原始 trace 文件。完整产品目标与当前缺口见[建设路线](harness-roadmap.md)。

在使用 CLI 前，由宿主提供可访问的 Space API 和操作者认证。以下变量可由私有环境注入，不要把凭据写入命令参数、日志或文档：

```sh
export WORKFLOW_OPERATOR_BASE_URL='http://127.0.0.1:4397'
export WORKFLOW_OPERATOR_SPACE_ID='your-space-id'
# 宿主需要时，在私有环境中设置下列其中一个：
# WORKFLOW_OPERATOR_AUTHORIZATION 或 WORKFLOW_OPERATOR_COOKIE
# 外层 Agent 改用 WORKFLOW_OPERATOR_TOKEN_FILE=/absolute/path/private-agent-credential.json
```

## 先写业务内容，再准备保存请求

设计 Agent 决定 provider、各节点的完整指令、完整输出 schema、模型选择、验证内容与变更理由；CLI 负责从当前认证 Space 读回并固定范围、作者、依据、预期 head、原文哈希和幂等键。准备操作不发布、不保存业务修订，也不执行模型。

```sh
pnpm --silent --dir vendor/agent-workflow operator capability-prepare \
  --file /absolute/private/authored-capability.json --out /absolute/private/ready-capability.json
pnpm --silent --dir vendor/agent-workflow operator design-prepare \
  --file /absolute/private/authored-design.json --out /absolute/private/ready-design.json
# 重开同一准备请求：只读复检，不重写文件、换键或自动跟随新 head。
pnpm --silent --dir vendor/agent-workflow operator capability-prepare --file /absolute/private/ready-capability.json
pnpm --silent --dir vendor/agent-workflow operator design-prepare --file /absolute/private/ready-design.json
```

`--out` 必须是不存在的、与输入不同的绝对路径；输出以 `0600` 独占创建，拒绝符号链接和覆盖。输入须为普通 UTF-8 JSON 文件，复检已准备文件还要求私有权限。请求文件只含原有 Save 正文；标准输出是精简核对摘要，列出准确依据、作者、预期 head、幂等键及内容哈希/字节数，不打印节点指令、设计全文、CSRF 或认证令牌。准备后审阅该私有文件；确实决定保存时，将**同一文件**交给原有 `capability-save --file` 或 `design-save --file`，原有服务端权限、CSRF、范围、引用及 CAS 检查照常执行。准备成功不保证稍后 head 不变，冲突时须重新读取和判断，不自动改写原意。

能力 authored 文件的最小格式如下；示例仅展示一个节点，实际必须提供所选 provider 所需的完整节点集合。

```json
{
  "provider": {"id": "host-registered-provider", "contractRevision": "registered-revision"},
  "nodes": {
    "node-id": {
      "instructions": "节点的完整原始指令\n",
      "outputSchema": "{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"string\"}},\"required\":[\"answer\"]}",
      "model": "chosen-model",
      "reasoningEffort": "chosen-effort"
    }
  },
  "validation": "{\"checks\":[]}",
  "predecessorVersionId": null,
  "changeReason": "本次业务能力的具体变化与理由"
}
```

`instructions`、`outputSchema`、`validation` 可用原文字符串、`{content}` 或 `{content,sha256}`；提供 hash 时必须匹配。哈希按原始 UTF-8 字节计算，不 trim、不重排 JSON。输出 schema 必须为 JSON 对象文本，验证内容必须为合法 JSON；CLI 不替 Agent 编写专业内容或判定方案有效。`predecessorVersionId` 必须由 Agent 明确选择，首版填 `null`；已选前驱通过同 Space 版本 API 核对准确 ID 和 `entrypoint`，保存端仍核对完整 workflow 关系。

设计 authored 文件的最小格式：

```json
{
  "title": "方法设计",
  "content": "完整的业务设计正文与理由",
  "sources": [{"kind": "document", "ref": "docs/source.md", "title": "准确依据", "excerpt": "实际使用的依据"}],
  "changeReason": "为什么作这次设计修订"
}
```

来源只接受原有 `kind/ref/title/excerpt?` 合同，不接受用 `reference` 代替 `ref`。省略 `understanding` 时读当前理解并固定准确修订及 payload hash；显式 `{revisionId,payloadHash?}` 时准确重读该修订，历史选择不替换为最新。设计同样省略 `capability` 时固定当前能力；首次没有能力时可保持无绑定，显式 `capability:null` 也选择无绑定。显式旧能力须与所选理解匹配。`workflowId/entrypoint/authorship/expectedRevisionId/idempotencyKey` 可省略交给准备补齐；显式值须通过现有认证、范围、head 与引用检查。已有完整 Save 文件复检始终保留其键、署名、历史引用和无能力绑定；不会自动 rebase。未知字段、坏 hash、不同范围、坏引用、旧 head 或无写权限均拒绝创建请求。

## 一次取得运行概览，按节点继续查证

```sh
pnpm --silent --dir vendor/agent-workflow operator run-evidence <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator run-evidence <exact-run-id> \
  --occurrence <exact-occurrence-id> --max-pages 2
```

默认顺序只 GET Space summary、run、冻结输入 manifest 与 process，共四次读取；不默认抓版本全图、Case 全文、节点上下文、runtime、trace、评价标准或资产正文。结果保留准确版本/Case、已记录的 `executionMode`、状态、输入版本与 hash、实际 occurrence、已产出资产、失败及过程缺口。`executionMode:null` 表示 API 未记录；完成状态和输出数量不能推导为完整 Case 已运行，更不能推导业务质量通过。

默认最多列 10 个实际 occurrence；`--max-occurrences 1..50` 调整概览上限，超出时 `coverage.truncated` 明确注明。未读的 `attempts/runtime/trace` 为 `null`，覆盖状态为 `not-loaded`；这是继续查证的索引，不是完整运行调查。过程的 `partial/unknown` 和 `unmappedStepIds` 原样保留。每项 `read` 提供参数数组形式的准确继续命令，包括 `run-evidence --occurrence`、原有 `occurrence` 与失败未发布响应入口；顶层保留原有 run、inputs、process、version 和 Case 入口。

显式 `--occurrence` 才读取该节点的上下文，各 Agent/program attempt 分开。program 不查询 Agent runtime/trace。每个 Agent runtime 默认最多 2 页，每页 100 个保存事件；`--max-pages 1..10` 可调整，未读完时标为 truncated 并保留 cursor。trace 仅抽样首页，存在后续页时标为 preview/unknown、`sampledEvents` 及 partial，不能把抽样数当全程总数。缺失或 5xx 局部读取失败标为 missing/unavailable；错误身份、跨 run/版本/Case/attempt 关系、401/403 或坏 cursor 直接失败。不会将缺失、截断或局部失败写成零证据或完整覆盖。

需要真实正文、全量分页或评价时，继续使用原有 `asset/runtime/run-trace/review-subjects/reviews/dispositions/diagnosis` 命令；新入口不代替这些专业读取和判断。所有聚合读取复用现有认证 HTTP API 及安全投影，不访问数据库或本机 trace，不启动业务、不新增评价，也不把读回结果当成 Agent 已经理解。

## 从业务空白的 Space 开始（A1）

独立的空白设计宿主使用 `createDesignWorkbench`，按宿主允许名单与私有凭据中的 `spaceIds` 交集限制目标。启动、目录读取和打开页面不创建 Space。只有显式 `role:design` 的服务身份可请求创建；请求不接受操作者身份字段。宿主以人类 owner 的受限委托，在同一 PostgreSQL 事务内写入新 Space、owner／设计 Agent 成员、`workflow/business-understanding@1` schema 和不可变创建回执。已有 Space 不会被接管。

宿主实际开放的操作以 `summary.capabilities` 为准。创建与业务理解可独立完成；能力修订、设计草案、候选阅读与登记需要宿主另外接入。Case 运行、评价与采用各有独立授权。

外层 Agent 可先读取允许范围与目录，再创建：

```sh
export WORKFLOW_OPERATOR_BASE_URL='http://127.0.0.1:4400'
export WORKFLOW_OPERATOR_SPACE_ID='your-new-space-id'
export WORKFLOW_OPERATOR_TOKEN_FILE='/absolute/private/design-credential.json'
pnpm --silent --dir vendor/agent-workflow operator onboarding
pnpm --silent --dir vendor/agent-workflow operator space-create --file /absolute/private/space-create.json
pnpm --silent --dir vendor/agent-workflow operator space
```

`space-create.json` 的完整请求格式如下，`id` 必须与环境中的目标 Space ID 相等。`scope` 只是后续方法的定位范围，不会创建或加载同名方法；这里不要求固定 CONTENT 工厂。

```json
{
  "id": "your-new-space-id",
  "purpose": "工作台名称或简短用途",
  "scope": {"workflowId": "your-workflow-id", "entrypoint": "your-entrypoint"},
  "idempotencyKey": "unique-create-key"
}
```

结果未知时，用完全相同的请求和键重试。回执保留准确 Space、范围、可信创建者及八项初始计数；理解修订、设计修订、方法版本、Case、运行、业务资产、资产版本和采用均为 0。schema 与成员不算业务对象。之后 `space.businessState` 和 `onboarding.spaces[].businessState` 返回实时全 Space 计数及当前理解修订 ID；回执的初始计数仍保留创建时的值。理解与设计正文也保存在资产版本中，计入 `assetVersions`，但不计入 `businessAssets`。

`onboarding` 不输出 CSRF 或凭据。创建操作内部先从 `/api/workflow-spaces/v1/onboarding` 读取认证身份与会话绑定 CSRF，再同源 POST 到 `/api/workflow-spaces/v1/spaces`。不依赖尚不存在的目标 Space summary。HTTP 创建请求与响应合同由 `SpaceProvisionRequestSchema`、`SpaceProvisionReceiptSchema` 限定。

新宿主的私有凭据使用 v2 文件格式，由 `provisionDesignWorkbenchCredential` 或受信本机启动脚本预配；它包含明确 `spaceIds`、服务主体和真实 Agent／会话／角色。已有 v1 单 Space 凭据仍兼容旧入口。两者都必须是绝对路径下的私有普通文件；新 helper 拒绝符号链接、宽权限和身份／范围不同的覆写。令牌只由宿主读取，不在请求正文、日志或结果里声明。

Creator Lab 的薄宿主可在已初始化的共享 PostgreSQL harness 上运行：

```sh
pnpm --dir workbenches/creation exec tsx scripts/design-space-workbench.ts setup-agent \
  --agent-id ID --agent-session SESSION_ID --space-id your-new-space-id \
  --credential-file /absolute/private/design-credential.json
pnpm --dir workbenches/creation exec tsx scripts/design-space-workbench.ts serve \
  --config-file /absolute/private/runtime.json \
  --credential-file /absolute/private/design-credential.json \
  --allow-space your-new-space-id --port 4400
```

私有 runtime 配置提供 `databaseUrl` 和人类 `principal`；执行命令还要求该私有配置明确设 `enableExplanatoryExecution:true`。默认 false，界面阅读时不开放执行写入。R2 等 blob 配置仍由宿主私有路径注入。该启动脚本不迁移数据库、不预设业务内容、不登记方法、不启动模型。普通本机页面使用只读身份：`/space-workbench` 展示真实目录，创建后点击进入 `/space-workbench/:spaceId`；无方法版本的新 Space 默认打开业务目标。设计 Agent 通过 skill＋CLI 保存理解后，页面保留完整正文、来源、变更理由、准确修订与历史。保存仍为未确认，不等于用户验收。

A1 的具体请求、署名和当前能力边界见项目内 [业务理解接入参考](../.agents/skills/space-business-understanding/references/operator-contract.md)与[方法设计接入参考](../.agents/skills/method-first-design/references/operator-contract.md)。

在根 pnpm workspace 构建共享包后，无需全局安装，可直接运行：

```sh
pnpm --dir vendor/agent-workflow operator space
pnpm --dir vendor/agent-workflow operator versions
pnpm --dir vendor/agent-workflow operator version <exact-version-id>
pnpm --dir vendor/agent-workflow operator node <exact-version-id> <exact-node-id>
pnpm --silent --dir vendor/agent-workflow operator cases
pnpm --silent --dir vendor/agent-workflow operator case <exact-case-id>
pnpm --silent --dir vendor/agent-workflow operator run <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator run-inputs <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator process <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator occurrence <exact-run-id> <exact-occurrence-id>
pnpm --silent --dir vendor/agent-workflow operator occurrence-responses <exact-run-id> <exact-occurrence-id>
pnpm --silent --dir vendor/agent-workflow operator run-trace <exact-run-id> <exact-session-id>
pnpm --silent --dir vendor/agent-workflow operator asset <exact-asset-version-id>
pnpm --silent --dir vendor/agent-workflow operator review-subjects <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator observe-response --file /absolute/path/exact-response-target.json
pnpm --silent --dir vendor/agent-workflow operator observe-asset --file /absolute/path/exact-asset-target.json
pnpm --silent --dir vendor/agent-workflow operator observation <exact-run-id> <receipt-id>
pnpm --silent --dir vendor/agent-workflow operator reviews <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator review <exact-run-id> <exact-review-id>
pnpm --silent --dir vendor/agent-workflow operator review-save --file /absolute/path/review.json
pnpm --silent --dir vendor/agent-workflow operator dispositions <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator disposition <exact-run-id> <exact-revision-id>
pnpm --silent --dir vendor/agent-workflow operator disposition-save --file /absolute/path/disposition.json
pnpm --silent --dir vendor/agent-workflow operator diagnosis <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator diagnoses <exact-run-id>
pnpm --silent --dir vendor/agent-workflow operator diagnosis <exact-run-id> <exact-revision-id>
pnpm --silent --dir vendor/agent-workflow operator diagnosis-save --file /absolute/path/diagnosis.json
pnpm --silent --dir vendor/agent-workflow operator understanding
pnpm --silent --dir vendor/agent-workflow operator understanding --revision <exact-revision-id>
pnpm --silent --dir vendor/agent-workflow operator understanding-history
pnpm --silent --dir vendor/agent-workflow operator understanding-save --file /absolute/path/understanding-save.json
pnpm --silent --dir vendor/agent-workflow operator capability
pnpm --silent --dir vendor/agent-workflow operator capability --revision <exact-capability-revision-id>
pnpm --silent --dir vendor/agent-workflow operator capability-history
pnpm --silent --dir vendor/agent-workflow operator capability-save --file /absolute/path/capability-save.json
pnpm --silent --dir vendor/agent-workflow operator design
pnpm --silent --dir vendor/agent-workflow operator design --revision <exact-design-revision-id>
pnpm --silent --dir vendor/agent-workflow operator design-history
pnpm --silent --dir vendor/agent-workflow operator design-save --file /absolute/path/design-save.json
pnpm --silent --dir vendor/agent-workflow operator design-definition --revision <exact-design-revision-id>
pnpm --silent --dir vendor/agent-workflow operator method-preview --design <exact-design-revision-id>
pnpm --silent --dir vendor/agent-workflow operator method-publish --design <exact-design-revision-id> --expected <preview-version-id>
pnpm --silent --dir vendor/agent-workflow operator method-basis <exact-version-id>
```

包提供 `workflow-space-operator` bin；安装在消费项目后也可使用该项目的本地命令：

```sh
workflow-space-operator space
workflow-space-operator versions
workflow-space-operator version <exact-version-id>
workflow-space-operator node <exact-version-id> <exact-node-id>
```

`space` 读取 Space purpose、当前方法范围、采用指针和最新版本身份。`versions` 分页读取该方法范围内的准确版本，显示原始 `changeReason`、前驱、执行可用性和运行／案例计数；空的变更理由保持为空，不能用标题补造动机。`version` 读取该版 hash、目的、节点摘要、采用记录状态／slot，以及预期资产、生产者、消费者、依赖和合同缺口。预期资产是方法声明，不能当作实际资产或模型已使用某材料的证据。`node` 读取职责、已授权返回的准确 Prompt、执行器、模型、工具、输入输出合同和少量安全配置字段；输入输出保留 schema hash、投影、状态与来源选择规则，供设计 Agent 核对交付方法。

HTTP API 的认证与授权由宿主负责。CLI 仅使用服务端返回的安全事实，按字段白名单输出 JSON；凭据、CSRF 和任意配置不会出现在输出或错误信息中。业务理解命令会输出完整正文、声明来源、声明作者和实际保存者，调用方应按该 Space 内容的权限管理输出文件。准确节点 Prompt 会在 `node` 命令中输出，调用方应像处理工作台中同一内容那样控制终端和输出文件的访问。拒绝访问时只报告 HTTP 状态；携带凭据时只连接 HTTPS 或本机回环地址。若版本的历史定义缺失、采用记录状态为 `unknown`、或预期合同有 gap，应保留未知，不能推断“未采用”“没有预期资产”或用现行工厂补写历史。

后续评价与迭代的连续取证，以及真实执行和验证操作，仍按[建设路线](harness-roadmap.md)分批接入；现有受信任的库级 [`inspectSpace`](space-storage.md) 查询和消费方 CLI 可继续用于各自授权范围，不由这个入口扩大权限。


## 形成与修订业务理解

`understanding`、`understanding-history` 与准确修订读取返回前端同一份 Markdown 正文与来源；不是从 purpose 自动扩写。`understanding-save` 用当前认证会话获取 CSRF 并发出同源 POST，要求文件声明 Agent 作者，且保留预期准确修订 ID、幂等键和改动理由。首次 `expectedRevisionId` 为 `null`；已有正文须使用刚读到的 ID。保存冲突时读新版本并重新判断，不覆盖旧版。

独立验收宿主的外层 Agent 凭据由本机可信配置绑定真实 `id`、`sessionId` 与 `role`。`design` 角色可新增业务理解修订；`observer` 角色以及未标角色的旧凭据保持只读。CLI 保存文件的 `authorship` 必须准确填写当前受信 Agent 的 `name=id` 和 `sessionId`，服务端还会将认证 service principal 单独记作 `recordedBy`；不能借人类 Cookie 或手填姓名取得编辑权。私有凭据仍为 `0600`，token 不写入正文、命令输出或文档。此处 `design` 角色只开放业务理解修订；本轮不据此开放草案保存、方法发布、Case 运行或采用。

请求文件格式、署名边界和共享宿主首次显式 schema 登记见[共享接入合同](#业务理解的共享接入)；形成正文与冲突处理见项目内 [space-business-understanding skill](../.agents/skills/space-business-understanding/SKILL.md)。这份 skill 仅项目内可发现，没有全局安装。


## 业务理解的共享接入

`createBusinessUnderstandingStore(service)` 复用 Space schema 与不可变资产版本；逻辑资产 ID 为 `space-business-understanding`，schema 为 `workflow/business-understanding@1`。每版保存标题、Markdown 正文、声明来源及摘录、声明作者、变更原因和准确前驱；资产另有内容 hash、时间、版本号和认证导入主体。没有新数据库或自动方法发布。

owner 首次显式调用 `store.ensure(spaceId)` 登记 schema；宿主启动、读取和普通保存不会隐式初始化数据库。已初始化的宿主把 `current/read/history/save` 接入 `SpaceApiHost.understanding`，保存方法可省略。使用经过 membership 检查的读服务及符合当前认证主体的写服务，并挂载既有同源、会话绑定 CSRF 安全。存储按原资产权限校验 owner/creator/operator 的保存能力。

HTTP 入口位于已有 `/api/workflow-spaces/v1/spaces/:spaceId` 下：

| 入口 | 结果 |
| --- | --- |
| `GET /understanding` | 当前完整修订；未形成时明确缺失 |
| `GET /understanding?revision=ID` | 准确历史修订，限定本 Space 与逻辑资产 |
| `GET /understanding/revisions` | 带范围绑定游标的修订列表 |
| `POST /understanding/revisions` | 以预期当前 ID、内容与幂等键新增修订；返回准确保存对象 |

保存保留旧版本；预期 head 不一致时返回冲突，不覆盖。重试同一键与相同请求返回原结果，不另增修订。前端在冲突时保留草稿、展示最新内容，由使用者核对后再保存。来源路径和网页仅作为声明引用，不开放任意文件读取，也不自动证实来源结论。Markdown 不执行原始 HTML。

当前接入只是业务理解的最小形成、保存、阅读与修订路径；未加入理解确认流程、富文本协作或全生命周期自动执行。阶段验收由认知负责人实际阅读、修订和重开后记录，见[建设阶段](harness-roadmap.md)。

## 方法能力、设计草案与准确候选

`understanding` 是独立的业务判断修订，不要求先有方法版本或能力修订。方法能力把真实可冻结的节点指令、输出 schema、模型和推理等级逐项保存；设计草案解释目标、依据、职责、取舍与评价，并可引用一份准确能力修订。旧版没有 `capability` 引用的设计仍可按原合同阅读和登记；不能把它解释成已有专业指令。

`capability`、`capability --revision ID`、`capability-history` 读取当前、准确旧版与历史。保存用 `capability-save --file ABSOLUTE_PATH`；`pnpm --dir` 会改变 CLI 工作目录，因此文件路径必须为绝对路径。请求 JSON 的字段形状如下（占位 hash 必须换成对应 `content` 原始 UTF-8 字节的真实 SHA-256）：

```json
{
  "workflowId": "your-workflow-id",
  "entrypoint": "your-entrypoint",
  "understanding": {"revisionId": "exact-understanding-revision", "payloadHash": "exact-understanding-payload-hash"},
  "provider": {"id": "registered-provider-id", "contractRevision": "registered-contract-revision"},
  "nodes": {
    "node-id": {
      "instructions": {"content": "该节点的完整实际指令", "sha256": "64-character-sha256-of-content"},
      "outputSchema": {"content": "{\"type\":\"object\"}", "sha256": "64-character-sha256-of-content"},
      "model": "chosen-model",
      "reasoningEffort": "chosen-effort"
    }
  },
  "validation": {"content": "{\"checks\":[]}", "sha256": "64-character-sha256-of-content"},
  "predecessorVersionId": null,
  "changeReason": "本次能力变化的理由",
  "authorship": {"kind": "agent", "name": "authenticated-agent-id", "sessionId": "authenticated-session-id"},
  "expectedRevisionId": null,
  "idempotencyKey": "unique-capability-save-key"
}
```

`nodes` 的键须覆盖所选 provider/factory 要求的实际节点；示例中的单个键不表示产品只有一个节点。每个 `instructions.content` 是原文，`outputSchema.content` 必须是 JSON Schema 对象文本，`validation.content` 必须是 JSON 文本；三者分别保存原始字符串及对应 SHA-256，不能先规范化 JSON 再对另一份字节算 hash。`provider.id/contractRevision` 必须是宿主已配置的准确契约，不能由请求虚构执行器。首版 `predecessorVersionId:null`；后继方法必须填写同 Space、同 workflow/entrypoint 的准确前驱版本 ID。`understanding` 的 ID 与 payload hash 必须来自准确读回。首次 `expectedRevisionId:null`，修订时填刚读到的能力 head；409 后重新读取和比较，未知结果只用完全相同的请求与幂等键重试。保存不运行模型。

`design-save --file ABSOLUTE_PATH` 的现有字段是 `workflowId`、`entrypoint`、`understanding:{revisionId,payloadHash}`、`title`、`content`、非空 `sources`、`authorship`、`changeReason`、`expectedRevisionId`、`idempotencyKey`；引用专业能力时另加 `"capability":{"revisionId":"exact-capability-revision","payloadHash":"exact-capability-payload-hash"}`。能力须与设计的 workflow、入口和理解依据一致。编辑带能力的草案仍须保留这份准确引用；需要换能力时先形成新能力修订，再保存新设计修订。草案仍为 `unconfirmed`，正文不自动修改执行定义。

`capability-save` 与 `design-save` 都需要宿主实际开放对应写入、同源会话 CSRF 与受信 `role:design` Agent 的准确 `name/sessionId`；服务端另记 `recordedBy`。观察身份只读。登记还要求准确设计修订由当前受信 Agent 本人、同一会话和系统保存者创建；他人草案可读，不能冒名登记。

`design-definition --revision DESIGN_REVISION_ID` 以固定的设计／能力依据和当前 provider 实现编译并返回完整候选响应，不按节点数、数组长度或深度删节。实现变更可能使同一设计修订产生不同候选 ID；只有登记后的准确版本才冻结。响应含 `candidateId`、workflow/entrypoint、设计／理解／能力修订 ID 与 payload hash、provider ID／契约修订／fingerprint、完整 `version`、全部 `schemas`、`presentation`、预期资产合同 `expectedAssets`、`availability:{state,reason}` 和同一修订的 `diagramUrl`。图由 `GET /method-design/diagram?revision=ID` 生成，应与定义及预览使用同一 ID；阅读图后仍逐项核对原始指令、模型、schema、工具、路由、预算和冻结依据。`method-preview --design ID` 保留较小的兼容摘要。候选定义是待登记的准确内容，不是运行记录或效果验证。

确认候选身份后执行 `method-publish --design DESIGN_REVISION_ID --expected CANDIDATE_ID`。对带能力的设计，`CANDIDATE_ID` 取 `design-definition.candidateId`，还要与刚重新读取的 `method-preview.versionId` 一致；不一致时重新核对当前实现，不能盲目登记。旧设计按 `method-preview.versionId`。登记只冻结准确版本与依据，不启动 Case、模型、评价或采用。后继版本须由能力修订明确指定准确前驱，宿主核对前驱后才能登记。`availability:unavailable` 或 `unknown` 必须如实保留；新候选在受保护的运行入口接入并核验匹配部署之前，不能据登记结果宣称可执行。

v3 计划要求试做研究节点与正式 Case 首轮使用同一冻结指令、输出 schema、首轮上下文投影和 `read_bound_asset` 工具合同；试做不能改成无工具捷径。试做最多 2 次实际 provider POST：首次原尝试，第二次只可用于一次工具续轮或一次技术修复；技术修复最多一次，也不能成为第三次请求。试做与同一 Case 共用 15 次已预留 provider POST 上限，失败、工具续轮和技术修复都计数。工具函数调用另记，不增加模型 POST 次数。60 分钟从首次成功预留 provider 请求开始，等待与诊断期间继续走时。受保护运行入口须持久核验这些限制；它们不是 token 或金额上限。

私有 runtime 配置 `enableExplanatoryExecution` 默认为 false，只有显式设 true 才允许执行变更命令。旧 v1/v2 记录保留；方案与构建通过不等于模型试做或正式 Case 已通过。

HTTP 入口沿用 `/api/workflow-spaces/v1/spaces/:spaceId`，先检查成员与宿主方法范围：

| 入口 | 结果 |
| --- | --- |
| `GET /method-capability[?revision=ID]`、`GET /method-capability/revisions` | 当前／准确能力修订及历史 |
| `POST /method-capability/revisions` | 以准确理解、provider、原文字节 hash、预期 head 与幂等键新增能力修订 |
| `GET /method-design[?revision=ID]`、`GET /method-design/revisions` | 当前／准确设计草案及历史 |
| `POST /method-design/revisions` | 保存设计修订，可固定能力修订引用 |
| `GET /method-design/definition?revision=ID`、`GET /method-design/diagram?revision=ID` | 同一准确候选的完整定义及过程图 |
| `GET /method-design/preview?revision=ID` | 兼容候选摘要及可用性，无写入 |
| `POST /method-design/publications` | 以 `designRevisionId`、`expectedCandidateId` 登记准确版本 |
| `GET /versions/:versionId/design` | 读取冻结设计、理解以及存在时的能力依据 |

`summary.capabilities` 分别报告 `methodCapabilityRead/Write`、`methodDesignRead/Write` 与 `methodPublish`；读取权限不推导写入或发布权限。历史 v1 设计和独立业务理解仍可读。私有正文、来源、凭据、运行 trace 及宿主特定 ID 不应复制进公开文档。形成方法的项目内流程见 [method-first-design skill](../.agents/skills/method-first-design/SKILL.md)。

## 具体 Case 的准确执行证据

同一业务轮次可能合并 Agent 与程序发布的技术步骤。`occurrence` 的上下文以已保存的 `producer` 区分：只有 Agent 尝试进入模型指令与工具读取，程序发布上下文保留在执行记录；不能用是否存在 `siwc.started` 判断执行者。`runtime` 拒绝程序尝试。真实 Agent 缺事件仍属于 Agent，但相关证据未记录；多个 Agent 尝试须明确选定准确尝试。

`runtime RUN_ID OCCURRENCE_ID ATTEMPT_ID` 读取同一准确尝试的指令与工具事实。它区分冻结版本 Prompt、节点上下文指令和 `siwc.started` 保存的 provider instructions；工具声明来自当次保存快照，不用它补写冻结版本。接口按事件序号分页过滤 started 与工具调用、结果和失败事件，避免要求读者穿过 token delta；CLI 有界接续，未取完时保留不完整状态和未知调用总数。调用按 attempt 与 callId 配对，同名多次调用分别保留参数、结果或已记录的失败。工具被提供不表示被调用，已读完保存事件也不证明历史事件采集完整。脱敏、正文截断和未保存字段分别说明；旧事件没有输出 schema 或完整失败错误时保持未知，实际工具返回也不等于正式发布资产。

`node VERSION_ID NODE_ID` 的方法声明仅来自该冻结版本：执行器、模型、参数限制、Prompt、可选 skill 与工具合同。历史只保存工具名称时显示详细定义未记录；不会读取最新工具代码或用某次运行快照替代冻结声明。`agentDeclarationCoverage` 表示本次安全投影是否因大小或深度上限截断，`full` 不表示历史字段全部记录；非 Agent 为 `null`。描述和参数合同不授予实际执行权限。

`cases` 分页读取方法范围内的 Case；`case ID` 读取准确目标、约束、**全部分页 run** 与 Case 关联资产，不只返回最新一次。每个 run 的原始状态、任务状态、失败原因、资产计数与可审阅成果 ID 分开呈现；失败或排队且没有成果时，`primaryAssetId:null` 不会被预期资产或旧 run 稿件填充。CLI 会读完游标页，超过有界页数则报告未完成，不输出伪完整列表。

`run ID` 读取单次运行及冻结输入清单；`run-inputs ID` 单独列出清单 ID/hash、准确 slot、资产版本 ID/schema 与 `payloadHash`。`process ID` 返回执行过程的合同来源和观察覆盖、节点与全部 occurrence；`occurrence RUN_ID OCCURRENCE_ID` 返回该轮的真实输入／输出、状态、技术步骤、失败详情以及已保存的上下文／session ID。`trace RUN_ID OCCURRENCE_ID` 是同一 occurrence 的过程证据便捷入口。历史没有过程合同、上下文或产物时保留缺失状态，不从现行工厂补造。

`run-trace RUN_ID SESSION_ID` 经 `/runs/:runId/sessions/:sessionId/events` 按序读完已保存的事件页，包含时间、尝试 ID、事件种类和授权后的正文。服务端先核对 Space 成员、方法范围、准确 run、该 run 的 process context／session／attempt 归属，再只返回该 run 的事件；每页最多 100 条，CLI 使用 `nextCursor` 接续。事件正文限制层数与大小，并递归遮蔽凭据、授权头、环境变量等敏感键和常见令牌值。它是共享服务保存的执行事件，不是本机原始 trace 文件；事件可能不完整，须同时看 `process.coverage`、失败步骤和实际资产。不要把存在 session ID 误当成完整执行 trace。

`occurrence-responses RUN_ID OCCURRENCE_ID` 读取失败且没有发布资产的 occurrence 中，准确 Agent attempt 最后一条已保存 assistant 响应。它返回原 session／event／attempt 标识、结构化输出的安全 JSON 文本，以及宿主已注册时的自然阅读段落。完整脱敏输出才交给阅读器；未注册、无法解释或超出读取上限时，`reading.readerStatus=fallback` 会注明原因，超限同时标记 `coverage=truncated`。这是**未发布响应**，不是成功产物。若同一冻结 run 的失败阶段明确终止，过程中的 `terminalFailure` 会标出派生失败及原阶段错误；`technicalSteps` 仍保留记录时的原始状态，例如 publish 当时为 running。

`asset ASSET_ID` 读取该准确资产版本的正文段落、schema、来源和 `payloadHash`，以及生产轮次、依赖、上一稿、评估与消费关系；关系中的消费者分页读完。导入材料保留 `sourceKind:import`，人工补做或外部录入不冒充模型节点输出。预期资产只在方法合同中；运行证据以实际保存的资产和依赖为准。阶段 3 的具体查证流程见项目内 [case-run-evidence skill](../.agents/skills/case-run-evidence/SKILL.md)。CLI 本段是只读取证入口，真实 Case 的准备与有界运行由宿主既有受权操作完成，不会由这些命令触发付费调用或自动重跑。

## 评价与记录型处置

`review-subjects RUN_ID` 只列本次 run 已保存的节点资产和失败后未发布的完整 Agent 响应。资产目标含准确 `runId`、`assetVersionId`、原始 `payloadHash`；响应目标带准确 occurrence／step／attempt／session／event ID、事件序号及原始输出 hash；不存在的 cold read、fact、editor 产物不会被补造。每项 `subject.standard` 由宿主按这个准确目标从冻结依据确定：研究资产按研究职责与原输入评价其作为稿件依据的质量，不套用交付稿的 C1；作者响应按其原标准评价。`null` 表示该目标没有可用标准，不能回退顶层作者标准。顶层 `standard` 只供旧调用兼容，绝非预填的判断。`reviews`／`review` 分页和按 ID 读回四问评价；`dispositions`／`disposition` 读回该 run 的全部不可变处置修订和认证作者。

外层认知 Agent 使用宿主显式配置的独立服务凭据；`WORKFLOW_OPERATOR_TOKEN_FILE` 指向权限为 `0600` 的绝对路径 JSON 文件，CLI 只读取其中的 `token`，不输出它，也不能同时设置 human Cookie 或另一份 Authorization。该凭据的 Agent ID、session ID 和服务主体由可信宿主绑定，不能由 CLI 请求文件选择。将 `review-subjects` 中**一项准确未发布响应**的 `target` 原样写为 `{"target":{...}}`，执行 `observe-response --file`；API 核对失败且未发布的原响应、准确 hash 和观察者与生产者独立性，完整安全投影可读时保存不可变交付收据。`observation RUN_ID RECEIPT_ID` 可重开收据，但收据只证明准确响应已交付给该 Agent session，不证明它已经理解或认可内容。超出完整阅读上限的响应不签收据。

已发布的研究等节点资产使用同一可信身份，但另用 `observe-asset --file /absolute/path/exact-asset-target.json`，文件形如 `{"target":{"runId":"…","assetVersionId":"…","payloadHash":"…"}}`，三个值均从所选 `review-subjects` 的资产 `target` 原样取得。服务端核对资产版本、原始哈希、实际节点输出绑定、生产上下文及观察者独立性，再返回完整脱敏保存正文、阅读段落和 `delivery:'published-asset-read'` 的不可变收据；原未发布响应收据仍为 `delivery:'saved-response-read'`。资产正文过大或投影不完整时不签收据。`observation RUN_ID RECEIPT_ID` 可以按准确 run 重开两类收据，旧收据和四问原样保留。

`review-save --file` 使用当前认证会话的同源 CSRF。Human 评价者须与 `summary.subject.id` 一致；外层 Agent 必须使用独立凭据，`judge:{kind:'agent',id,sessionId}` 与可信 `summary.subject.externalAgent` 一致，并填写刚读到的 `observationReceiptId`。评价未发布响应时填同一 `responseTarget` 与 `assetVersionIds:[]`；评价已发布资产时填 `assetVersionIds:[准确版本ID]` 且不填 `responseTarget`。`standard` 必须取所选 subject 自己的冻结标准。服务端再次核对 Agent 身份、收据、目标及独立生产者；human Cookie 即使手填 Agent 名字或 session ID 也会被拒绝。请求 JSON 还包含 `id`（同请求重试键）、`runId`、`evidence`、四问 `answers:{good,bad,improvement,unresolved}`，响应证据可加 `evidencePointers` 指向原始保存输出的 JSON Pointer。四问必须由认知 Agent 根据实际读到的正文填写，收据不能代替判断。错误 hash、跨 run、过期标准或不存在的指针会拒绝保存。

`disposition-save --file` 可由认证 human 或上述外层 Agent 写，JSON 含 `runId`、非空 `reviewIds`、`action`（`keep`、`revise`、`supplement`、`change-method`、`stop`、`defer`）、`reason`、`unknowns`、`evidenceRefs`、`expectedRevisionId`（首版 `null`）、`idempotencyKey`；Agent 还须填写一个主 `observationReceiptId`，并至少引用一条自己以该收据保存的同 run 四问评价。同一 Agent 对研究资产和作者响应分别观察、评价后，可在一次处置中同时引用两项评价；服务端逐项核对各自收据和目标，读回修订的 `observationReceiptIds` 列出真正依赖的全部收据。已有处置只读保留，下一步用当前 head 作 `expectedRevisionId` 新增修订，不覆盖旧判词。`evidenceRefs` 可以是 `{kind:'asset',assetVersionId,pointer?}`、`{kind:'response',target,pointer?}` 或 `{kind:'run',runId,stepRunId?}`；服务端核对引用与本次 run。每次写入新增修订，CAS 冲突须重新读取再判断；`confirmation:'unconfirmed'` 和 `keep` 均不代表用户接受、方法采用或自动执行。保存文件必须用绝对路径，因为 `pnpm --dir` 会更改命令工作目录。两种写入均不启动 run 或模型调用。

`diagnosis RUN_ID` 读本次 run 当前诊断；尚无记录时返回 `diagnosis:null`。`diagnoses RUN_ID` 分页读完不可变修订，`diagnosis RUN_ID REVISION_ID` 准确重开旧版。诊断接续已有准确四问与处置：`diagnosis-save --file` 的私有 JSON 顶层填 `runId`、选中的 `reviewIds`、准确 `dispositionRevisionId` 和 `dispositionPayloadHash`、非空 `issues`、`expectedRevisionId`（首次 `null`）、`idempotencyKey`；可信外层 Agent 还填自己的主 `observationReceiptId`。每个 issue 分别填写 `expected`、`observed`、准确 `evidenceRefs`、竞争 `hypotheses` 的 `supportRefs`／`counterRefs`／未知与辨别检查，以及 `decision:{route,reason,...}`。证据可引用同 run 的资产及 hash、未发布响应 target、所选 review、处置修订及 hash、冻结输入 manifest 及 hash、准确 trace event 或 run step；服务端核对来源、关系与 JSON Pointer，缺失不能用现时结果补造。处置分流包括修本作品、补输入、校准判者、改方法、记录 harness dogfood、设计方法、延后或不改；诊断不是验证通过的结论。

若确有支持证据且 issue 分流为 `change-method`，可选填 `candidateDraft`：准确前驱方法版本、被选 issue／hypothesis ID、具体 before/after 变化及理由、预期收益、风险、验证方案、推翻条件和适用条件。其状态固定为 `unregistered-unvalidated-unadopted`：只保存候选思路，不登记新方法、不执行 run、不采用。即使 issue 提议改方法，也可以先只保存假说与未知、不填候选。Agent 的认证身份来自宿主凭据且所选评价须属于本 Agent；human 路径仍用认证主体。保存使用同源 CSRF、预期 head 与唯一幂等键；409 时重读并判断，不覆盖原四问、处置或旧诊断。这里的说明仅指接口，不公开任何私有判词正文。
