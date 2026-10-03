# Harness 路线：调优中暴露的问题

这里只记录在真实调优中出现过、有 trace 证据的 harness 问题。每条写明现象、已做了什么、还缺什么。来源是一个三阶段内容创作 workflow 在同一题目上的多轮调优（见[调优循环](./tuning-loop.md)中的案例）。

## 已完成

| 问题 | 现象 | 现在的支持 |
| --- | --- | --- |
| 同一次执行里重复的 step key 被静默 replay | 修订轮复用了 `draft-1` 这个 phase key，第二轮直接拿回第一轮结果，流程报告“已改完”，稿子没变 | `phase`/`agent`/`task`/`call`/`map`/`parallel` 的 key 在一次执行内重复即失败；失败后同 key 重试仍允许；恢复时照常 replay |
| 无法指定 Codex 可执行文件，记录的版本不是实际运行的 | SDK 自带的 CLI 拒绝新模型，只能靠自定义 factory 换可执行文件；trace 仍记录 PATH 里 `codex` 的版本 | runner 选项 `codexOptions`（含 `codexPathOverride`）；未给 `cliBinary` 时按实际可执行文件记录版本；`runtime.json` 记录可执行文件路径与合并后的配置 |
| 角色环境无法按 Agent 设置 | 仓库 `AGENTS.md` 被注入给写作角色，工程汇报规范进了内容 | Agent 配置 `codexConfig`，合并在 runner 配置之上，例如 `project_doc_max_bytes: 0`；只有设置了才进入 fingerprint |
| 模型不可用要到 run 中途才发现 | 账号不支持的模型在 run 里失败，宿主 Agent 接手手工完成 | `probeCodexModel`：只读沙箱、一次极短调用，返回可用与否、CLI 版本和拒绝原因 |
| 读 trace 靠各项目自己写脚本；按修改时间找会话会找错 | 调优脚本按最新修改时间取会话，拿到了同机另一个项目的会话 | `summarizeCodexAttempt`（命令、失败退出码、搜索、改动文件、错误、字符与 token）和 `codexSessionFile`（按 thread id 定位） |

## 未完成

| 问题 | 证据 | 目前的做法 | 候选方向 |
| --- | --- | --- | --- |
| 用户级 `~/.codex/AGENTS.md`（约 1.2 万字）无法按调用关闭 | 关掉仓库文档后，内容角色的首条注入仍有这份工程协作规范 | 在内容角色 prompt 开头声明它不适用 | 为角色提供隔离的 `CODEX_HOME`（`CodexOptions.env`）。难点是登录凭据也在其中，不能随意复制；需要先确认 CLI 支持的只读引用方式 |
| 角色能看到未授权的工具与用户级 skills | 设计师角色在沙箱里读了用户级浏览器 skill 并尝试打开浏览器，最终超时 | prompt 明确禁止截图与浏览器；工具提示先在 Agent 沙箱实跑 | 调查 Codex 的 feature/工具开关，在 `codexConfig` 中按角色关闭；结论需要以 trace 验证，而不是以文档为准 |
| 角色的“防什么失败”只存在于消费项目代码里 | 文档和工作台需要列出每个角色的目的与所防失败，目前由消费项目各自维护 | 消费项目的角色规格里保留 `guards` 字段并生成文档 | 等第二个消费项目需要时，再考虑在 `defineAgent` 上加不参与指纹的说明字段 |
| 审阅者校准没有通用工具 | 审阅者先后出现过太松与太严，靠正反案例校准才稳定 | 消费项目自带校准脚本 | 抽象出“同一审阅 Agent 跑一组带预期判决的案例，报告一致率与漏报”的通用助手 |
| 同一 SQLite 账本上不宜并发运行 | 账本使用 `delete` 日志模式，并发写入有锁冲突风险 | 同一账本一次只跑一个 run | 评估 WAL 模式与宿主调度的配合 |
| 在消费仓库里运行本仓库测试有两处既有失败 | `runner.test.ts` 的 SDK 版本期望、`read-model` 的包解析，都依赖本仓库自己的 `node_modules` | 在本仓库独立 checkout 中运行 `npm run verify` | 让这两处测试不依赖安装布局 |
