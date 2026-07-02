---
name: ccps-configure-agents
description: >
  子 Skill：为 ccps profile 配置专属子代理 (agents)。
  由主 Skill ccps-create-profile 在阶段 5 中读取和使用。
  涵盖 agent 文件格式、模型选择、工具安全分级、官方模板示例、
  agent/skill/command 选型指南、插件内 agent 与用户目录 agent 能力差异。
---

# Profile Agents 配置指南

你为 ccps profile 创建和配置专属的子代理 (agents)。

## Agents 是什么

Agents 是拥有独立上下文窗口、专属 system prompt、模型与工具权限的委派执行单元。适合将特定职责（审查、分析、测试、文档）隔离到独立实例中，避免污染主会话上下文。

存放位置：`<profile-root>/claude-home/agents/<agent-name>.md`

## Agent 文件格式 — 全字段参考

YAML frontmatter 所有已确认字段：

| 字段 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `name` | string | agent 唯一标识，用 kebab-case | **必填** |
| `description` | string | 触发时机说明，主会话据此判断是否委派 | **必填** |
| `tools` | string | 允许使用的工具列表，逗号分隔 | 继承父会话 |
| `disallowedTools` | string | 显式禁止的工具列表，优先级高于 tools | 空 |
| `model` | string | 运行模型 | `inherit` |
| `permissionMode` | string | 权限模式 | 默认行为 |
| `maxTurns` | integer | 最大轮次，防止失控循环 | 无限制 |
| `skills` | list | 预加载的 skill 列表，agent 启动即携带领域知识 | 空 |
| `mcpServers` | map | 绑定的 MCP 服务器配置 | 空 |
| `hooks` | map | 生命周期钩子 | 空 |
| `memory` | string | 记忆模式，如 `project` 表示可读写项目记忆 | 无 |
| `background` | boolean | 是否在后台运行 | `false` |
| `effort` | string | 推理力度 | 默认 |
| `isolation` | string | 隔离模式 | 无 |
| `color` | string | 在终端中显示的颜色标识 | 无 |
| `initialPrompt` | string | 首次启动时注入的额外提示 | 无 |

**插件内分发的 agent 限制**：通过 plugin 分发的 agents 不支持 `hooks`、`mcpServers`、`permissionMode`，这些字段会被忽略。只有放在用户目录 (`claude-home/agents/`) 下的 agent 才能使用完整字段集。

```markdown
---
name: agent-name
description: 何时触发这个 agent，触发条件要写得具体明确
model: sonnet
tools: Read, Grep, Glob
disallowedTools:
maxTurns: 8
skills: []
mcpServers: {}
hooks: {}
memory:
background: false
effort:
isolation:
color: blue
initialPrompt:
---

# Agent 正文指令

具体的 agent 行为指令，使用祈使句，写清目标、约束和输出格式。
```

## 模型选择指南

| 模型 | 适用场景 | 成本 |
|---|---|---|
| `haiku` | 只读检查、快速分类、轻量资料整理 | 最低 |
| `sonnet` | **默认推荐** — 通用编码、代码审查、测试生成、性能排查 | 平衡 |
| `opus` | 复杂跨文件推理、模糊需求分析、工具链重编排、安全审计 | 最高 |
| `fable` | 需本地基准测试验证，不建议作为默认 | 不确定 |
| `inherit` | 继承主会话模型 | 随主会话 |

**默认策略：用 `sonnet`。** 只有明确需要重度推理（安全审计、架构分析）时才升级到 `opus`；轻量只读任务可用 `haiku` 降本。

## 工具安全分级

工具按能力从低到高分为四层。选型原则：**默认最低权限，按需升级**。

### 第 1 层：只读工具（默认安全包）

```
tools: Read, Grep, Glob
```

- 只能查看和搜索文件，不能修改任何内容
- 适用于：代码审查、文档分析、搜索定位
- **默认所有 agent 都应从这层开始**

### 第 2 层：只读 + 执行

```
tools: Read, Grep, Glob, Bash
```

- 在只读基础上增加命令执行能力（运行测试、构建、lint 等）
- 适用于：验证型 agent（跑测试、检查编译、分析性能指标）
- 升级条件：agent 需要运行命令来获取证据

### 第 3 层：可修改代理

```
tools: Read, Grep, Glob, Edit, Write, Bash
```

- 能直接修改文件
- 适用于：测试编写、自动修复、代码生成
- 升级条件：agent 的核心职责就是创建或修改文件
- **注意：包含 Edit/Write 的 agent 应限制 maxTurns 防止过度修改**

### 第 4 层：编排代理

```
tools: Read, Grep, Glob, Edit, Write, Bash, Agent
```

- 可以再委派子 agent
- 适用于：复杂多阶段编排、需要分工协作的任务
- 升级条件：任务需要拆分给多个专门 agent
- **慎用：层级过深会导致上下文碎片化和调试困难**

### 升级路径图

```
只读包 (默认)
  │
  ├─ 需要运行命令？ → + Bash
  │
  ├─ 需要修改文件？ → + Edit, Write
  │
  └─ 需要委派子任务？ → + Agent
```

每一步升级都要有明确理由。如果 agent 只需要跑测试来验证，加 Bash 即可，不需要 Edit/Write。

## Agent vs Skill vs Command 选型指南

三者定位不同，选错会导致维护负担或能力浪费。

| 维度 | Agent | Skill | Command |
|---|---|---|---|
| **本质** | 独立运行的 Claude 实例 | 按需加载的知识/流程包 | 已并入 Skill 体系 |
| **有自己的上下文窗口** | 是 | 否（在主会话中执行） | — |
| **可指定独立模型** | 是 | 否 | — |
| **可限制工具** | 是 | 否 | — |
| **适合场景** | 需要隔离的专项任务 | "你总在重复解释的步骤" | — |
| **存放位置** | `agents/` | `skills/` | `skills/`（已并入） |

### 选择决策树

1. **这个任务需要独立上下文和独立工具权限吗？**
   - 是 → Agent
   - 否 → 继续

2. **这是一套可复用的流程、知识或领域指令？**
   - 是 → Skill
   - 否 → 直接写在 CLAUDE.md 中

3. **需要两者协同？**
   - 在 agent 的 `skills` 字段中预加载 skill，让 agent 一启动就带着领域知识

### Agent 预加载 Skills 示例

让 agent 在启动时就具备特定领域知识，无需每次手动提示：

```yaml
---
name: django-reviewer
description: 审查 Django 项目的代码质量、ORM 使用和安全问题
model: sonnet
tools: Read, Grep, Glob
skills:
  - django-best-practices
  - python-security-checklist
maxTurns: 8
color: purple
---
你是一个 Django 专家代码审查员。
你已经预加载了 Django 最佳实践和 Python 安全清单。
审查时优先对照预加载知识中的规则。
```

这样 agent 启动时 `django-best-practices` 和 `python-security-checklist` 的内容自动注入上下文，agent 无需额外搜索就能应用这些领域知识。

## 插件内 Agent vs 用户目录 Agent

| 能力 | 用户目录 Agent (`claude-home/agents/`) | 插件内 Agent (plugin distributed) |
|---|---|---|
| `hooks` | 支持 | **不支持，会被忽略** |
| `mcpServers` | 支持 | **不支持，会被忽略** |
| `permissionMode` | 支持 | **不支持，会被忽略** |
| 其他所有字段 | 支持 | 支持 |
| 适用场景 | 完整功能需求，需要生命周期钩子或绑定 MCP | 简单分发、纯指令型 agent |

**结论**：ccps profile 中的 agent 放在用户目录下，可使用完整字段集。如果 agent 不需要 hooks/mcpServers/permissionMode，放哪里都一样。

## 官方模板示例

以下 5 个 agent 覆盖常见开发场景，可直接用于 profile 配置。

### 1. 代码审查 Agent

```yaml
---
name: code-reviewer
description: >
  Reviews code for quality, maintainability, and obvious security issues.
  Use proactively after code changes.
tools: Read, Glob, Grep
model: sonnet
color: purple
maxTurns: 8
---
You are a senior code reviewer.
When invoked:
- Inspect the changed files and nearby code paths.
- Prioritize correctness, maintainability, security, and regression risk.
- Give concrete findings first, then concise suggestions.
- Prefer evidence from code over speculation.
- If you are uncertain, state the uncertainty clearly.
```

**设计要点**：只读工具即可，不需要执行或写入；sonnet 是性价比最优选择。

### 2. 安全审计 Agent

```yaml
---
name: security-auditor
description: >
  Reviews changed code for security risks, dangerous patterns, secrets exposure,
  and trust-boundary mistakes. Use proactively before commit or PR.
tools: Read, Glob, Grep, Bash
model: opus
color: red
maxTurns: 10
---
You are a security auditor.
Goals:
- Find exploitable or production-relevant issues first.
- Focus on auth, secrets, input validation, SSRF, RCE, path traversal,
  SQL injection, XSS, CSRF, insecure deserialization, and privilege boundaries.
- Prefer concrete code evidence and realistic exploit paths.
- If you suggest a fix, keep it minimal and explain why it reduces risk.
```

**设计要点**：opus 模型用于深度跨文件推理；Bash 用于运行安全扫描工具或验证漏洞路径。

### 3. 性能分析 Agent

```yaml
---
name: performance-analyzer
description: >
  Investigates performance bottlenecks, hot paths, excessive I/O,
  and unnecessary re-renders or repeated work.
tools: Read, Glob, Grep, Bash
model: sonnet
color: orange
maxTurns: 8
---
You are a performance analysis specialist.
When invoked:
- Start with the most likely bottlenecks.
- Collect evidence from code paths, queries, loops, cache usage,
  rendering patterns, and build/runtime logs.
- Separate measured issues from hypotheses.
- Recommend fixes in priority order: biggest impact first, lowest risk first.
```

**设计要点**：需要 Bash 运行 profiling 工具或构建命令获取指标数据。

### 4. 测试编写 Agent

```yaml
---
name: test-writer
description: >
  Adds or updates focused tests for changed behavior, edge cases,
  and regression-prone logic.
tools: Read, Glob, Grep, Edit, Write, Bash
model: sonnet
color: green
maxTurns: 12
memory: project
---
You are a pragmatic test-writing agent.
Rules:
- Prefer the project's existing test framework and naming conventions.
- Add the smallest set of tests that meaningfully protects behavior.
- Cover happy path, one realistic failure path, and one edge case when relevant.
- Avoid brittle assertions and avoid over-mocking unless required by the codebase.
```

**设计要点**：需要 Edit/Write 创建测试文件，Bash 运行测试验证；`memory: project` 让 agent 记住项目的测试约定。

### 5. 文档生成 Agent

```yaml
---
name: doc-writer
description: >
  Generates or updates API documentation, README sections, and inline comments
  based on actual code behavior. Use when documentation is missing or outdated.
tools: Read, Glob, Grep, Edit, Write
model: sonnet
color: cyan
maxTurns: 10
---
You are a technical documentation writer.
When invoked:
- Read the target code thoroughly before writing anything.
- Write documentation that reflects actual behavior, not intended behavior.
- Use the project's existing documentation style and format.
- Prefer concrete examples over abstract descriptions.
- For API docs, include parameters, return values, error cases, and usage examples.
- Keep inline comments minimal — only explain WHY, not WHAT.
```

**设计要点**：需要 Edit/Write 更新文档文件；不需要 Bash；用 sonnet 平衡质量和成本。

## 创建流程

### 第 1 步：分析 Profile 用途

根据 profile 的 CLAUDE.md 和用户需求，判断需要哪些专项 agent。每个 agent 应对应一个明确的职责边界。

### 第 2 步：推荐 Agents

推荐 1-2 个最相关的 agents（首次不超过 3 个）。对每个 agent 说明：
- 解决什么问题
- 为什么需要独立 agent 而不是写在 CLAUDE.md 里
- 推荐的模型和工具层级

### 第 3 步：用户确认

让用户选择要创建哪些 agents，以及是否需要调整模型或工具配置。

### 第 4 步：生成 Agent 文件

为每个选中的 agent 生成完整的 markdown 文件。要求：

- frontmatter 包含 `name`、`description`、`model`、`tools`、`color`、`maxTurns`（其他字段按需）
- 正文指令具体、可操作，用祈使句
- 写明触发条件、审查/分析维度、输出格式
- 根据 profile 用途定制，不用通用空话

### 第 5 步：写入文件

将生成的 agent 文件写入 `<profile-root>/claude-home/agents/<agent-name>.md`

## 决策检查清单

生成 agent 前，逐条确认：

- [ ] 模型：默认 sonnet，安全审计/复杂推理用 opus，轻量只读用 haiku
- [ ] 工具：默认只读包 (Read, Grep, Glob)，按需逐层升级
- [ ] maxTurns：包含写入工具的 agent 必须设置 maxTurns
- [ ] description：写清触发条件，让主会话能准确判断何时委派
- [ ] 正文：具体指令，不是泛泛的角色描述
- [ ] 是否需要预加载 skills
- [ ] 存放位置：需要 hooks/mcpServers 的放用户目录，否则均可
