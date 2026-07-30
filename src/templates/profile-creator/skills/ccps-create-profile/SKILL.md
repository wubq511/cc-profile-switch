---
name: ccps-create-profile
description: >
  Create a new ccps (cc-profile-switch) profile — a complete Claude Code environment
  with CLAUDE.md, skills, agents, native user-scope MCP config, and settings. TRIGGER on: "create/set up/build
  a profile for X", "I need a profile for", "新建 profile", "帮我创建一个 profile",
  "配一个专用的 Claude 环境", "make me a coding/writing/research profile", even without
  "ccps" explicitly mentioned. Also trigger for customizing an existing profile's CLAUDE.md
  or adding skills/agents to it. DO NOT trigger for: writing project-level CLAUDE.md,
  MCP configuration questions, listing/viewing existing profiles, creating Skills,
  debugging profile validation, ccps command usage help, or general Claude Code setup.
---

# CCPS Profile Creator — 主 Skill

你帮助用户创建一个**完成度高、配置全面**的 ccps (cc-profile-switch) profile。

一个 ccps profile 不只是 CLAUDE.md。完整的 profile 包含：

- **CLAUDE.md** — 用户级指令（核心）
- **skills/** — Profile 专属技能
- **agents/** — Profile 专属子代理
- **rules/ccps-profile.md** — ccps 托管的 profile 边界规则
- **Claude user-scope MCP** — 由 `claude mcp --scope user` 管理，状态位于 `claude-home/.claude.json`
- **settings.json** — 环境变量和其他设置
- **profile.json** — 启动配置（skipPermissions, claudeArgs；mcpMode 仅兼容旧 profile）

你的目标是根据用户需求，配置**所有这些组件**，而不是只写一个 CLAUDE.md。

## 完整工作流程

### 阶段 1：理解需求

如果用户已经描述了用途（如"帮我创建一个写技术博客的 profile"），直接进入阶段 2。
否则问 2-3 个问题：

1. 这个 profile 主要做什么？
2. 有没有特定的工具/集成需求？
3. 权限偏好（是否跳过确认提示）？

### 阶段 2：创建 Profile 骨架

```bash
ccps create <name> --template <template>
```

模板选择指南：`coding`/`study`/`work`/`research`/`general`/`blank`。
模板只影响 profile.json 元数据，不影响后续配置。

### 阶段 3：生成 CLAUDE.md

这是最重要的文件。根据用户需求生成高质量的 CLAUDE.md。

**结构要求：**

```markdown
# <Profile Name> Profile

## Identity & Role

## Workflow

## Conventions

## Tools & Context

## Constraints
```

**质量要求：**

- 解释 WHY，不只是 WHAT。"用短段落因为读者在手机上扫读"优于"用短段落"
- 写操作性语句，不写模糊要求。"提交前运行 `pytest`"优于"测试你的改动"
- 每个技术栈都要有具体的代码规范、目录结构、命名约定
- CLAUDE.md 至少 100 行。低于 100 行说明内容太抽象，需要补充具体规则
- 用祈使句
- 用用户偏好的语言
- 涵盖：项目结构模板、编码规范、常用命令、工作流步骤、禁忌事项
- 对于 coding profile：必须包含项目目录结构、代码风格、测试规范、Git 提交规范
- 对于 writing profile：必须包含写作风格、审校清单、输出格式规范
- 对于 research profile：必须包含研究方法论、分析框架、引用规范、输出结构

用 Write 工具将生成的 CLAUDE.md 写入 `<profile>/claude-home/CLAUDE.md`。

### 阶段 4：配置 Skills（推荐）

**询问用户：** "需要为这个 profile 配置专属技能吗？"

除非用户明确拒绝，否则**推荐配置**。skills 是 profile 高完成度的关键组件。

如果用户同意，读取子 Skill：

```
Read: <skill-path>/sub-skills/ccps-find-skills.md
```

然后按子 Skill 的指引操作。简要流程：

1. 使用 `npx skills find` 搜索 skills.sh 生态中的高质量 skills
2. 验证质量（安装量、来源信誉、GitHub stars）
3. 推荐给用户（1-3 个），用户确认后安装到 profile
4. 安装命令：`CLAUDE_CONFIG_DIR=<profile>/claude-home npx skills add <source> -a claude-code -y`

### 阶段 5：配置 Agents（推荐）

**询问用户：** "需要为这个 profile 配置专属子代理吗？"

除非用户明确拒绝，否则**推荐配置**。agents 提供隔离执行和专项能力。

如果用户同意，读取子 Skill：

```
Read: <skill-path>/sub-skills/ccps-configure-agents.md
```

简要流程：

1. 根据用途推荐合适的 agents（1-2 个）
2. 生成 agent markdown 文件，包含完整的 frontmatter（name, description, model, tools, maxTurns, color 等）
3. 写入 `<profile>/claude-home/agents/<agent-name>.md`

### 阶段 6：配置 MCP 服务器（按需）

**询问用户：** "需要配置 MCP 服务器吗？（如数据库、API 集成、浏览器自动化等）"

如果用户同意，读取子 Skill：

```
Read: <skill-path>/sub-skills/ccps-configure-mcp.md
```

简要流程：

1. 根据用户的技术栈推荐 MCP 服务器
2. 用户确认后，用目标 profile 的 `CLAUDE_CONFIG_DIR` 运行 `claude mcp add --scope user`
3. 用同一 `CLAUDE_CONFIG_DIR` 运行 `claude mcp list/get` 验证

### 阶段 7：配置 Settings（推荐）

**询问用户：** "需要配置环境变量或其他设置吗？"

如果用户需要，读取子 Skill：

```
Read: <skill-path>/sub-skills/ccps-configure-settings.md
```

简要流程：

1. 根据用户需求添加 env 变量到 settings.json
2. 调整 launch 配置（skipPermissions, claudeArgs 等）
3. **skipPermissions 默认策略**：所有 profile 默认设为 `true`。ccps 用户已经通过 profile 隔离做了权限边界，再加确认提示会打断工作流。如果用户明确要求某类 profile 保持确认，才设为 `false`

### 阶段 8：验证并展示结果

```bash
ccps validate <name>
ccps show <name>
```

展示给用户：

- Profile 名称和模板
- CLAUDE.md 的关键章节
- 已安装的 skills、agents
- 原生 user-scope MCP 服务器配置
- 启动命令：`ccps launch <name>` 或 `ccps launch <name> --dry-run`

## 重要约束

- 不读写真实的 `~/.claude` 目录或真实的 `~/.claude.json`
- 不直接编辑 `<profile>/claude-home/.claude.json`；必须通过 `claude mcp` 管理
- 不把 profile MCP 写入 `settings.json.mcpServers`、`<profile>/mcp.json` 或 `claude-home/.mcp.json`
- 不设置 API 密钥或 secrets
- 不添加用户未请求的 MCP 服务器
- Profile 名称必须是文件系统安全的：`[A-Za-z0-9][A-Za-z0-9_-]*`
- 子 Skill 文件位于 `<this-skill-dir>/sub-skills/` 目录下
