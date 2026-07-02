---
name: ccps-configure-settings
description: >
  子 Skill：为 ccps profile 配置 settings.json 和 launch 配置。
  由主 Skill ccps-create-profile 在阶段 7 中读取和使用。
---

# Profile Settings 配置指南

你为 ccps profile 配置 `settings.json`（Claude Code 用户级设置）和 `profile.json` 的启动配置（ccps 启动抽象）。

两者职责不同：
- **settings.json** — Claude Code 原生配置，控制模型行为、环境变量、权限、hooks 等。
- **profile.json `launch` 字段** — ccps 自有的启动层抽象，控制如何把 Claude Code 拉起来（传哪些 CLI flag、MCP 合并策略、是否跳过权限确认等）。

---

## 一、settings.json 高频字段

settings.json 放在 `<profile>/claude-home/settings.json`，通过 `CLAUDE_CONFIG_DIR` 指向该目录后由 Claude Code 原生读取。

### 完整字段参考

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `model` | string | Claude Code 内置默认 | 指定默认使用的模型 ID，如 `"claude-sonnet-4-6"` |
| `env` | object | `{}` | 注入到 Claude Code 进程的环境变量键值对。**值必须是字符串** |
| `permissions` | object | — | 细粒度权限规则（allow/deny 命令或工具） |
| `hooks` | object | — | 事件钩子（PreToolUse / PostToolUse / Notification 等），用于自动化拦截或补充 |
| `language` | string | — | Claude 回复使用的语言偏好，如 `"zh"` / `"en"` |
| `outputStyle` | string | — | 输出风格偏好 |
| `verbose` | boolean | `false` | 是否输出详细调试日志 |
| `theme` | string | — | CLI 主题（`"dark"` / `"light"` 等） |
| `teammateMode` | boolean | `false` | 团队协作模式 |
| `autoMemoryEnabled` | boolean | `true` | 是否启用自动记忆（Claude 自己写 learnings） |
| `respectGitignore` | boolean | — | 是否遵守 `.gitignore` 规则过滤文件 |
| `includeGitInstructions` | boolean | — | 是否在上下文中注入 git 状态信息 |
| `skillListingBudgetFraction` | number | — | Skill 列表在 context window 中占比上限 |
| `skillListingMaxDescChars` | number | — | 单个 skill 描述的最大字符数 |
| `pluginSuggestionMarketplaces` | array | — | 插件推荐来源 |
| `strictPluginOnlyCustomization` | boolean | — | 严格限制插件自定义范围 |

**ccps 管控的字段：**
- `autoMemoryDirectory` — 由 ccps 自动设置为 `<profile>/claude-home/memory/auto`，不要手动修改。
- `env.CLAUDE_CODE_ATTRIBUTION_HEADER` — ccps 初始化时自动设为 `"0"`，不要删除。

### settings.json 完整模板

```json
{
  "model": "claude-sonnet-4-6",
  "autoMemoryDirectory": "<profile>/claude-home/memory/auto",
  "autoMemoryEnabled": true,
  "language": "zh",
  "verbose": false,
  "respectGitignore": true,
  "includeGitInstructions": true,
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_MAX_TURNS": "50"
  },
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(npx *)",
      "Bash(git *)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force *)"
    ]
  }
}
```

---

## 二、环境变量分类

环境变量通过 `settings.json` 的 `env` 字段注入。按用途分三类：

### Provider 类 — API 密钥 / 路由

控制 Claude Code 连接哪个后端、用什么凭证。**ccps 不负责设置这些**——它们通过 `api-settings.json` 或真实 `~/.claude/settings.json` 的 `env.ANTHROPIC_*` 键自动合并。

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | 直接 API 密钥 |
| `ANTHROPIC_AUTH_TOKEN` | OAuth token（用于企业/组织认证） |
| `ANTHROPIC_MODEL` | 覆盖默认模型（优先级低于 settings.json `model` 字段） |
| `ANTHROPIC_SMALL_FAST_MODEL` | 轻量快速模型 ID |
| `ANTHROPIC_BASE_URL` | API base URL（自建代理 / OpenRouter 等） |
| `ANTHROPIC_VERTEX_PROJECT` | Google Vertex AI 项目 ID |
| `ANTHROPIC_VERTEX_REGION` | Google Vertex AI 区域 |
| `ANTHROPIC_BEDROCK_*` | AWS Bedrock 相关配置 |
| `ANTHROPIC_FOUNDRY_*` | Anthropic Foundry 相关配置 |

> **注意**：`ANTHROPIC_*` 系列键在 `ccps init` 时会从真实 `~/.claude/settings.json` 自动导入到 `api-settings.json`。profile 创建阶段不需要手动设置。

### Behavior 类 — 行为控制

控制 Claude Code 运行时行为，不涉及认证。

| 变量 | 用途 | 推荐值 |
|---|---|---|
| `CLAUDE_CODE_MAX_TURNS` | 单次会话最大轮数上限 | `"50"` / `"100"` / `"200"` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆（`"1"` = 禁用） | 通常不设，用 settings.json `autoMemoryEnabled` 代替 |
| `CLAUDE_CODE_MCP_ALLOWLIST_ENV` | MCP 服务器允许访问的宿主环境变量白名单 | 按需设置 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | 禁用归因头 | `"0"`（ccps 自动设置） |
| `EDITOR` | 默认编辑器命令 | `"code"` / `"vim"` 等 |

### Integration 类 — 集成配置

控制 Claude Code 的配置目录和集成点。

| 变量 | 用途 |
|---|---|
| `CLAUDE_CONFIG_DIR` | 覆盖 Claude Code 配置根目录（默认 `~/.claude`） |

---

## 三、CLAUDE_CONFIG_DIR 原理详解

`CLAUDE_CONFIG_DIR` 是 ccps 的**核心技术杠杆**。

### 工作机制

1. Claude Code 启动时检查 `CLAUDE_CONFIG_DIR` 环境变量。
2. 如果存在，所有用户级配置读写都重定向到该目录，而不是默认的 `~/.claude`。
3. 该目录下存放：settings、credentials、session history、plugins、agents、skills、projects 等。
4. ccps 为每个 profile 设置独立的 `claude-home` 目录作为 `CLAUDE_CONFIG_DIR`，实现"同一台机器上并行隔离多个配置"。

### ccps 的使用方式

```ts
// launcher.ts 核心逻辑
spawn('claude', args, {
  cwd,
  env: {
    ...process.env,        // 继承宿主环境
    ...realClaudeEnv,       // 合并真实 ~/.claude/settings.json 中的 env.ANTHROPIC_*
    ...apiEnv,              // 合并 api-settings.json 中的公共 API 键
    CLAUDE_CONFIG_DIR: profileClaudeHome,  // 覆盖配置目录
  },
});
```

### 关键约束

- **项目级配置不受影响**：项目 `.claude/settings.json`、`.claude/CLAUDE.md`、`.mcp.json` 等仍然从 launch 时的 cwd 加载。
- **不碰真实 `~/.claude`**：ccps 永远不会读写用户真实的 Claude 配置目录（唯一的例外是 `ccps init` 时读取 `env.ANTHROPIC_*` 键做一次性导入）。

---

## 四、profile.json launch 配置与官方概念映射

profile.json 的 `launch` 字段是 **ccps 自有抽象**，不是 Claude Code 官方配置。以下是映射关系：

| ccps launch 字段 | 类型 | 默认值 | 官方对应概念 | 说明 |
|---|---|---|---|---|
| `mcpMode` | string | `"merge"` | CLI flag `--mcp-config` / `--strict-mcp-config` | `"merge"` = 加载 mcp.json 但允许项目覆盖；`"strict"` = 追加 `--strict-mcp-config`；`"none"` = 不加载 |
| `pluginDirs` | string[] | `[]` | CLI flag `--plugin-dir` | 每个路径映射为一个 `--plugin-dir <path>` 参数 |
| `disableAutoMemory` | boolean | `false` | settings.json `autoMemoryEnabled` | **映射关系见下方详述** |
| `skipPermissions` | boolean | `true` | CLI flag `--dangerously-skip-permissions` | `true` = 自动追加该 flag；`false` = 不追加。等价于官方 permissionMode 中的 bypassPermissions 语义 |
| `claudeArgs` | string[] | `[]` | 直接透传的 CLI 参数 | 数组中每个元素原样追加到 `claude` 命令行。可以放 `--model`、`--max-turns`、`--verbose` 等任意合法 flag |

### disableAutoMemory 与 autoMemoryEnabled 的映射关系

这两个字段控制同一件事，但分属不同层：

| 层 | 字段 | 默认值 | 行为 |
|---|---|---|---|
| **Claude Code 官方** | `settings.json` `autoMemoryEnabled` | `true` | `false` = Claude 不会自动写 learnings 到 memory 目录 |
| **ccps 启动抽象** | `profile.json` `launch.disableAutoMemory` | `false` | `true` = ccps 在启动时设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 环境变量 |

**实际效果**：两者最终都控制"是否禁用自动记忆"，但作用路径不同：
- 修改 `autoMemoryEnabled` 是直接改 Claude Code 原生设置。
- 设置 `disableAutoMemory: true` 是通过环境变量间接禁用，不修改 settings.json。

**建议**：如果需要禁用自动记忆，优先使用 `settings.json` 的 `autoMemoryEnabled: false`，更直接、更官方。

---

## 五、工作流预设配置

以下是 4 种常见工作流的推荐 settings + launch 配置。直接复制后按需微调即可。

### 1. Coding（日常开发）

```json
// settings.json
{
  "autoMemoryDirectory": "<profile>/claude-home/memory/auto",
  "model": "claude-sonnet-4-6",
  "autoMemoryEnabled": true,
  "respectGitignore": true,
  "includeGitInstructions": true,
  "language": "zh",
  "skillListingBudgetFraction": 0.15,
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_MAX_TURNS": "100"
  },
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(npx *)",
      "Bash(git *)",
      "Bash(node *)",
      "Bash(pnpm *)",
      "Bash(yarn *)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force *)"
    ]
  }
}
```

```json
// profile.json launch 部分
{
  "launch": {
    "mcpMode": "merge",
    "pluginDirs": [],
    "disableAutoMemory": false,
    "skipPermissions": true,
    "claudeArgs": []
  }
}
```

**设计理由**：coding 场景操作文件频繁，`skipPermissions: true` 避免反复确认打断心流；`includeGitInstructions: true` 让 Claude 感知 git 上下文；适当提高 `skillListingBudgetFraction` 让更多技能可见。

### 2. Writing（写作 / 文档）

```json
// settings.json
{
  "autoMemoryDirectory": "<profile>/claude-home/memory/auto",
  "model": "claude-sonnet-4-6",
  "autoMemoryEnabled": true,
  "language": "zh",
  "outputStyle": "concise",
  "respectGitignore": false,
  "includeGitInstructions": false,
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_MAX_TURNS": "50",
    "EDITOR": "code"
  },
  "permissions": {
    "allow": [
      "Read",
      "Write"
    ],
    "deny": [
      "Bash(rm *)",
      "Bash(git push *)"
    ]
  }
}
```

```json
// profile.json launch 部分
{
  "launch": {
    "mcpMode": "merge",
    "pluginDirs": [],
    "disableAutoMemory": false,
    "skipPermissions": false,
    "claudeArgs": []
  }
}
```

**设计理由**：写作场景不需要 git 上下文注入，关闭 `includeGitInstructions` 和 `respectGitignore` 减少噪音；`skipPermissions: false` 保持文件操作确认，防止误写项目代码；`outputStyle` 控制回复风格。

### 3. Research（研究 / 信息检索）

```json
// settings.json
{
  "autoMemoryDirectory": "<profile>/claude-home/memory/auto",
  "model": "claude-sonnet-4-6",
  "autoMemoryEnabled": true,
  "language": "zh",
  "respectGitignore": true,
  "includeGitInstructions": false,
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_MAX_TURNS": "200"
  },
  "permissions": {
    "allow": [
      "Read",
      "WebFetch",
      "WebSearch",
      "Bash(curl *)"
    ],
    "deny": [
      "Write",
      "Bash(rm *)"
    ]
  }
}
```

```json
// profile.json launch 部分
{
  "launch": {
    "mcpMode": "merge",
    "pluginDirs": [],
    "disableAutoMemory": false,
    "skipPermissions": false,
    "claudeArgs": ["--model", "claude-opus-4-20250514"]
  }
}
```

**设计理由**：研究场景需要大量 web fetch 和搜索，明确允许 `WebFetch` / `WebSearch`；限制写入型工具避免意外修改文件；可用 opus 做复杂检索汇总（通过 `claudeArgs` 覆盖模型）；提高 `MAX_TURNS` 应对长链检索任务。

### 4. Study（学习 / 教学）

```json
// settings.json
{
  "autoMemoryDirectory": "<profile>/claude-home/memory/auto",
  "model": "claude-sonnet-4-6",
  "autoMemoryEnabled": true,
  "language": "zh",
  "outputStyle": "explanatory",
  "verbose": true,
  "respectGitignore": true,
  "includeGitInstructions": true,
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_MAX_TURNS": "50"
  },
  "permissions": {
    "allow": [
      "Read",
      "Bash(npm run test *)",
      "Bash(npm run build *)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(git push *)"
    ]
  }
}
```

```json
// profile.json launch 部分
{
  "launch": {
    "mcpMode": "merge",
    "pluginDirs": [],
    "disableAutoMemory": false,
    "skipPermissions": false,
    "claudeArgs": []
  }
}
```

**设计理由**：学习场景需要详细解释，`verbose: true` 输出更多调试信息帮助理解过程；`outputStyle: "explanatory"` 引导 Claude 给出解释型回答；`skipPermissions: false` 让每次操作有确认反馈，培养安全习惯；只允许跑 test 和 build，不允许写文件。

---

## 六、配置流程

### 第 1 步：询问需求

"需要配置额外的环境变量、模型偏好或权限规则吗？"

用户可能的回答及你的应对：
- "不需要" / "默认就行" → 跳过，使用模板默认值
- "我是做 xxx 的" → 参考上方工作流预设，推荐对应模板
- 具体需求 → 按需求逐项配置

### 第 2 步：更新 settings.json

用 Edit 工具将配置合并到 `<profile>/claude-home/settings.json`。

**必须保留的字段：**
- `autoMemoryDirectory` — ccps 自动设置的值
- `env.CLAUDE_CODE_ATTRIBUTION_HEADER: "0"` — ccps 自动设置

**合并策略：** 增量合并，不覆盖已有字段。如果用户要改已有值（如 `model`），直接覆盖该字段即可。

### 第 3 步：更新 profile.json launch 配置

如果需要调整启动行为（skipPermissions、claudeArgs、mcpMode 等），用 Edit 工具更新 `<profile>/profile.json` 的 `launch` 字段。

### 第 4 步：确认

向用户展示最终配置的关键项：
- 使用的模型
- 权限策略（allow/deny 摘要）
- 启动行为（skipPermissions、mcpMode）
- 自定义环境变量（列出键名，不展示值）

---

## 七、重要约束

- 不修改 `autoMemoryDirectory` 的值
- 不删除 `env.CLAUDE_CODE_ATTRIBUTION_HEADER: "0"`
- 不在 settings.json 的 `env` 中写入 API keys 或 secrets（这些由 `api-settings.json` 和 `ccps init` 的导入机制管理）
- 环境变量值必须是字符串类型（数字要写成 `"100"` 而非 `100`）
- `claudeArgs` 中的参数必须是 Claude Code CLI 支持的合法 flag
- 不使用 `--strict-mcp-config` 作为默认 mcpMode（除非用户明确要求严格隔离）
