> 历史快照：2026-10-10 架构整理前的完整正文。保留原推导和当时描述，不作为当前规则或完成状态。现行文档见 [storage-architecture.md](storage-architecture.md)。

# 存储全貌与 Workflow 的配合

存储服务属于共享 agent-workflow，业务项目提供资产 schema、节点合同与部署配置。**PostgreSQL 保存业务与执行事实，私有对象存储保存附件字节；Workflow 通过准确方法版本、冻结输入和节点上下文连接它们。** 本页核对截至 2026-10-10 的代码与限定验收，不代表完整产品或生产部署通过。对象与生命周期定义见[产品架构](product-architecture.md)，接口见[Space 服务接入](space-storage.md)，执行账本见[PG 存储指南](postgres-storage.md)。

本页的“存储全貌”指共享 harness 与 creation 接入路径。research、analysis 仍保留各自工作台和数据适配；它们的既有数据库、报告与媒体没有因 R2 接入自动迁移，也不要求三者依次运行。

## 存储层总图

![存储架构总图](../../../docs/diagrams/storage-harness-20261010/storage-harness.svg)

[打开可交互的存储架构图](../../../docs/diagrams/storage-harness-20261010/storage-harness.html)

图中两个 PostgreSQL 节点表示两组表的责任分工，可以位于同一个数据库；不是要求部署两个数据库。HTTP、CLI、工作台和节点客户端共享服务与准确身份，接入这套 harness 的 creation 工作台不再维护一份平行的资产正本。

| 层 | 当前保存什么 | 与 Workflow 的关系 |
| --- | --- | --- |
| PostgreSQL Space 领域表 `ws_*` | Space、schema、方法版本、Case、冻结输入清单、准确资产版本、来源与依赖、附件清单、上下文／会话、评价与采用、执行任务 | `ws_runs` 绑定执行 Run 与方法、入口、Case、输入清单；输入输出绑定指向准确资产版本 |
| PostgreSQL 执行账本 `aw_*` | Run、step、attempt、事件、原生 artifact 和幂等提交收据 | 记录实际执行；Space runtime 把业务资产和执行收据关联，发布时可共用 PG 事务 |
| 私有 R2 `BlobStore` | 新附件的真实字节，以 Space 与 SHA-256 形成不可变内容键 | PG `BlobManifest` 保存 hash、大小、媒体类型、后端位置；准确 `AssetVersion.attachments` 冻结该清单 |
| 历史 PostgreSQL `ws_blob_bytes` | 已有小附件字节 | 路由继续按旧 key 读取；同 Space 已存在的同 hash 清单优先复用，接入 R2 不自动迁移或重写历史 |
| 本地运行目录 | 下载、物化、缓存和工具临时文件 | 可供本次执行使用；路径不充当长期资产身份，删除源文件不能使已入库附件失读 |
| 宿主私有配置 | 数据库与对象存储部署参数、凭据 | 只由可信宿主加载，不放进资产正文、节点 Prompt、浏览器或 trace |

资产正文目前是经过 schema 校验的结构化 PG 数据；对象存储不是把所有正文和 trace 自动搬到云端。节点 session 事件、可获取的模型响应和工具过程仍在 PG 中按 run／context／step／attempt 关联。外部设计 Agent 的原生会话、工作目录和 SDK 内部状态，不会因为这些表存在就自动纳入可恢复存储。

## 从一个文件到一次运行

![文件到 Workflow 的配合图](../../../docs/diagrams/storage-harness-20261010/workflow-storage.svg)

[打开文件、资产与 Workflow 配合图](../../../docs/diagrams/storage-harness-20261010/workflow-storage.html)

1. **准备内容。** 宿主先认证主体与 Space 权限。CLI 上传非空附件，当前单对象上限 16 MiB；R2 使用内容键和条件 PUT，读回真实字节并校验 SHA-256 与大小，验证通过后才登记 PG BlobManifest。
2. **形成资产。** `importAsset` 校验已登记 schema、正文、准确依赖和附件，生成不可变资产版本。已有逻辑资产追加版本要求 `expectedHead`，避免并发覆盖。上传成功本身不等于已有业务资产，也不等于文件已成为某次 Run 的输入。
3. **固定本次工作。** Case 的 InputManifest 保存准确资产版本 ID；Run 固定准确方法版本、入口、清单和配置。后续追加资料或修改资产 head 不会改写历史 Run 的依据。
4. **交给节点。** 节点合同声明输入／输出槽、schema、状态与角色投影。`startNode` 只接受冻结清单或同 Run 的已有产物，保存实际交付的版本、字段视图及 context／session／attempt。节点拿限定 NodeClient 或绑定工具，不拿数据库连接与 R2 凭据。附件由宿主物化或受控读取；当前普通绑定正文阅读工具不保证自动提供所有媒体解码能力。
5. **保存实际结果。** 含新附件的产物先准备字节与清单，再由 `submitNode` 校验正文、依赖和附件。在同一个 PG 事务里保存资产版本、实际输入依赖、输出绑定、相关会话事件与步骤完成收据。桥接还映射原生 artifact 与 Space 版本。模型原始响应、失败记录和正式发布资产分别保存；完整响应被保存不等于产物已发布。
6. **供下游和人使用。** 下游消费绑定的准确版本；工作台从 PG 读取身份、正文和关系，经受权附件接口读取该版本实际绑定的字节。CLI 下载和前端附件组件核对 hash 与大小。评价、接受、采用和交付是额外的业务记录，不由上传或步骤成功自动触发。

## 一致性、失败与恢复

**PG 事务只保证 PG 内部的原子性。R2 与 PG 没有跨系统事务。** 新内容的顺序是对象写入、读回校验、登记清单、再绑定资产。对象已经写入而清单记账失败时，可用相同字节和媒体类型重试：同内容键不会覆盖，校验后重建／复用清单。同幂等提交键但内容改变会冲突，不能换键把未知提交结果伪装成新工作。

对象写成但尚无资产引用的情况可能留下孤儿内容；当前没有自动上传意图清理器、孤儿对象 GC、保留策略或备份恢复运行手册。它们不能在图中被当成已交付能力。对象缺失、provider 未配置、hash／大小不符或跨 Space／跨版本附件访问会报错，不用本地缓存或另一后端冒充成功。

已经保存的 Agent 结果和完成收据可以支持有界对账、避免重复模型调用；外部模型、工具、发布或付款副作用不因此获得 exactly-once。失去心跳的执行任务不会无条件自动重领。任意原生 SDK 会话恢复和历史执行包自动加载仍待建设。

## 当前接入与验证范围

共享层已提供 `R2BlobStore`、`RoutedBlobStore`、BlobManifest 校验、授权上传／资产导入／准确版本附件读取，以及 CLI `blob-upload`、`asset-import`、`attachment-download`。HTTP 写入须由宿主显式启用，并通过认证、Space 成员检查、来源与 CSRF 校验；当前允许人工主体或设计 Agent，观察者不能上传。浏览器目前负责阅读与下载，未新增上传流程。

creation 宿主支持通过绝对路径环境变量 `WORKFLOW_BLOB_CONFIG` 读取权限为 0600 的私有 JSON。文件中配置 `provider: "r2"`、endpoint、bucket、accessKeyId、secretAccessKey，可选 keyPrefix 与 maxBytes；密钥不写入文档或仓库；已有进程需要按此配置重新启动才启用 R2。未配置时保留 PG 小文件基线；需要读取 R2 key 却未配置 provider 时明确失败。

2026-10-10 的真实验证使用不含业务资料的隔离样例：R2 写入、重复写入、全新客户端读回一致；独立 Space 中通过 CLI 上传、导入准确资产版本、下载，并在重建宿主和删除本地源文件后再次下载，70 字节及 SHA-256 一致，PG 字节表没有该 R2 对象。确定性测试另覆盖对象写成后 PG 记账失败的同内容重试、旧 PG 附件继续读取与篡改拒绝。前端组件已构建并有字节校验测试；普通工作台的独立端到端实用验收仍需单独记录。

当前是 **≤16 MiB 的有界单对象链路**。分块／断点上传、大视频与完整制作素材链、自动 GC、跨存储迁移、备份恢复演练和生产多租户隔离尚未交付；服务层角色检查不等于数据库 RLS 或执行器沙箱。整体阶段状态仍见[建设路线](harness-roadmap.md)。

## 原有规划是否已经清楚

[Workflow Space](workflow-spaces.md) 和[存储与 SDK 方案](postgres-sdk-plan.md)已经规定了 PG／对象字节分工、冻结版本、节点读写合同和提交恢复方向。因此这次不是重新选择架构；R2 是落实已确认的 BlobStore 端口。

原文的不足在于设计分散、目标协议与当前实现容易混读，而且“尚无对象 provider”的描述已过时。本页和两张图把当前的读写主线、准确关联与一致性边界合在一起。完整生产存储仍不能说规划已闭合：大媒体上传协议、对象保留／删除规则、备份恢复与灾难演练，需要结合容量、成本和真实业务要求进一步设计与验收。

## 图的源码与核查

图使用 archify 3.0.1，候选 JSON 与来源清单随 HTML 保存于 `docs/diagrams/storage-harness-20261010/`。本轮仓库有未提交实现，图的 repository revision 对应所引用九份非敏感源文件的隔离证据快照，不表示主仓库或子模块已提交。`source-evidence.json` 记录主仓库起点与各文件 hash；HTML 不含私有部署文件、凭据、真实业务正文或内部验收对象 ID。

主要实现依据为 `packages/spaces/service.ts` 的冻结输入、节点提交与上传／读回，`packages/spaces/blob-store.ts` 的后端路由与内容校验，`packages/spaces/migration.ts` 和 `packages/postgres/postgres-run-store.ts` 的表关系，以及 `packages/space-api/server.ts` 的权限与准确附件读取。图的源码证据入口可查看这些准确片段。
