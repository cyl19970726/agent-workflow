# 使用 Workflow 编排 Skill

仓库提供 [`agent-workflow`](../.agents/skills/agent-workflow/SKILL.md) skill，供开发 Agent 使用本库编写、组合、验证和维护工作流。它会引导 Agent 查当前 API，选择阶段、资产、模型与方法配置，并验证失败和恢复路径。

这与业务 Agent 的方法 skill 不同：前者帮助写代码，后者通过 `config.skills` 交付给一次模型执行。安装本 skill 不会自动让所有 Builder/Reviewer 加载它，也不会安装任何业务方法。

## 在本仓库使用

skill 已位于 `.agents/skills/agent-workflow/`。可以直接引用该 SKILL.md；支持项目 skill 发现的环境中可用 `$agent-workflow` 调用。例如：

```text
使用 $agent-workflow，为当前项目增加一个文档研究流程。
先冻结输入，再并行执行内容和引用检查，最后汇总可读资产。
复用项目已有模型配置和队列。请先用 fake runner 验证失败分支、
资产关联和恢复；这次不运行真实模型。
```

或直接指定文件：

```text
读取 .agents/skills/agent-workflow/SKILL.md，按照它为当前项目编写 workflow。
```

## 在消费项目使用

如果项目已将本仓库放在 `vendor/agent-workflow`，可在**消费项目根目录**建立项目内符号链接：

```bash
git submodule update --init --recursive
mkdir -p .agents/skills
# 先检查这个名字没有现有文件、目录或链接；不要覆盖已有 skill。
test ! -e .agents/skills/agent-workflow && test ! -L .agents/skills/agent-workflow && \
  ln -s ../../vendor/agent-workflow/.agents/skills/agent-workflow .agents/skills/agent-workflow
```

链接目标应为本项目的 submodule，不能指向另一人的绝对路径或用户级目录。提交这个相对链接和 submodule 指针，让其他克隆获得同一版本。消费项目的 AGENTS.md 可写：

```md
使用 agent-workflow 库编写流程时，读取
[agent-workflow skill](.agents/skills/agent-workflow/SKILL.md)。
```

不支持符号链接的环境可在项目 AGENTS.md 直接指向 `vendor/agent-workflow/.agents/skills/agent-workflow/SKILL.md`。这仍可按路径显式使用；是否在技能菜单出现取决于工具的项目 skill 发现能力。已有会话未刷新技能列表时，直接读该路径或重新打开项目。

不要复制出一份长期独立维护的 skill，也不要为了方便安装到 `~/.agents/skills`、`~/.codex/skills` 或 `~/.claude/skills`。共享版本由项目的 submodule 提交控制。

## 给 Agent 的任务应该包含什么

提供目标和输入/产物需求即可；已有配置可让 Agent 自己查代码。若任务涉及实际模型执行，明确模型、预算和是否允许真实运行。可这样区分请求：

| 请求 | 预期交付 |
| --- | --- |
| “写一个 workflow，先别跑真实模型” | 流程代码、fake-runner 验证、运行入口 |
| “给每个角色配置不同方法” | 冻结方法文件与哈希、AgentDefinition、有效 prompt 收据 |
| “接入现有队列和工作台” | 持久 dispatcher、阶段/资产读模型、宿主集成验证；不新增第二套 scheduler |
| “旧任务恢复时重跑了 Builder” | 核对定义/输入/方法版本、节点验证及父控制步骤 replay，再做有证据的修改 |

最后检查 Agent 的交付：使用的是当前真实 API；输入和版本有明确来源；执行成功与质量状态分开；报告里区分模拟测试和真实模型结果。

## 维护 skill

本 skill 随共享仓库版本维护。修改后检查其本地链接、API 示例与实际代码一致，再运行 `npm run verify`。通用 skill 格式可额外使用当前环境的 skill validator 校验。共享仓库先提交、推送，消费项目再升级 submodule；不自动同步到全局目录。
