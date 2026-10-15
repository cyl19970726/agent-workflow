# OpenSandbox 节点工作区

这是一个显式启用的节点工作区原型：官方 Agents SDK、模型授权和业务工具留在可信宿主；需要文件和程序的节点使用 OpenSandbox Docker 环境。一个 Agent attempt 的多轮工具调用共用一个环境，结束后下载实际结果并回收环境。不需要文件和程序的节点继续使用已有 runner。

## 本次解决什么

同一个 CSV 任务中，Agent 读取材料、编写 Python、运行脚本，宿主读取并校验生成的 JSON。临时文件和命令在容器内，模型授权、数据库凭据与 OpenSandbox 管理凭据不进入容器。环境配置摘要进入已有 Agent config 指纹；修改镜像或工具权限不会误用旧配置的 replay 结果。

`@signal-room/workflow-opensandbox` 是可选适配包。它不会替换现有本机 workspace tools，也不会在 OpenSandbox 不可用时退回宿主执行。导入模块、默认测试和默认示例均不创建容器或调用模型。

## 与业务状态的关系

容器里出现一个文件，不等于业务资产已经提交。示例先读取真实字节、检查 JSON 内容，再由现有 workflow 的 `ctx.publish` 保存结果；使用 PostgreSQL 新连接读回，并验证已完成步骤 replay 不会再次调用模型或创建容器。

环境回收与业务结果分别报告。成功得到结果后回收失败，必须保留结果并记录待清理状态；执行失败时保留原始失败及清理诊断。连接断开、命令状态未知时停止本次工作，不能把网络失败解释成命令未执行并自动重放。

## 安全与支持边界

- 镜像固定到 digest，资源和生命周期由宿主配置；网络策略显式拒绝外连。管理服务必须启用认证，Docker backend 必须配置 bridge 和 egress sidecar，不能使用 host 网络后声称外连策略生效。
- 固定命令注册表限制模型可调用的入口；允许执行模型写出的 Python 仍然是运行任意代码。Docker 共享宿主内核，不提供 microVM 级别的隔离。
- 工具接受工作区相对路径或工作区内的绝对容器路径，并拒绝词法越界；路径限制是工具接口限制，符号链接或生成程序仍可访问其他容器路径。上传到普通容器目录的输入不具有操作系统级只读保证；生成的程序也可能修改它。需要强只读材料的业务必须另行提供并验证只读挂载。
- 工作区不是秘密存储。宿主业务工具的权限、外部副作用及程序节点 `ctx.task` 不会自动被这个适配包隔离。
- 本原型不允许从容器目录自行发布资产；宿主负责验证输出、选择正式资产、保存来源与审阅状态。不会自动提供大媒体搬运或 R2 上传。
- 当前未实现 Space 的冻结 `environmentRef`、持久环境资源表、Worker 重启对账和 Run claim 提交 fence。事件与有限 TTL 不代替这些能力。尚不能将该原型作为可自动恢复的生产 Space 执行器。
- 创建请求结果未知时不自动再次创建；必须检查服务端残留环境。进程崩溃时由有限 TTL 兜底，生产接入前仍需独立清理与对账机制。

## 验证方式

本地确定性测试检查配置指纹、工具权限、结果收集、取消与失败路径；真实环境测试另外检查文件往返、命令执行、网络策略和实际删除。真实模型示例单独显式运行，沿用宿主已有的 ChatGPT 授权，不创建新的 API key，不在默认验证中消耗模型额度。

接口通过、容器行为通过和业务质量接受是不同结论；小型 CSV 通过不代表拉片或内容创作方法质量已验证。

## 如何运行

使用 Node 24，在仓库根目录安装和构建。先执行不依赖任何远程服务的适配器检查：

```bash
npm ci
npm run example:opensandbox-smoke
```

真实环境需要独立的 OpenSandbox server、Docker 和一个测试用 PostgreSQL 数据库。可在项目私有目录创建 Python venv，安装 `opensandbox-server==1.1.1`，按[官方 server 配置](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)生成配置，再用 `opensandbox-server --config <配置文件>` 启动。管理 API 只绑定 loopback 或可信内网，设置随机 API key；不要把配置和凭据提交到仓库。Docker socket 只供管理服务使用。

本次验证采用 Docker Desktop 27.4.0 的 Linux ARM64 环境。以下 digest 是 ARM64 镜像，其他架构需重新解析并固定对应 digest：

| 组件 | 锁定版本／镜像 |
| --- | --- |
| Server / TypeScript SDK | `1.1.1` / `@alibaba-group/opensandbox@1.1.1` |
| 节点 Python 3.12.15 | `docker.io/library/python@sha256:739ba32ae445e8d58f3d90feb85f83bebc8346f8dd280fa1eb5848f4ff1ed163` |
| execd `release-1.1.1` | `docker.io/opensandbox/execd@sha256:1a6fc28b5efe098f6c168ea606dbad6bde2d1fc479329b4c8a6279c82ee02e94` |
| egress `v1.1.7` | `docker.io/opensandbox/egress@sha256:bc1dc7791d2857ca08c31d17f8ad6886b127d42bedb372517886171ef7d287e2` |

关键 server 配置为 `[runtime] type="docker"`、上述 `execd_image`，`[docker] network_mode="bridge"`、`publish_host="127.0.0.1"`、`no_new_privileges=true`，`[egress] mode="dns+nft"` 及上述 egress 镜像。Docker Desktop 直接端口模式还使用 `[proxy] resolve_internal=false`。配置可用的端口范围并保留默认 capability 限制；不要配置宿主目录挂载。测试确认只有 OpenSandbox 管理的运行时卷，没有宿主 bind mount 或 Docker socket。

在私有环境文件中配置以下变量。真实 CSV 示例另需 `WORKFLOW_DATABASE_URL` 和明确的 `SIWC_MODEL`；SIWC 使用已有的 `workflow-siwc` 授权，不把模型凭据交给容器。

| 变量 | 含义 |
| --- | --- |
| `OPEN_SANDBOX_DOMAIN` | 管理服务的 `host:port` |
| `OPEN_SANDBOX_PROTOCOL` | 本机测试为 `http`，远程按部署使用 `https` |
| `OPEN_SANDBOX_API_KEY` | 管理服务配置的私有 key，仅宿主读取 |
| `OPEN_SANDBOX_IMAGE_DIGEST` | `image@sha256:...`，不能填可变 tag |
| `WORKFLOW_DATABASE_URL` | 独立测试库连接，不要指向生产库 |
| `SIWC_MODEL` | 现有授权可用的模型；本轮使用 `gpt-6-luna` |

```bash
# 私有文件必须使用自己创建的文件路径；不要将其内容复制到日志或提交。
node --env-file=/absolute/path/to/private.env examples/opensandbox-live.mjs
node --env-file=/absolute/path/to/private.env examples/opensandbox-csv.ts
```

[真实容器验收](../examples/opensandbox-live.mjs)完全不调用模型：验证文本与图片原始字节、Python 计算、路径规则、正在运行的命令取消、输出超限后的终止状态，并从管理 API 核对环境已删除。[CSV 示例](../examples/opensandbox-csv.ts)会调用真实模型，最多 8 轮、8 次工具调用、SDK 总时限 120 秒，环境 TTL 180 秒；主机中的结果校验才包含正确答案，提示词不提供答案。结果通过 `ctx.publish` 保存，重连 PostgreSQL 读回后，用会拒绝任何新 Agent 调用的 runner 验证 replay。

接入其他节点时，从完整示例复用 `openSandboxAgentConfig` 和 `createOpenSandboxAgentRunner`。`prepare` 物化准确输入，`hostTools` 添加已有宿主业务工具，`finish` 只收集和校验结果，正式提交放在 runner 返回之后。不同节点的业务 prompt、材料和 oracle 由业务项目提供；不要复制 CSV 中的领域标准到共享包。

## 本轮实际发现并修正的问题

- OpenSandbox 1.1.1 文件权限使用数值 `700/600` 表达权限位；JavaScript 的 `0o700/0o600` 会发送不同数值并使服务报错。已按真实协议修正。
- `files.readBytes` 的 `offset/limit` 是按行读取，会规范化换行并丢掉结尾换行。适配器改用 HTTP byte Range 和流式接收，计数真实字节，超限时关闭读取；文本和图片不再经过行处理。
- 取消发生在创建、准备或回收阶段也必须结束宿主等待。适配器传递取消信号，并分别限制 kill、close 和清理记录的等待时间；不合作的宿主回调仍可能迟到产生副作用，因此回调不得承担正式发布。
- 示例的宿主 oracle 验证了真实产物后，需要将该 Agent 步骤标为 `valid`；仅发布资产时标为有效，不会让前面的待校验 Agent 步骤获得 replay 资格。已通过核心运行时回归测试覆盖这个交接。
- 命令执行状态未知后，本次 attempt 的远程工具与宿主工具都拒绝继续调用。清理结果在业务成功和失败时都尝试保存；创建结果未知的类型不会被后续日志写入失败覆盖。

## 后续生产接入

先将环境配置及输入材料版本冻结到方法，持久保存创建意图、环境身份和未知状态；再把取消、claim 失效和正式发布的检查放进同一提交边界，验证旧 Worker 不能迟到发布。随后测试 Worker 重启、命令断流和孤儿回收，再迁移一个真实依赖文件的业务节点。无需同时建设环境市场、第二个队列或新的工作台。

## 实测记录（2026-10-15）

| 验证 | 结果 |
| --- | --- |
| Node 24.19.0：`npm ci`、`npm run verify`、`npm run example` | 通过；独立 PostgreSQL 开启，63 个测试文件、424 项测试全部通过，含新增的 21 项适配器测试 |
| 无模型 fake smoke | 通过；不连接模型或 OpenSandbox 服务 |
| 真实适配器 smoke | 通过；3 个容器分别验证文件／CRLF／空文件／图片、实际命令取消、超限后停止；管理 API 确认全部删除 |
| Server 网络与隔离配置 | 未认证 401；默认拒绝时 DNS 和外部 IP 连接均失败，而宿主能访问该 IP；另行 allowlist 测试返回 HTTP 200。CPU、内存、PIDs 限制及无宿主 bind mount 已检查 |
| 真实 `gpt-6-luna` CSV | 修复后第三轮全链路通过：5 次模型请求、4 次工具调用，宿主校验 `A=3/B=5`，PG 新连接读回，已完成步骤 replay 不新增模型／容器，kill 和 close 成功 |

前两轮模型实跑分别暴露产物路径格式和节点验证状态遗漏；失败记录保留在私有验收库中，没有修改历史状态或把失败伪装成成功。测试没有接入生产 Space、R2、真实拉片业务或长期服务；不据此宣称这些场景已通过。

参考：[官方 TypeScript SDK](https://open-sandbox.ai/sdks/javascript)、[OpenSandbox server 配置](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)。
