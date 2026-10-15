# OpenSandbox 容器内 Agent 节点

`@signal-room/workflow-opensandbox` 的新主路径把完整 Agent loop 放进 OpenSandbox 容器：Codex CLI 或官方 Agents SDK、模型交互、工具调用和工作文件都在固定镜像内执行。宿主负责选择镜像与权限、创建环境、通过 OpenSandbox 原生 Credential Vault 绑定授权、物化准确输入、验证实际输出，并将通过验证的结果交回现有 workflow。该路径必须显式选择 `runtime: "codex-cli"` 或 `runtime: "agents-sdk"`；不会在容器不可用时退回宿主执行。

一个 `createOpenSandboxEnvironment` owner 对应一个 workflow run。同一 run 的多个 Agent 节点通过 `createContainerAgentRunner` 串行连接并共享同一个 sandbox 和 `/work/shared`。调用 `runWorkflow` 时必须把准确的 `environment.binding` 放在 `metadata.openSandboxEnvironment`，它会作为节点请求的 `runMetadata.openSandboxEnvironment` 传入；环境 owner 会在每次借用时核对 sandbox ID、profile digest 和 run ID。这样部分恢复不会把旧步骤结果接到新建的空环境。节点失败、取消或命令状态未知会使共享环境失效并由 owner 回收；外层仍应在 `finally` 中调用 `dispose()`。

## 主路径：容器内 Codex 与 Agents SDK

[共享环境示例](../examples/opensandbox-shared.ts)展示两种 runtime 在同一 workflow run 中先后执行：Codex CLI 生成共享文件，Agents SDK 节点读取并复核，再由宿主校验和发布。其主要 API 形状如下：

```ts
const environment = await createOpenSandboxEnvironment({ connection, profile, credentials });
const policy = { runtime: "codex-cli", limits } as const;
const runner = createContainerAgentRunner({ environment, policy, prepare, finish });

const outcome = await runWorkflow({
  workflow,
  input,
  store,
  agentRunner: runner,
  metadata: { openSandboxEnvironment: environment.binding },
});

// The workflow owns the shared environment lifetime.
const cleanup = await environment.dispose();
```

实际接入应把 `dispose()` 放在 `try/finally`，不要只在成功分支回收。Codex 与 Agents SDK 使用各自显式的 `ContainerAgentPolicy`；Agent 定义需要合并 `containerAgentConfig(environment.binding.profileDigest, policy)` 返回的两个指纹字段。运行时会拒绝定义和 runner 的策略不一致。

`profile` 必须使用固定 digest 的镜像、明确 TTL 和资源；网络默认拒绝，仅接受有限 FQDN 规则。配置 `credentialBindings` 时，宿主 `credentials()` callback 只在创建期间提供原生 Vault credential entries。Vault proxy 按 binding 的 host、scheme、port、method 和 path 注入授权；不要把凭据放进 job JSON、工作文件、镜像、模型 prompt 或日志。OpenSandbox 管理 API 的连接 key 仍只由宿主用于管理面调用。

示例的授权读取现有、已授权的 Codex ChatGPT 登录，并通过 Agents SDK 的 SIWC 适配器取得相应凭据；这两种授权都通过原生 Vault 的精确路由规则供容器使用。示例会另外连接 PostgreSQL，使用 `ctx.publish` 保存宿主验收过的结果，并在新连接中验证资产读回和已完成 run 的 replay。

### 构建本机测试镜像

Node 24、Docker 和仓库依赖就绪后，默认构建基于脚本固定的 ARM64 Node 24 digest。Dockerfile 安装 Python 3 和 Codex CLI `0.154.0`，并打包 workflow、Agents SDK 适配器及固定 worker：

```bash
docker pull docker.io/library/node@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5
npm ci
npm run build:opensandbox-image
```

脚本末尾打印 `imageId`、`repoDigests` 和 `localImageReference`。把打印出的本机引用传给 `OPEN_SANDBOX_AGENT_IMAGE`。它只对应构建机上当前 Docker daemon 的本地 image ID；脚本不会 push 镜像，也不会生成可供远程服务拉取的 registry digest。若 OpenSandbox server 不在同一台机器，先将镜像推到可信 registry，并在 `profile.image` 使用 registry 返回的不可变 digest。

为其他架构或基础镜像，传入该架构下 Debian/Ubuntu 兼容、Node 24 且 digest 固定的基础镜像；脚本会安装 Python 和固定版本 Codex CLI：

```bash
npm run build:opensandbox-image -- --base docker.io/library/node@sha256:<该架构的64位digest> --tag local/workflow-container-agent:custom
```

不要用可变 tag 作为 `--base`，也不要把另一架构的本机镜像引用当成当前 server 可用的镜像。

### 运行共享示例

先按 [OpenSandbox 官方 server 配置](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)部署和启动 1.1.1 server。Docker backend 需要 bridge 网络和 egress sidecar；管理 API 使用认证，并仅绑定 loopback 或可信内网。不要使用 host 网络后声称 FQDN egress 策略有效。Docker socket 只提供给管理服务，不挂载进 Agent 容器。该配置不使用宿主 bind mount。

创建仓库外的私有 env 文件，填写以下值；不要提交文件或将其内容写入日志：

| 变量 | 用途 |
| --- | --- |
| `OPEN_SANDBOX_DOMAIN` | 管理 API 的 `host:port` |
| `OPEN_SANDBOX_PROTOCOL` | `http` 或 `https` |
| `OPEN_SANDBOX_API_KEY` | 管理 API 凭据，仅宿主管理客户端读取 |
| `OPEN_SANDBOX_AGENT_IMAGE` | 本机测试用构建输出，或 registry digest 镜像 |
| `WORKFLOW_DATABASE_URL` | 独立测试 PostgreSQL 数据库 |
| `SIWC_MODEL` | 当前账号授权可用的模型名 |
| `CODEX_AUTH_FILE` | 可选；已有 Codex ChatGPT 登录文件路径，默认读取 `~/.codex/auth.json` |

```bash
npm run example:opensandbox-smoke
node --env-file=/absolute/path/to/private.env examples/opensandbox-shared.ts
```

`example:opensandbox-smoke` 不连接模型或 OpenSandbox。共享示例会实际创建一个环境、调用模型、运行两个容器内节点并连接 PostgreSQL，因此应只在授权和测试服务都已准备好时显式运行。Codex 和 Agents SDK 的模型许可、轮数、工具数、运行时限及输出上限由示例中的策略定义；外层环境 TTL 还必须覆盖节点执行与清理时间。

## 旧接口：宿主 Agent loop 与容器工具

`createOpenSandboxAgentRunner` 是 PR #9 保留的旧路径：官方 Agents SDK、SIWC 模型调用和授权留在宿主，只把注册的 workspace 工具调用转交 OpenSandbox sandbox。它不代表 Codex CLI 或完整 Agents SDK loop 在容器内运行；新接入应使用 `createOpenSandboxEnvironment` 与 `createContainerAgentRunner`。旧接口仅用于现存调用迁移期间的显式兼容，不是自动选择的后备路径，也不得在新主路径失败时静默切换到 host runner。

## 行为与安全边界

- `prepare` 只物化当前 run 的准确输入；`finish` 读取真实容器字节并独立校验。两者不负责正式发布。校验通过后由 workflow 的 `ctx.publish` 交回宿主资产层。
- 容器工作区是共享可变状态，同 run 的节点按序使用；它不是秘密存储，也不提供节点间隔离。节点 prompt、固定工具策略、输入版本和环境 profile 都需要由业务定义。
- Codex 和 Agents SDK 运行的代码可执行任意容器内程序。固定命令注册表只是工具层限制；Docker 共享宿主内核，不提供 microVM 隔离。
- `tools` 注册表仅适用于 Agents SDK。Codex 使用自身容器内 shell；为 Codex 配置 `tools` 会被拒绝，避免误以为注册表可以约束它的原生工具。两个 runtime 均受环境网络、资源、时间和输出限制约束。
- 工作区路径检查是应用层的词法边界。模型生成程序可以创建符号链接并访问其他容器路径。上传文件没有操作系统级只读保证；需要强只读输入时须另行验证只读挂载。
- Sandbox 失败、取消、命令状态未知或清理超时后，owner 会拒绝继续借用，并尝试停止/删除共享环境。传输错误不能说明命令未执行，因此不能自动重放同一 attempt。
- 创建请求结果未知时不自动再次创建。创建 intent UUID 同时写入 intent event、sandbox metadata 和未知结果错误，供宿主对账；进程崩溃时有限 TTL 只作兜底。
- 尚未实现持久环境 lease、Worker 重启自动对账、claim fence、原子资产发布以及长期 orphan 回收。当前原型不能作为具备自动恢复能力的生产 Space 执行器。

## 当前主路径实测记录

2026-10-15，OpenSandbox server/SDK 1.1.1、Docker Desktop ARM64、Codex CLI 0.154.0、Node 24.19.0；两个 runtime 的请求模型均为 `gpt-6-luna`。以下使用新容器内主路径，不沿用旧 host-loop 验收结果。

| 验证 | 结果 |
| --- | --- |
| `npm ci`、`npm run verify`、`npm run example` | 通过；独立 PostgreSQL 开启，66 个测试文件、467 项测试全部通过，含新主路径 43 项测试 |
| Codex CLI 完整 loop | 通过；4 次实际容器命令，读取 CSV、生成并运行 Python，宿主读回真实 JSON 校验 `A=4/B=2` |
| Agents SDK 完整 loop | 通过；4 次模型请求，`read_file → write_file → read_file`，独立读回校验类别数 `2`、总额 `6` |
| 同 run 两节点共享 | 通过；两个 attempt 连接同一 sandbox，第二节点没有收到答案，只收到源文件摘要，必须读第一节点真实文件；源文件摘要复核一致 |
| 资产与 replay | 通过；两个 `valid` Agent 步骤及资产依赖入 PG，新连接读回；环境删除后已完成 run 重放不新增模型或容器调用 |
| 运行计量 | 通过；现有 step metrics 两节点 coverage 均为 `complete`，总用量 31,038 tokens，其中 cached input 19,456；未报告字段不补零 |
| 环境、Vault 与失败回收 | 通过；uid 1000、worker 不可写、无宿主 bind/登录文件/Docker socket、非 privileged；模型授权通过原生 Vault；实际失败后 owner 回收 |
| Codex 运行中取消 | 通过；容器外层探针确认 Python 长任务正在运行、完成文件尚不存在后取消；未接受结果，管理 API 确认环境删除，后续借用被拒绝 |

实测还修复了两个接口问题：OpenSandbox metadata 标签最多 63 字符，因此 64 字符摘要分成两个标签保存；Codex CLI 要求预先创建全新的 `HOME/.codex`。失败 trace 留在私有验收库，不改写历史。取消验收也区分 Codex 内层 PID 与容器外层 PID：实测 `NSpid` 为 `119 → 2`，不能用内层 PID 直接检查外层进程。所用镜像的 worker/protocol 字节与本次编译源码一致。

Codex 对该模型报告了 `model_metadata_fallback`，已留存在事件中；这次真实执行通过不表示 CLI 内置模型元数据完整。测试没有验收生产 Space、R2、跨进程恢复或真实拉片业务。

## PR #9 历史验收与实现记录

以下证据属于 PR #9 先前的 host Agents SDK + sandbox 工具路径及其 server/SDK 检查，不是上方新主路径的实测结论。保留这些记录以供追溯，不把它们作为 Codex CLI 容器执行或多节点共享环境的验收。

旧路径和共享 SDK 的历史实现发现：

- 文件权限使用数值 `700/600` 表达；`0o700/0o600` 会发送不同数值并导致服务报错。
- OpenSandbox 1.1.1 的 `files.readBytes` `offset/limit` 按行计数，会规范化换行并丢弃结尾换行。旧适配器使用 HTTP byte Range 和流式接收来保留原始字节，并在超限时关闭读取。单个 transport chunk 仍可能在拒绝前超过应用上限。
- 取消发生在创建、准备或回收阶段时也必须结束宿主等待。非合作的宿主 callback 无法由 JavaScript 强制停止，因此不能在 callback 中做正式发布。
- 旧 CSV 示例在宿主 oracle 验证真实产物后将 Agent 步骤标为 `valid`；仅发布资产不会让待校验 Agent 步骤获得 replay 资格。

### 历史实测（2026-10-15；旧 host-loop 路径）

| 验证 | 历史结果 |
| --- | --- |
| Node 24.19.0：`npm ci`、`npm run verify`、`npm run example` | 通过；独立 PostgreSQL 开启，63 个测试文件、424 项测试全部通过，含新增的 21 项适配器测试 |
| 无模型 fake smoke | 通过；不连接模型或 OpenSandbox 服务 |
| 真实旧适配器 smoke | 通过；3 个容器分别验证文件／CRLF／空文件／图片、实际命令取消、超限后停止；管理 API 确认全部删除 |
| Server 网络与隔离配置 | 未认证 401；默认拒绝时 DNS 和外部 IP 连接均失败，而宿主能访问该 IP；allowlist 测试返回 HTTP 200。CPU、内存、PIDs 限制及无宿主 bind mount 已检查 |
| 真实 `gpt-6-luna` CSV | 修复后第三轮通过：5 次模型请求、4 次工具调用，宿主校验 `A=3/B=5`，PG 新连接读回，已完成步骤 replay 不新增模型／容器，kill 和 close 成功 |

前两轮旧 CSV 实跑分别暴露产物路径格式和节点验证状态遗漏；失败记录留在私有验收库，没有修改历史状态或把失败伪装成成功。旧验收没有接入生产 Space、R2、真实拉片业务或长期服务。

参考：[OpenSandbox 官方 TypeScript SDK](https://open-sandbox.ai/sdks/javascript)、[OpenSandbox server 配置](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)。
