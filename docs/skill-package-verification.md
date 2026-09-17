# 完整 Skill 包加载验证

2026-09-17，以 Codex CLI / TypeScript SDK 0.154.0、`gpt-5.6-luna`、medium 推理强度验证。真实执行经过 `runWorkflow → ctx.agent → CodexSdkRunner → SDK`，不是直接向模型提问。

## 修复前的复现

构造 SKILL.md 引用 `references/rule.json` 与 `scripts/compute.mjs`，脚本再读取 `assets/value.txt`。规则文件包含临时随机 token，脚本计算结果为 42。

旧配置只冻结 `{ path, content }` 中的 SKILL.md 正文，随后移走源目录。真实模型返回：

```json
{"status":"missing_resources","token":null,"result":null}
```

这证明旧快照无法独立携带 skill 的依赖。它不意味着源目录仍在且可读时，每一次旧调用都会失败；那种情况下模型可能偶然访问原文件，但不具备完整、可复现的交付合同。

## 修复后的真实验证

执行 [skill-package-smoke.mjs](../examples/skill-package-smoke.mjs)，先用 `snapshotSkill` 捕获目录，再删除源目录。此次 fixture 包含：

- SKILL.md：入口与相对资源指令；
- references/rule.json：运行时随机 token 和乘数 6；
- scripts/compute.mjs：具有执行位的脚本；
- assets/value.bin：字节 `07 00 ff`。

真实返回与本机预期完全匹配：

```json
{"token":"3eefa66224659de9d4cbe285","result":42,"assetHex":"0700ff"}
```

SDK `item.completed` 的 `command_execution` 事件记录了两次成功命令：读取运行目录中的 SKILL.md；读取规则并运行 compute.mjs。第二条命令退出码 0，输出包含相同随机 token、42 和 `0700ff`。验证程序对这些工具事件做断言，不接受模型仅自述“已运行”。

从同一隔离 cwd 执行 `codex debug prompt-input`，原生 Available skills 目录列出了 `package-probe` 及运行目录下的 SKILL.md，确认原生发现可用。

## 自动回归与边界

自动测试覆盖完整包、二进制字节、执行位、源目录删除、reference 变化后的新摘要和输出、变化快照拒绝旧线程 resume、嵌套 reference 调用交付整包、篡改、路径冲突、符号链接和旧目录污染。

这些检查证明包的交付和此 fixture 的实际执行；不代替每个业务 skill 自身的质量验证，也不安装它所需的外部命令或服务。工作流外层节点可以整体 replay，修改方法仍须更新 workflow revision 并开启新 run。具体接入见 [Codex 与 Skills](./codex-and-skills.md)。
