# 前端工作台接入读模型

`@signal-room/workflow-read-model` 是执行账本到浏览器的服务端投影。它把一个指定 run 及其真实子孙组织成运行、阶段、逻辑调用、attempt 和资产关系；浏览器只导入 `@signal-room/workflow-read-model/contracts` 的类型，不访问 `RunStore`。可运行的无模型示例：

```bash
npm ci
npm run build
node examples/read-model-web.mjs
```

命令行完整工作流示例：`node examples/read-model.mjs`（无意见）以及 `node examples/read-model.mjs --repair`（修订一次，修订稿保持未复核）。它使用真实 runtime 和模拟 Agent，恢复时复用已完成 Builder，失败 Reviewer 保留在账本。两种模式都由 `npm run verify` 执行。

在终端显示的本机地址打开页面，按「Complete retry」可看到 Reviewer 的失败 attempt、显式重试和新产物。服务端与浏览器代码分别在 [`read-model-web.mjs`](../examples/read-model-web.mjs) 和 [`read-model-web.html`](../examples/read-model-web.html)。示例只绑定 `127.0.0.1`，没有用户体系；生产环境必须在每个 HTTP 请求上先验证身份、项目权限和 root 权限。

## 服务端边界

```ts
import { createWorkflowReadService } from "@signal-room/workflow-read-model";
import type { WorkflowSnapshot, WorkflowChanges } from "@signal-room/workflow-read-model/contracts";

const reading = createWorkflowReadService({ store, adapters: {
  title: (kind, id, step) => safeTitles.get(id),
  purpose: phase => safePurposes.get(phase.id),
  error: (attemptId, rawError) => safeErrorSummaries.get(attemptId),
  readerUrl: artifact => authorizedReaderUrl(artifact),
  externalArtifact: (identity, root) => authorizedExactArtifact(identity, root),
  isDeliverable: artifact => isDomainCandidate(artifact),
  callFacts: (step, events) => safeModelFacts(step, events),
  callArtifacts: (step, artifacts) => verifiedCallArtifacts(step, artifacts),
  relations: async artifact => verifiedRelations(artifact),
  phaseFacts: async phase => verifiedPhaseFacts(phase),
  plan: root => ({ planned: knownPlanSize(root), closed: isPlanClosed(root) }),
} });

// HTTP handler: authenticate, authorize the exact root, then query.
const snapshot: WorkflowSnapshot = await reading.getSnapshot({ rootRunId, selectedRunId });
const changes: WorkflowChanges = await reading.getChanges({ rootRunId, cursor });
const details = await reading.getStageDetails({ rootRunId, phaseId: stage.id, cursor: pageCursor, limit: 25 });
```

上面的业务函数由宿主实现。回调收到的原始记录和事件**只在服务端使用**；回调返回的字符串要先脱敏。`title` 和 `purpose` 不会默认取可含私密材料的 workflow 文案；`error` 不会默认传回堆栈或原始错误。`readerUrl` 应签发当前用户有权访问的限定 URL，并约束协议、host 和资源范围。读模型从不打开 URI，也不会代替 HTTP 鉴权。`relations` 由宿主完成 payload/schema 和哈希校验后提交事实；投影只核验关系两端的身份是否匹配账本。`callFacts` 可从 agent 事件提取经允许的模型名、推理配置、方法版本和 digest；未知保持未定义。不要将整段事件或 metadata 透传。

`getSnapshot` 必须显式传入 root。一个嵌套 run 也可成为授权后的局部 root；此时只读它和它的后代，不因相同 project/creator metadata 混入历史兄弟。`selectedRunId` 必须在当前树内。宿主负责跨租户隔离；应先校验 root 所属项目，再访问服务。`externalArtifact` 只为该树中明确引用的精确身份调用（依赖、phase 绑定或领域关系端点），宿主必须核验此 root 对该外部资产的权限。返回的身份必须精确匹配，才会以 `scope: "external"` 出现在资产列表；它的生产 run 不会加入执行树。拒绝时返回 `undefined`，关系保留 `missing`；返回错误身份时标为 `mismatch`。事件日志、prompt、step output、artifact payload、任意文件路径和原始 URI 都不在浏览器 DTO 内。

Agent 输出通常由后续 `publish` 控制步骤写入，账本的 `producedBy.stepRunId` 不一定是 Agent 步骤。宿主可用 `callArtifacts(step, artifacts)` 显式返回 `{inputs, outputs}` 的精确资产身份；读模型只接受与账本 `id + revision + sha256` 全部匹配的引用，填入 `CallView.inputArtifactIds` 和 `artifactIds`。不要凭时间接近或相同 phase 推测某个 Agent 生产了资产。回调中的外部输入仍须经过 `externalArtifact` 权限检查。

## 状态与身份

`StageView.id` 是稳定的阶段控制步骤 ID，`phaseKey` 是 workflow 定义中的 phase ID。持久恢复可能为同一个逻辑阶段创建多个控制步骤；投影按 `runId + phaseId` 合并，沿用首个控制步骤 ID，用最新控制步骤的状态和绑定，保留历次调用。相同 phase key 在并行子 run 中仍是不同阶段。`CallView.phaseId` 引用 `StageView.id`；子 run 的调用可继承父阶段归属。`call.childRunIds` 展示持久子流程，`attempts` 展示同一逻辑调用的实际执行记录。显式 `read-model.retry` 事件才产生 `retryOf`；旧记录没有此事件时关系未知，不按名字或时间推断。

每个 Agent attempt 的用量按 `agent.usage` 的实际 `childRunId` 去重后累加；没有此类事件时才使用 `agent.completed` 的 `threadId`。同一执行重复上报不重复计费，不同子执行的 token 相加，缺失的输入/缓存/输出维度保持未定义而非零。父 workflow 不再次累计这些 Agent 用量。异常父子循环会出现在 `diagnostics`，不会无限递归或静默拼接。

不要把四种状态压成一个“完成”：`state` 是执行状态，`validation` 是结构校验，`review` 是独立复核事实，`delivery` 是交付选择。执行 `succeeded` 不保证候选可交付。`expectedArtifacts.required` 只标记绑定缺失，不改变 run 的执行结果。`waitingForRunId` 表示父阶段等待子运行；`blocked`、`needs_review`、`failed` 和 `canceled` 应分别显示。被取消的 run 上仍为 `waiting` 的阶段投影为 `canceled`。历史资料不足时显示 `unknown`，不要猜“通过”。

`progress.registered` 是实际登记阶段数，`completed` 是成功阶段数；只有宿主明确声明计划数时才有 `planned`。`closed: false` 或缺失 `planned` 时不能渲染固定百分比。阶段同时列出已绑定和同阶段产出的资产，因此第一份候选发布后可以出现，不需等整个 root 终态。多个异类资产不会自动构成阶段候选歧义；只有多个显式 primary 绑定或冲突的 selected 关系才把阶段标记 `ambiguous`。若宿主提供 `isDeliverable`，快照另有顶层 `delivery`：只从本次树内产物挑选业务候选，零个为 `missing`、单个未选择为 `unknown`、多个未选择为 `ambiguous`、一个有效选择为 `selected`；外部引用及其他类型不计入。没有选定关系时不会按发布时间选最新候选。

宿主可用 `phaseAudience(step)` 明确将内部控制阶段标为 `audit`，其他阶段默认 `reader`。快照仍完整返回两类阶段，审计层可按 ID 请求详情；`progress.registered/completed` 只计算 `reader` 阶段。前端主视图以 `audience !== "audit"` 过滤卡片，避免隐藏技术阶段后进度仍显示多一项。这个分类由宿主工作流语义决定，读模型不会靠阶段名称或状态猜测。

## 精确资产关系

每个端点使用 `{ id, revision, sha256 }`，不能只有 ID。方向如下：

| `kind` | `from` | `to` |
| --- | --- | --- |
| `consumed` | 输入依赖 | 当前产物 |
| `produced` | 生产来源资产 | 当前产物（宿主显式声明时） |
| `reviews` | review 回执 | 被复核的精确候选 |
| `revises` / `supersedes` | 新候选 | 旧候选 |
| `selected` | 选择依据资产 | 被选定的候选 |

关系的 `validity` 为 `valid`、`missing` 或 `mismatch`。宿主可在关系回调中显式返回 `validity: "mismatch"`（例如报告正文哈希与候选不符）；即使两端账本身份吻合，服务也不会把它升级为 valid。有效 review 只作用于其 `to` 端绑定的候选；修订稿不会继承旧稿的 review。资产上的 `review` 是不可变账本原值，`effectiveReview` 是根据精确有效 review 关系得出的下游状态；前者可能仍是 `pending`，后者为 `passed`。若阶段只有一个明确绑定的候选且有有效 review 关系，阶段审阅状态可从回执的 `review` 事实推导；领域规则还可通过 `phaseFacts` 注入已验证状态。`dependsOn` 自动生成 `consumed`，并不自动表示修订、复核或选定。旧记录缺显式关系时保持 `unknown`。

## 快照、增量与分页

首屏取 `getSnapshot`，保留 `cursor`。轮询或 SSE 推送时，宿主用同一 root 调 `getChanges`。`resetRequired: true` 表示 cursor 不存在、已被有界缓存淘汰或属于别的 root；重新取快照。成功响应的 `changed.runs/stages/calls/artifacts` 是按稳定 ID upsert 的局部数组，`removed` 中的 ID 要删除；`changed.progress`、`changed.delivery`、`changed.diagnostics` 和 `changed.relations` 是完整当前值，直接替换。请求重试可重复应用同一 upsert 而不会重复计数。

cursor 是服务进程内的随机 opaque token，默认最多保存 64 个，不跨进程/重启共享。负载均衡需要会话粘滞，或在换实例时用 `resetRequired` 重新取快照。每个 run 的事件序号独立；增量按各自水位读取新事件，同时重新查询该 root 的子运行、步骤、资产和状态，所以终态后新发布的资产也可发现。首个快照会读整个所选树的历史，常规增量不会反复读取完整事件历史；这不是跨多个存储调用的事务快照，竞态在下一次轮询中收敛。超过配置的 `maxRuns` 会明确报错，不静默截断。

`getStageDetails` 用 `StageView.id` 查询，默认 25、最多 100 条调用一页。`nextCursor` 绑定 root、阶段和当次详情快照，也是有界进程内 token；过期或跨 root 使用会报错，应从第一页重新读取。页面主体只显示阶段概要，用户展开时才请求详情。示例浏览器使用 `textContent` 渲染安全 DTO，并演示了增量 merge 和重置；生产 UI 可按同一协议接轮询或 SSE。

## 兼容与职责

读模型不改变账本和旧 workflow revision。历史 run 仍可打开，缺失 retry、review 或 selected 关系时明确显示未知。新增语义事件或领域关系需由写流程在新的 workflow revision 中记录，并保留旧定义以供恢复。宿主继续负责队列、租约、取消传播、业务报告 reader、内容质量判断和候选晋升；共享投影不解释业务 schema，也不会改写报告正文。
