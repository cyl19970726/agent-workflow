---
name: case-run-evidence
description: 通过共享 Space API 与 Operator CLI 阅读具体 Case 的全部 run、冻结输入、实际过程、session 事件、资产正文和关系，再记录有证据的评价与处置；用于准确取证、失败定位和人工判断。
---

# 沿准确 Case 阅读真实运行

本 skill 仅在 `vendor/agent-workflow` 项目内使用，通过 [Operator CLI](../../../docs/operator-cli.md#具体-case-的准确执行证据) 读取同一 Space 的准确事实。取证本身不启动模型、自动重跑、采用或外发；不直接读数据库或本机原始 trace。需要先选择 Case 时，用 `space`、`cases` 和 `case CASE_ID` 找到真实目标及相关全部运行，失败和人工介入也在范围内，不自动只选最新成功记录。

## 先取得有界概览，再深入问题

对选定运行先执行 `run-evidence RUN_ID`。它聚合现有读取结果，帮助确定方法／Case／冻结输入、实际发生的节点、已保存产物、失败和证据缺口，并给出可继续阅读的准确命令。先核对执行范围：研究节点试做的 completed 不能解释为完整 Case 完成，步骤成功不能解释为业务合格。

概览用于定位，不代替原始内容。按这次问题选择返回的详情命令，阅读对应 occurrence／attempt、资产正文或评价依据；默认不展开全部方法、工具事件和历史。缺失、截断、分页未取全与接口不可用分别保留，不能当成零次调用或不存在。不能用概览的“已提供”状态证明 Agent 理解了正文。

- **核对方法和交付材料：** 用 `method-basis VERSION_ID`、`node VERSION_ID NODE_ID` 读当时的设计、指令和合同；用 `run-inputs RUN_ID` 及资产阅读命令核对真正冻结的材料。不要用当前方法填补旧版缺失内容。
- **调查节点内部：** 沿概览进入准确 occurrence。模型节点的 `runtime RUN_ID OCCURRENCE_ID ATTEMPT_ID` 展示实际上下文和可获取的工具事件；程序发布步骤从执行记录读，不能拿它的 attempt 当模型调用。多个尝试明确选择，不按数组第一项或同名角色配对。
- **阅读成果与失败响应：** `asset ASSET_VERSION_ID` 读取正式资产正文、来源与依赖；未发布响应走 `occurrence-responses`。导入、人工修订、工具返回和模型正式产物分别识别。失败时没有最终资产就说明没有，不能由预期输出补出作品。
- **需要更深证据时：** 使用返回的 `run-trace` 等准确命令。保存事件读完仍不证明执行全程均被采集；历史缺少 Prompt、工具定义或事件时标明缺失。工具调用按 attempt 与 callId 对应，未取全不报告完整总数。

原有 `run`、`process`、`occurrence`、`runtime` 等命令继续用于按需阅读和核对。普通取证不必机械地把全部命令再跑一遍；只有范围冲突、缺失或结论需要时追加证据。

## 判断、处置与后续设计

评价前先执行 `review-subjects RUN_ID`，将该 run 的真实资产与失败后未发布响应分开。响应以准确 occurrence／step／attempt／session／event ID 和原始输出 hash 锚定；用 `occurrence-responses` 读自然段落及折叠原始保存响应，检查 `coverage`。不要把冷读缺失的资产或失败响应补造为成功产物。`standard` 来自冻结输入，是评价依据，不是系统预填的好坏判断。

评价时提交四问 `good`、`bad`、`improvement`、`unresolved`，明确选择资产或未发布响应目标及证据指针。Human 使用其认证身份；外层认知 Agent 使用可信宿主绑定的独立服务凭据，不使用 human Cookie、姓名或手填 session ID 冒充。先用 `review-subjects RUN_ID` 取得所选项的准确 target 与该项 `standard`；研究资产按研究职责及冻结机会输入评价为稿件依据，不能套用作者交付稿标准。未发布响应执行 `observe-response --file /absolute/path/target.json`；已发布研究等节点资产执行 `observe-asset --file /absolute/path/target.json`，两者都把所选 target 原样写入私有 JSON 文件，阅读完整安全投影与自然段落并记下收据 ID。按实际判断填写四问、`observationReceiptId` 和与认证外层 Agent 一致的 judge，经 `review-save --file` 保存；响应填写同一 `responseTarget`，资产填写 `assetVersionIds:[准确版本ID]`。收据证明交付，不证明理解；未实际阅读或没有独立收据时不要保存 Agent 判断。用 `reviews RUN_ID` 和 `review RUN_ID REVIEW_ID` 读回准确记录。失败响应是未发布证据，不能写成已交付稿。

需要记录下一步时，由认证 human 或已取得收据并保存本人四问的外层 Agent 使用 `disposition-save --file` 引用同 run 的评价 ID，明确 action、理由、未知项和具体资产／响应／run 步骤证据；Agent 处置给出一个主 `observationReceiptId`，所选评价中至少一条必须属于该主收据。研究资产与作者响应可各有准确收据及评价，服务端逐项核对；读回 `observationReceiptIds` 可看到全部实际依赖。先读 `dispositions RUN_ID` 的当前 head，再用 `expectedRevisionId` 保存不可变新修订；已有判词不可覆盖，冲突须重新读回后判断。`keep` 只是记录处置，不表示接受、发布、自动重跑或采用方法。`disposition RUN_ID REVISION_ID` 可精确重开。评价与处置都不启动模型，也不改变已保存运行事实。

从本次 run 的准确评价与处置进入原因诊断：先读 `diagnosis RUN_ID`、`diagnoses RUN_ID`，按 ID 重开旧版；核对冻结输入、资产、未发布响应及 trace。每个 issue 分开写观察事实、竞争原因假设、各自支持与反证、未知和辨别检查，再明确分流到修作品、补材料、校准判者、方法改动、harness dogfood、延后或不改。用准确 `reviewIds`、`dispositionRevisionId`/hash 与证据引用保存 `diagnosis-save --file`；Agent 仍用可信凭据与自己的主观察收据，不能借 human 身份或只靠手填名字。若证据足以支持方法改动，`candidateDraft` 写准确前驱、具体差异、预期收益与风险、验证及推翻条件；证据不够时只存问题与假说。诊断修订与候选草案均不可覆盖，候选状态 `unregistered-unvalidated-unadopted`，不会自动登记版本、运行模型或采用方法。CAS 冲突重读后再判断。

交付时列明 Case 的全部 run、每次冻结输入、完成或失败范围、确有保存的成果与关系、session trace 覆盖和缺失、人工介入，以及评价的具体对象、四问判断和处置仍待解决的未知。运行完成不等于内容质量合格；模型自评不等于用户接受。取证、评价和记录型处置可支持随后方法调优，但不能直接宣布已采用。
