# Technical Design Document: CC-Profile-Switch MVP

## 0. 文档信息

| 项目 | 内容 |
|---|---|
| 产品名称 | CC-Profile-Switch |
| CLI 命令 | `ccps` |
| 文档类型 | MVP 技术设计文档 |
| 目标用户 | Vibe-coder：AI 写全部代码，用户负责指导、测试、验收 |
| 使用平台 | Windows 本地 CLI |
| 技术形态 | Node.js CLI |
| 推荐语言 | TypeScript |
| MVP 是否包含 TUI | 不包含 |
| MVP 是否包含 GUI | 不包含 |
| 产品是否内置 AI | 不内置 |
| 预算 | Free only |
| 时间节奏 | 不着急，以稳定、安全、可维护为主 |
| 关键变更 | 默认不再使用 Runtime Project Isolation；改为 Global User Config Switch Mode |

---

## 1. Verification Echo

这是本技术设计基于当前已确认信息生成的版本。

### 1.1 Project

```text
CC-Profile-Switch
```

一个 Windows 本地 Claude Code 场景配置切换工具，用于为 `coding / study / work / research / general` 等不同使用场景维护独立 profile，并通过 CLI 启动 Claude Code。

### 1.2 Platform

```text
Windows 本地 CLI
```

不是 Web，不是 Mobile，不是 GUI 桌面应用。

运行环境：

```text
Windows
PowerShell / Windows Terminal
Node.js CLI
```

### 1.3 Tech Approach

```text
AI writes all code
```

用户负责：

```text
指导
测试
验收
发现问题后反馈给 Codex / Claude Code 修改
```

### 1.4 Key Technical Decisions

| 项目 | 决策 |
|---|---|
| Frontend | 无前端；MVP 不做 GUI / TUI |
| Backend | 无后端；本地 CLI 工具 |
| Database | 无数据库；使用本地文件系统 |
| Language | TypeScript |
| Runtime | Node.js LTS |
| CLI Framework | Commander |
| Main command | `ccps` |
| Profile root | `%USERPROFILE%\.cc-profile-switch` |
| Default launch mode | Global User Config Switch Mode |
| Project config behavior | 保留当前项目配置，不覆盖、不隔离、不修改 |
| Global config behavior | 通过 `CLAUDE_CONFIG_DIR` 切换用户级 `~/.claude` 来源 |
| MCP behavior | 默认尽量保留项目 MCP；profile MCP 以 merge/additive 方式加载，strict 仅作为可选模式 |
| Auth/session behavior | 不复制、不迁移、不管理 OAuth/session/token/history/cache |
| Product AI | 工具本身不调用 AI，不内置模型功能 |

### 1.5 Main Concern

用户最担心：

```text
Security/data problems
Making wrong tech choices
```

所以本技术设计优先保证：

```text
不污染真实 C:\Users\h\.claude
不破坏项目 .claude
不迁移敏感状态
启动行为可 dry-run
配置来源可验证
```

---

## 2. How We'll Build It

## 2.1 Recommended Approach: Global User Config Switch Mode

### Primary Recommendation

使用 **Node.js + TypeScript + Commander** 构建一个 Windows-only CLI。

核心启动方式：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

工具内部做：

```text
1. 读取当前工作目录：D:\Projects\my-app
2. 读取 profile：%USERPROFILE%\.cc-profile-switch\profiles\coding
3. 设置环境变量：
   CLAUDE_CONFIG_DIR=%USERPROFILE%\.cc-profile-switch\profiles\coding\claude-home
4. 默认 profile settings env 包含 CLAUDE_CODE_ATTRIBUTION_HEADER=0
5. 从当前工作目录启动 claude
6. 项目级配置继续按 Claude Code 原生规则加载
7. 用户级全局配置改为来自 coding profile
```

也就是说：

```text
项目配置：保留
全局配置：切换
```

### 为什么它适合你

1. **符合真实使用习惯**

   你可以在任意项目目录里使用：

   ```powershell
   cd D:\Projects\some-project
   ccps launch coding
   ```

   不需要先进入 `%USERPROFILE%\.cc-profile-switch`。

2. **不破坏项目级配置**

   项目里的这些配置继续生效：

   ```text
   D:\Projects\some-project\CLAUDE.md
   D:\Projects\some-project\.claude\settings.json
   D:\Projects\some-project\.claude\settings.local.json
   D:\Projects\some-project\.claude\agents\
   D:\Projects\some-project\.claude\skills\
   D:\Projects\some-project\.mcp.json
   ```

3. **只切换用户级全局配置**

   通过 `CLAUDE_CONFIG_DIR`，把 Claude Code 原本会读取的用户级 `~/.claude` 指向当前 profile 的 `claude-home`。

4. **避免直接修改真实全局目录**

   工具不会覆盖：

   ```text
   C:\Users\h\.claude
   ```

5. **适合 Vibe-coder 开发**

   结构清晰，适合后续交给 Codex / Claude Code 实现和维护。

### What it costs

```text
0 元
```

不需要：

```text
服务器
数据库
云服务
API key
SaaS 后端
```

### Time to learn

对用户来说：

```text
1-2 小时理解核心命令
半天熟悉 profile 目录结构
```

对 AI 开发来说：

```text
先实现 init/list/create/show/edit/validate/backup
再实现 launch --dry-run
最后实现真实 launch、API env、memory/plugin 位置验证
```

### Limitations to know

必须注意：

1. `CLAUDE_CONFIG_DIR` 下 OAuth/keychain 风格认证呈现为 profile 特有；API 用户应使用 common/profile env 配置。
2. profile 内的 `claude-home` 不能直接复制真实 `.claude` 整个目录。
3. 如果 Claude Code 将某些状态保存在 `~/.claude.json`，本工具不主动迁移。
4. MCP 的 merge/strict 行为已在 Claude Code `2.1.143` 验证；未来 Claude Code 版本变化时需复验。
5. Managed policy 级配置无法被本工具覆盖。

---

## 3. Alternative Options Compared

| Option | Pros | Cons | Cost | Time to MVP | Recommendation |
|---|---|---|---|---|---|
| Global User Config Switch Mode | 符合用户真实需求；保留项目配置；只切换全局配置；用户可在项目目录直接运行 | 需要验证 `CLAUDE_CONFIG_DIR` 与 auth/MCP 的实际行为 | Free | 中等 | **MVP 主方案** |
| Runtime Project Isolation | 隔离最强；不会加载项目配置污染 profile | 不符合当前需求；用户不能自然地在项目目录使用；项目配置被绕开 | Free | 中等偏高 | 不作为默认方案 |
| Direct Copy/Swap `C:\Users\h\.claude` | 看起来最直观；实现简单 | 极高风险；可能破坏登录、history、cache、OAuth/session；不适合开源 | Free | 快 | **禁止** |
| PowerShell-only Launcher | 实现最快；Windows 原生 | 工程化弱；测试差；开源维护困难 | Free | 快 | 只作为辅助思路 |
| GUI/TUI Config Manager | 体验可能更友好 | 超出 MVP；增加复杂度；不符合当前要求 | Free/不确定 | 慢 | 不做 |

---

## 4. Core Architecture

## 4.1 High-Level Architecture

```text
User
 ↓
PowerShell / Windows Terminal
 ↓
ccps CLI
 ↓
Command Layer
 ↓
Core Services
 ↓
Profile File System
 ↓
Launch Plan
 ↓
Claude Code process
```

## 4.2 Default Launch Architecture

```text
当前项目目录
D:\Projects\my-app
  CLAUDE.md
  .claude\
    settings.json
    settings.local.json
    agents\
    skills\
  .mcp.json

用户选择 profile
%USERPROFILE%\.cc-profile-switch\profiles\coding
  profile.json
  claude-home\
    CLAUDE.md
    settings.json
    memory\
      auto\
        MEMORY.md
    agents\
    skills\
    plugins\
  mcp.json

ccps launch coding

spawn:
  cwd = D:\Projects\my-app
  env.CLAUDE_CONFIG_DIR = %USERPROFILE%\.cc-profile-switch\profiles\coding\claude-home
  env includes API keys from common api-settings.json and profile settings.json env
  args = --dangerously-skip-permissions plus profile launch args
```

## 4.3 What Should Load

默认期望：

| 来源 | 是否加载 | 说明 |
|---|---:|---|
| 当前项目 `CLAUDE.md` | 是 | 项目级配置应继续生效 |
| 当前项目 `.claude/CLAUDE.md` | 是 | 项目级配置应继续生效 |
| 当前项目 `.claude/settings.json` | 是 | 项目级配置应继续生效 |
| 当前项目 `.claude/settings.local.json` | 是 | 用户在该项目的本地设置应继续生效 |
| 当前项目 `.claude/agents` | 是 | 项目级 agents 应继续生效 |
| 当前项目 `.claude/skills` | 是 | 项目级 skills 应继续生效 |
| 当前项目 `.mcp.json` | 是，需验证 | 不应被默认 strict MCP 屏蔽 |
| 真实 `C:\Users\h\.claude\CLAUDE.md` | 否 | 应由 profile 的 `claude-home\CLAUDE.md` 替代 |
| 真实 `C:\Users\h\.claude\settings.json` | 否 | 应由 profile 的 `claude-home\settings.json` 替代 |
| 真实 `C:\Users\h\.claude\agents` | 否 | 应由 profile 的 `claude-home\agents` 替代 |
| 真实 `C:\Users\h\.claude\skills` | 否 | 应由 profile 的 `claude-home\skills` 替代 |
| profile `claude-home\CLAUDE.md` | 是 | 作为当前场景的用户级全局 instructions |
| profile `claude-home\settings.json` | 是 | 作为当前场景的用户级 settings |
| profile `claude-home\agents` | 是 | 作为当前场景的用户级 agents |
| profile `claude-home\skills` | 是 | 作为当前场景的用户级 skills |
| profile `claude-home\memory\auto` | 是 | 作为当前场景的 auto memory 写入位置 |
| profile `claude-home\plugins` | 是 | Claude Code 自己安装/管理的用户级 plugins |
| profile `mcp.json` | 是，默认 merge/additive | 作为当前场景的全局 MCP 候选配置 |
| profile `launch.pluginDirs` | 可选 | 额外 `--plugin-dir`，路径相对 `claude-home` 解析 |

---

## 5. Profile Data Structure

## 5.1 User Data Root

默认目录：

```text
%USERPROFILE%\.cc-profile-switch\
```

示例：

```text
C:\Users\h\.cc-profile-switch\
```

## 5.2 Final Profile Structure

```text
.cc-profile-switch\
  config.json
  api-settings.json

  profiles\
    coding\
      profile.json

      claude-home\
        CLAUDE.md
        settings.json
        memory\
          auto\
            MEMORY.md
        skills\
        agents\
        plugins\

      mcp.json

    study\
      profile.json
      claude-home\
        CLAUDE.md
        settings.json
        memory\
          auto\
            MEMORY.md
        skills\
        agents\
        plugins\
      mcp.json

    work\
    research\
    general\

  backups\
```

## 5.3 Why Add `claude-home\`

旧版结构把文件平铺在 profile 目录：

```text
profiles\coding\
  CLAUDE.md
  settings.json
  skills\
  agents\
  mcp.json
  plugins\
```

新版改成：

```text
profiles\coding\
  claude-home\
    CLAUDE.md
    settings.json
    memory\
      auto\
        MEMORY.md
    skills\
    agents\
    plugins\
  mcp.json
```

原因：

1. `claude-home` 语义更准确：它模拟的是用户级 `~/.claude`。
2. 可以直接作为 `CLAUDE_CONFIG_DIR` 的目标。
3. 避免把 profile 管理元数据和 Claude Code 用户级配置混在一起。
4. 不需要生成 runtime project 来伪装项目目录。
5. 更符合“只切换全局配置，不动项目配置”的目标。

## 5.4 `config.json`

位置：

```text
%USERPROFILE%\.cc-profile-switch\config.json
```

建议 schema：

```ts
type AppConfig = {
  version: string
  profilesDir: string
  backupsDir: string
  defaultProfile: string
  editor: string
  lastUsedProfile: string
  createdAt: string
  updatedAt: string
}
```

示例：

```json
{
  "version": "0.1.0",
  "profilesDir": "C:\\Users\\h\\.cc-profile-switch\\profiles",
  "backupsDir": "C:\\Users\\h\\.cc-profile-switch\\backups",
  "defaultProfile": "general",
  "editor": "",
  "lastUsedProfile": "",
  "createdAt": "2026-05-16T00:00:00.000Z",
  "updatedAt": "2026-05-16T00:00:00.000Z"
}
```

## 5.5 `profile.json`

位置：

```text
profiles\<name>\profile.json
```

建议 schema：

```ts
type ProfileManifest = {
  name: string
  description: string
  template: 'coding' | 'study' | 'work' | 'research' | 'general' | 'blank' | string
  version: string
  createdAt: string
  updatedAt: string
  launch: {
    mcpMode: 'merge' | 'strict' | 'off'
    pluginDirs: string[]
    disableAutoMemory: boolean
    skipPermissions: boolean
    claudeArgs: string[]
  }
}
```

示例：

```json
{
  "name": "coding",
  "description": "Coding assistant global profile for Claude Code",
  "template": "coding",
  "version": "0.1.0",
  "createdAt": "2026-05-16T00:00:00.000Z",
  "updatedAt": "2026-05-16T00:00:00.000Z",
  "launch": {
    "mcpMode": "merge",
    "pluginDirs": [],
    "disableAutoMemory": false,
    "skipPermissions": true,
    "claudeArgs": []
  }
}
```

## 5.6 `claude-home\CLAUDE.md`

作用：

```text
当前 profile 的用户级全局说明
```

例如：

```text
profiles\coding\claude-home\CLAUDE.md
```

对应默认 Claude Code 用户级位置：

```text
%USERPROFILE%\.claude\CLAUDE.md
```

但启动时不改真实 `.claude`，而是：

```text
CLAUDE_CONFIG_DIR=profiles\coding\claude-home
```

## 5.7 `claude-home\settings.json`

作用：

```text
当前 profile 的用户级 settings
```

对应默认 Claude Code 用户级位置：

```text
%USERPROFILE%\.claude\settings.json
```

MVP 只校验：

```text
合法 JSON
必须是 object
```

默认模板会写入：

```json
{
  "autoMemoryDirectory": "%USERPROFILE%\\.cc-profile-switch\\profiles\\<name>\\claude-home\\memory\\auto",
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

重复执行 `ccps init` 时，已存在的默认 profile 如果缺少 `CLAUDE_CODE_ATTRIBUTION_HEADER`，会补齐该键，并保留原有 settings 字段和已有 env 键。

不复制完整 Claude Code settings schema。

## 5.8 `claude-home\skills\`

作用：

```text
当前 profile 的用户级 skills
```

对应默认 Claude Code 用户级位置：

```text
%USERPROFILE%\.claude\skills\
```

## 5.9 `claude-home\agents\`

作用：

```text
当前 profile 的用户级 agents / subagents
```

对应默认 Claude Code 用户级位置：

```text
%USERPROFILE%\.claude\agents\
```

## 5.10 `mcp.json`

作用：

```text
当前 profile 的 MCP 配置文件
```

注意：

MCP 的 merge/strict 行为已通过 Claude Code `2.1.143` 验证。MVP 默认不使用 `--strict-mcp-config`，因为 strict 会让项目级 `.mcp.json` 不再加载，不符合“项目配置继续生效”的目标。

## 5.11 `claude-home\plugins\`

作用：

```text
当前 profile 的 Claude Code 用户级 plugin 状态
```

Claude Code 自己安装和管理的 plugins 位于 `claude-home\plugins`。`launch.pluginDirs` 只表示额外传给当前 session 的 `--plugin-dir`，路径相对 `claude-home` 解析。

---

## 6. Project Setup Checklist

## Step 1: Install Required Tools

用户需要：

```text
Windows
PowerShell / Windows Terminal
Node.js LTS
npm
Claude Code CLI
Git
VS Code / Cursor / 任意编辑器
```

## Step 2: Initialize Repository

```bash
mkdir cc-profile-switch
cd cc-profile-switch
npm init -y
```

## Step 3: Install Dependencies

建议依赖：

```bash
npm install commander zod picocolors fs-extra
npm install -D typescript tsx tsup vitest eslint prettier @types/node @types/fs-extra
```

## Step 4: Initialize TypeScript

```bash
npx tsc --init
```

## Step 5: Create Source Structure

```text
src\
  index.ts
  commands\
  core\
  platform\
  schemas\
  templates\
  utils\
test\
```

## Step 6: First Build Target

第一阶段只实现：

```text
ccps --help
```

不要一开始写 launch。

---

## 7. Building Your Features

## Feature 1: `ccps init`

### Complexity

```text
Medium
```

### Goal

创建用户数据目录和默认 profiles。

### How to build

Prompt for AI:

```md
实现 `ccps init`。

要求：
- 只支持 Windows
- 默认根目录是 `%USERPROFILE%\.cc-profile-switch`
- 创建 config.json
- 创建 profiles/coding、profiles/study、profiles/work、profiles/research、profiles/general
- 每个 profile 使用新版结构：
  - profile.json
  - claude-home/CLAUDE.md
  - claude-home/settings.json
  - claude-home/skills/
  - claude-home/agents/
  - mcp.json
  - plugins/
- 重复执行不得覆盖用户已有文件
- 输出清晰的 next steps
```

### Files to create

```text
src/commands/init.ts
src/core/app-config.ts
src/core/profile-template.ts
src/platform/windows-path.ts
src/utils/logger.ts
```

### Test with

```bash
ccps init
ccps list
```

---

## Feature 2: `ccps list`

### Complexity

```text
Easy
```

### Goal

列出所有 profile，并展示基本状态。

### How to build

Prompt for AI:

```md
实现 `ccps list`。

要求：
- 读取 `%USERPROFILE%\.cc-profile-switch\profiles`
- 列出 profile name、description、status
- 如果未初始化，提示用户运行 `ccps init`
- 不抛出晦涩错误
```

### Files to create

```text
src/commands/list.ts
src/core/profile.ts
```

---

## Feature 3: `ccps create <name>`

### Complexity

```text
Medium
```

### Goal

从模板创建新 profile。

### How to build

Prompt for AI:

```md
实现 `ccps create <name> --template <template>`。

要求：
- profile name 只允许 a-z A-Z 0-9 - _
- 不允许覆盖已有 profile
- 默认 template 是 blank
- 支持 coding/study/work/research/general/blank
- 使用新版 claude-home 结构
```

---

## Feature 4: `ccps show <name>`

### Complexity

```text
Easy
```

### Goal

展示 profile 文件结构和状态。

### Output should include

```text
profile path
claude-home path
CLAUDE.md exists?
settings.json valid?
skills dir exists?
agents dir exists?
mcp.json valid?
plugins dir exists?
```

---

## Feature 5: `ccps edit <name> [file-or-folder]`

### Complexity

```text
Medium
```

### Goal

用新的 VS Code 窗口打开 profile 文件夹、常用配置文件，或 profile 内已有文件/文件夹。

### Built-in aliases

```text
profile.json
CLAUDE.md
settings.json
mcp.json
claude-home
memory
memory\auto
skills
agents
plugins
```

此外允许打开 selected profile 目录内已经存在的相对路径。路径必须留在 `profiles\<name>` 内，且 token/secret/credential/oauth 等敏感命名目标应被阻止。

### File mapping

| 用户输入 | 实际路径 |
|---|---|
| `CLAUDE.md` | `profiles\<name>\claude-home\CLAUDE.md` |
| `settings.json` | `profiles\<name>\claude-home\settings.json` |
| `mcp.json` | `profiles\<name>\mcp.json` |
| `profile.json` | `profiles\<name>\profile.json` |
| `claude-home` | `profiles\<name>\claude-home` |
| `skills` | `profiles\<name>\claude-home\skills` |
| 未指定 | `profiles\<name>` |
| profile 内已有相对路径 | 对应文件或文件夹 |

---

## Feature 6: `ccps validate <name>`

### Complexity

```text
Medium-Hard
```

### Goal

确认 profile 可用于启动。

### Checks

```text
profile exists
profile.json is valid
claude-home exists
claude-home/CLAUDE.md exists
claude-home/settings.json is valid JSON object
claude-home/memory exists
claude-home/memory/auto exists
claude-home/memory/auto/MEMORY.md exists
settings.json autoMemoryDirectory points to claude-home/memory/auto
claude-home/skills exists
claude-home/agents exists
claude-home/plugins exists
mcp.json is valid JSON object
no path traversal
```

### Sensitive files

Sensitive file names are not part of `ccps validate` launch readiness. They remain relevant to commands that open, export, import, package, or migrate profile contents.

高风险：

```text
token
secret
credential
credentials
oauth
```

中风险：

```text
.claude.json
session
sessions
history
cache
log
transcript
```

### Launch blocking errors

```text
missing profile
invalid profile.json
invalid settings.json
invalid mcp.json
missing CLAUDE.md
path traversal
```

---

## Feature 7: `ccps backup <name>`

### Complexity

```text
Easy-Medium
```

### Goal

备份整个 profile。

### Backup path

```text
%USERPROFILE%\.cc-profile-switch\backups\<profile>-YYYYMMDD-HHmmss\
```

### Must include

```text
profile.json
claude-home\
mcp.json
plugins\
```

---

## Feature 8: `ccps launch <name>`

### Complexity

```text
Hard
```

### Goal

从当前项目目录启动 Claude Code，并切换用户级全局配置。

### Correct user behavior

```powershell
cd D:\Projects\my-app
ccps launch coding
```

### Internal behavior

```text
cwd = process.cwd()
env.CLAUDE_CONFIG_DIR = profile.claudeHomePath
args = build from profile launch config
spawn claude from cwd
```

### Pseudocode

```ts
async function launchProfile(name: string, options: LaunchOptions) {
  const cwd = options.cwd ? resolveAbsolute(options.cwd) : process.cwd()
  const profile = await getProfile(name)

  const validation = await validateProfile(name)
  if (validation.level === 'error') {
    throw new CcpsError('PROFILE_INVALID', 'Fix validation errors before launch')
  }

  const plan = buildLaunchPlan({
    profile,
    cwd,
    dryRun: options.dryRun,
    debug: options.debug
  })

  if (options.dryRun) {
    printLaunchPlan(plan)
    return
  }

  await executeLaunchPlan(plan)
}
```

---

## 8. Claude Code Launch Strategy

## 8.1 Main Strategy: Global User Config Switch Mode

### Definition

```text
Global User Config Switch Mode =
在当前项目目录启动 Claude Code
保留项目级配置
通过 CLAUDE_CONFIG_DIR 切换用户级 ~/.claude 配置来源
```

### LaunchPlan

```ts
type LaunchPlan = {
  profileName: string
  profilePath: string
  claudeHomePath: string
  cwd: string
  command: 'claude'
  args: string[]
  env: Record<string, string>
  warnings: string[]
  mcpMode: 'merge' | 'strict' | 'off'
}
```

### Default env

```ts
env: {
  ...process.env,
  ...apiEnv,
  CLAUDE_CONFIG_DIR: profile.claudeHomePath
}
```

`apiEnv` 来自 common `api-settings.json` 与 profile `claude-home\settings.json` `env` 的合并；profile 优先。新建 profile 的 settings env 默认包含 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。

### Default cwd

```ts
cwd: options.cwd ?? process.cwd()
```

### Important

Do **not** set cwd to:

```text
%USERPROFILE%\.cc-profile-switch
```

Do **not** set cwd to:

```text
%USERPROFILE%\.cc-profile-switch\runtime\<profile>
```

MVP 默认应该从用户当前项目目录启动 Claude Code。

---

## 8.2 MCP Strategy

### Problem

用户的目标是：

```text
只切换全局配置
不动项目配置
```

所以 MCP 策略不能默认使用：

```text
--strict-mcp-config
```

因为 strict 可能让项目 `.mcp.json` 不再生效。

### Recommended MVP default

默认：

```text
mcpMode = merge
```

启动参数：

```bash
claude --mcp-config "<profile>\mcp.json"
```

不加：

```bash
--strict-mcp-config
```

### Optional strict mode

用户可以在 `profile.json` 中配置：

```json
{
  "launch": {
    "mcpMode": "strict"
  }
}
```

此时启动参数：

```bash
claude --mcp-config "<profile>\mcp.json" --strict-mcp-config
```

### Off mode

如果用户不想由 profile 控制 MCP：

```json
{
  "launch": {
    "mcpMode": "off"
  }
}
```

此时不传：

```text
--mcp-config
--strict-mcp-config
```

### Verified behavior

Claude Code `2.1.143` 下已验证：

```text
mcpMode=merge 时，profile mcp.json 与项目 .mcp.json 共存
mcpMode=strict 时，仅加载 profile mcp.json
CLAUDE_CONFIG_DIR 切换用户级配置来源
真实 C:\Users\h\.claude 的用户级配置不会作为 profile 混入
```

---

## 8.3 Plugin Strategy

### Default

profile 中的 plugin 通过 `--plugin-dir` 加载。
注意：Claude Code 自己安装/管理的用户级 plugin 状态在 `claude-home\plugins`；`--plugin-dir` 只用于额外 session plugin-dir。

如果 profile.json：

```json
{
  "launch": {
    "pluginDirs": [
      "plugins\\study-helper",
      "plugins\\note-tools"
    ]
  }
}
```

则生成参数：

```bash
--plugin-dir "<profile>\claude-home\plugins\study-helper"
--plugin-dir "<profile>\claude-home\plugins\note-tools"
```

`pluginDirs` 不会自动扫描子目录；配置什么目录，就传递什么目录。

---

## 8.4 Auto Memory Strategy

### Problem

Claude Code 的 auto memory 可能存储在用户级配置相关位置，且会在会话开始时加载一部分内容。

### MVP default

默认不强制关闭 auto memory。

原因：

```text
用户澄清说项目配置应该继续生效
auto memory 写入位置由 profile 的 autoMemoryDirectory 固定到 claude-home\memory\auto
强行关闭可能改变 Claude Code 原生项目体验
```

### Optional flag

可以提供：

```bash
ccps launch coding --disable-auto-memory
```

或 profile.json：

```json
{
  "launch": {
    "disableAutoMemory": true
  }
}
```

对应 env：

```text
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```

### Current implementation

当前实现：

```text
每个 profile 模板都创建 claude-home/memory/auto/MEMORY.md
claude-home/settings.json 必须包含 autoMemoryDirectory=<profile>\claude-home\memory\auto
validate 会阻止 autoMemoryDirectory 指向其他 profile 或真实全局目录
disableAutoMemory 仍是可选开关，但默认 false
```

---

## 8.5 `ccps launch --dry-run`

必须输出：

```text
profile name
profile path
claude-home path
current project cwd
mcp mode
plugin dirs
command
args
env changes
memory paths
api config source status and key names
warnings
validation result
```

示例：

```text
Launch plan for profile: coding

CWD:
  D:\Projects\my-app

Profile:
  C:\Users\h\.cc-profile-switch\profiles\coding

Claude home:
  C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Environment:
  CLAUDE_CONFIG_DIR=C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Command:
  claude

Arguments:
  --dangerously-skip-permissions
  --mcp-config C:\Users\h\.cc-profile-switch\profiles\coding\mcp.json

Memory:
  user: C:\Users\h\.cc-profile-switch\profiles\coding\claude-home\CLAUDE.md
  auto: C:\Users\h\.cc-profile-switch\profiles\coding\claude-home\memory\auto

API config:
  common: present/missing
  profile: present/missing
  env keys: key names only, never values

MCP mode:
  merge

Project config:
  Preserved. Claude Code will start in D:\Projects\my-app.

No command executed because --dry-run is enabled.
```

---

## 8.6 Spawn Strategy

```ts
spawn('claude', args, {
  cwd,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ...apiEnv,
    CLAUDE_CONFIG_DIR: profile.claudeHomePath,
    ...(disableAutoMemory ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {})
  }
})
```

Rules:

```text
Never build one command string for execution.
Use command + args array.
Only stringify for dry-run display.
```

---

## 8.7 Launch Verification Checklist

必须新增：

```text
VERIFY-CLAUDE-CODE-BEHAVIOR.md
```

内容至少包括：

### Verification 1: User-level CLAUDE.md switch

准备：

```text
C:\Users\h\.claude\CLAUDE.md
  GLOBAL_ORIGINAL_MARKER

%USERPROFILE%\.cc-profile-switch\profiles\coding\claude-home\CLAUDE.md
  PROFILE_CODING_MARKER

D:\Projects\demo\CLAUDE.md
  PROJECT_MARKER
```

执行：

```powershell
cd D:\Projects\demo
ccps launch coding
```

问 Claude：

```text
请列出你能看到的 marker。
```

预期：

```text
能看到 PROFILE_CODING_MARKER
能看到 PROJECT_MARKER
不能看到 GLOBAL_ORIGINAL_MARKER
```

### Verification 2: User-level settings switch

准备：

```text
C:\Users\h\.claude\settings.json
profiles\coding\claude-home\settings.json
D:\Projects\demo\.claude\settings.json
```

执行：

```powershell
cd D:\Projects\demo
ccps launch coding
/status
```

预期：

```text
User settings 来源应指向 profile claude-home
Project settings 来源应指向当前项目
不应使用真实 C:\Users\h\.claude\settings.json
```

### Verification 3: Project config preserved

准备：

```text
D:\Projects\demo\.claude\agents\project-agent.md
profiles\coding\claude-home\agents\global-agent.md
```

执行：

```powershell
cd D:\Projects\demo
ccps launch coding
```

预期：

```text
project-agent 可用
global-agent 可用
```

### Verification 4: MCP merge mode

准备：

```text
profiles\coding\mcp.json
D:\Projects\demo\.mcp.json
```

执行：

```powershell
cd D:\Projects\demo
ccps launch coding
```

预期：

```text
profile MCP 可用
project MCP 可用
真实全局 MCP 不应混入
```

当前验证结果已满足；未来 Claude Code 版本变化时再复验。

### Verification 5: Auth/session behavior

执行：

```powershell
ccps launch coding
```

当前记录：

```text
无显式 API env 时，隔离 profile 会提示 Not logged in
显式 API env 可通过 common api-settings.json 或 profile settings.json env 提供
session-env/sessions 等 Claude Code 状态出现在 profile 的 claude-home 内
未检视或迁移任何敏感内容
```

结论见 VERIFY-CLAUDE-CODE-BEHAVIOR.md。

---

## 9. Module Design

## 9.1 `commands/*`

负责：

```text
解析 CLI 参数
调用 core service
输出结果
处理错误
```

不负责：

```text
复杂路径拼接
业务校验
Claude launch 细节
```

## 9.2 `core/app-config.ts`

负责：

```text
加载 config.json
保存 config.json
确保 app home 存在
计算 profilesDir/backupsDir
```

## 9.3 `core/profile.ts`

负责：

```text
listProfiles()
getProfile(name)
createProfile(name, template)
validateProfileName(name)
resolveProfilePaths(name)
```

`resolveProfilePaths(name)` 返回：

```ts
type ResolvedProfilePaths = {
  profileDir: string
  manifestPath: string
  claudeHomeDir: string
  claudeMdPath: string
  settingsPath: string
  skillsDir: string
  agentsDir: string
  mcpPath: string
  pluginsDir: string
}
```

## 9.4 `core/validator.ts`

负责：

```text
validateProfile()
validateJsonFile()
validateRequiredFiles()
validateRequiredDirs()
validateSensitiveFiles()
```

## 9.5 `core/launcher.ts`

负责：

```text
buildLaunchPlan()
printLaunchPlan()
executeLaunchPlan()
```

## 9.6 `platform/windows-path.ts`

负责：

```text
getUserHome()
getAppHome()
resolveInside()
assertInsideBase()
normalizeWinPath()
toDisplayPath()
quoteForDisplay()
```

## 9.7 `platform/process.ts`

负责：

```text
commandExists('claude')
spawnClaude(plan)
```

## 9.8 `platform/editor.ts`

负责：

```text
open file or directory in a new VS Code window through code -n
report a clear error when the code/code.cmd command is unavailable
```

---

## 10. CLI Command Implementation

## 10.1 `ccps init`

### Behavior

创建：

```text
%USERPROFILE%\.cc-profile-switch\
  config.json
  profiles\
    coding\
      profile.json
      claude-home\
        CLAUDE.md
        settings.json
        skills\
        agents\
      mcp.json
      plugins\
    study\
    work\
    research\
    general\
  backups\
```

### Must not

```text
不能读取 C:\Users\h\.claude
不能复制 C:\Users\h\.claude
不能覆盖已有 profile
```

---

## 10.2 `ccps list`

输出：

```text
NAME       STATUS     DESCRIPTION
coding     valid      Coding global user profile
study      valid      Study global user profile
work       valid      Work global user profile
research   valid      Research global user profile
general    valid      General global user profile
```

---

## 10.3 `ccps create <name>`

默认：

```bash
ccps create my-profile --template blank
```

模板：

```text
coding
study
work
research
general
blank
```

---

## 10.4 `ccps show <name>`

输出：

```text
Profile: coding
Path: C:\Users\h\.cc-profile-switch\profiles\coding

Claude home:
  ✓ claude-home\
  ✓ claude-home\CLAUDE.md
  ✓ claude-home\settings.json
  ✓ claude-home\skills\
  ✓ claude-home\agents\

MCP:
  ✓ mcp.json

Plugins:
  ✓ plugins\
```

---

## 10.5 `ccps edit <name> [file-or-folder]`

映射：

```text
ccps edit coding                 → profiles\coding\
ccps edit coding CLAUDE.md       → profiles\coding\claude-home\CLAUDE.md
ccps edit coding settings.json   → profiles\coding\claude-home\settings.json
ccps edit coding mcp.json        → profiles\coding\mcp.json
ccps edit coding profile.json    → profiles\coding\profile.json
ccps edit coding claude-home     → profiles\coding\claude-home
ccps edit coding skills          → profiles\coding\claude-home\skills
ccps edit coding claude-home\skills → profiles\coding\claude-home\skills
```

`edit` only opens existing targets inside the selected profile. It blocks path traversal and credential-like target names such as token, secret, credential, and oauth. The platform opener uses VS Code's `code -n` so each invocation opens a new window.

---

## 10.6 `ccps validate <name>`

结果等级：

```text
valid
warning
error
```

error 阻止 launch。

warning 可以 launch，但会提示。

---

## 10.7 `ccps backup <name>`

备份整个 profile 目录：

```text
profiles\coding\
```

到：

```text
backups\coding-YYYYMMDD-HHmmss\
```

---

## 10.8 `ccps launch <name>`

默认：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

等价于：

```text
在 D:\Projects\my-app 启动 claude
并设置 CLAUDE_CONFIG_DIR 指向 coding 的 claude-home
```

支持：

```bash
ccps launch coding --dry-run
ccps launch coding --cwd D:\Projects\my-app
ccps launch coding --debug
ccps launch coding --mcp-mode strict
ccps launch coding --disable-auto-memory
```

---

## 11. Database & Data Storage

## 11.1 Storage Choice

不使用数据库。

使用本地文件系统。

### Why

```text
配置本质是文件
Claude Code 本身也基于文件配置
本地文件更透明
适合开源 CLI
不需要服务器
不需要迁移
```

## 11.2 What to store

```text
config.json
api-settings.json
profile.json
claude-home/CLAUDE.md
claude-home/settings.json
claude-home/memory/auto/MEMORY.md
claude-home/skills/
claude-home/agents/
claude-home/plugins/
mcp.json
backups/
```

## 11.3 What not to store

```text
OAuth token
session
credential
history
cache
transcript
真实 C:\Users\h\.claude 的整体副本
真实 ~/.claude.json
```

---

## 12. Security Implementation

## 12.1 Core Safety Rules

Never:

```text
复制整个 C:\Users\h\.claude
覆盖 C:\Users\h\.claude
修改项目 .claude
迁移 OAuth/session/token/history/cache
修改 ~/.claude.json
自动写 PowerShell Profile
自动联网下载 plugin
```

Always:

```text
路径 resolve 成绝对路径
阻止路径穿越
validate before launch
launch 支持 dry-run
错误信息给出下一步
```

## 12.2 Sensitive Scan

`ccps validate` does not run sensitive filename scanning. Validation is a launch-readiness check: required files, JSON/schema validity, profile memory path, plugin path traversal, and other conditions that directly affect whether Claude Code can start with the selected profile.

Sensitive filename checks are reserved for file-opening and future packaging flows such as export/import, where the tool is about to expose, move, or bundle profile contents.

High risk keywords:

```text
token
secret
credential
credentials
oauth
```

Medium risk keywords:

```text
.claude.json
session
sessions
history
cache
log
transcript
```

High risk:

```text
validate = ignored
launch = ignored
edit/export/import = block or require explicit safety handling
```

Medium risk:

```text
validate = ignored
launch = ignored
edit/export/import = warn or require explicit safety handling
```

## 12.3 Auth/Session Policy

MVP 不管理认证。

如果设置 `CLAUDE_CONFIG_DIR` 后 Claude Code 要求重新登录：

```text
不要复制真实 C:\Users\h\.claude 或 ~/.claude.json
不要迁移 token
让用户按 Claude Code 官方流程登录
在文档中说明每个 profile 可能需要单独登录，取决于 Claude Code 当前版本行为
```

---

## 13. Testing Strategy

## 13.1 Unit Tests

重点：

```text
profile name validation
Windows path resolution
path traversal blocking
template generation
JSON validation
sensitive file scanning
launch plan generation
mcp mode args
plugin dir args
```

## 13.2 Integration Tests

使用临时目录：

```text
%TEMP%\ccps-test-xxxx\
```

测试：

```text
init
create
list
show
validate
backup
launch --dry-run
```

不要在自动测试里调用真实 Claude Code。

## 13.3 Manual Tests

必须手动验证：

```text
ccps launch coding
ccps launch coding --dry-run
ccps launch coding --cwd D:\Projects\demo
ccps launch coding --mcp-mode strict
```

并产出：

```text
VERIFY-CLAUDE-CODE-BEHAVIOR.md
```

---

## 14. Deployment Plan

## 14.1 Development Usage

本地开发：

```bash
npm install
npm run dev -- --help
npm run build
node dist/index.js --help
```

## 14.2 Local Install

开发期：

```bash
npm link
ccps --help
```

## 14.3 Open Source Release

后续开源时：

```bash
npm publish
```

用户安装：

```bash
npm install -g cc-profile-switch
```

---

## 15. Cost Breakdown

## 15.1 Development Phase

| Item | Cost |
|---|---:|
| Node.js | Free |
| TypeScript | Free |
| Commander | Free |
| Zod | Free |
| Vitest | Free |
| GitHub | Free |
| Claude Code / Codex 使用 | 使用用户已有订阅或工具，不作为产品成本 |

## 15.2 Production Phase

| Item | Cost |
|---|---:|
| Server | 0 |
| Database | 0 |
| Cloud storage | 0 |
| Auth service | 0 |
| Runtime cost | 0 |

---

## 16. Important Limitations

## 16.1 What This Approach Can Do

```text
可以在当前项目目录启动 Claude Code
可以切换用户级 ~/.claude 配置来源
可以保留项目级配置
可以避免直接覆盖真实 C:\Users\h\.claude
可以让多个 profile 拥有不同 CLAUDE.md/settings/skills/agents/plugins/mcp
可以提供 dry-run 验证启动计划
```

## 16.2 What This Approach Cannot Guarantee Without Verification

```text
CLAUDE_CONFIG_DIR 是否影响未来 Claude Code 版本新增的所有用户级状态
未来 Claude Code 是否改变 --mcp-config 与项目 .mcp.json 的合并规则
未来 Claude Code 是否改变 plugins 或 auto memory 的内部目录规则
认证状态是否需要每个 profile 单独登录
```

## 16.3 What It Will Not Do

```text
不会覆盖项目配置
不会隔离项目配置
不会自动清理项目 .claude
不会迁移账号
不会复制真实 .claude
不会管理历史会话
不会内置 AI
不会做 GUI/TUI
```

---

## 17. Learning Resources

## 17.1 Essential Topics

你需要理解：

```text
Node.js CLI 基础
TypeScript 基础
Windows 路径处理
child_process.spawn
JSON 文件读写
Claude Code 配置层级
CLAUDE_CONFIG_DIR
MCP config
```

## 17.2 AI Assistant Workflow

历史开发顺序：

```text
先让 AI 搭项目骨架
再让 AI 实现路径模块
再实现 init/list/create/show
再实现 validate/backup/edit
最后实现 launch --dry-run、真实 launch 和文档验证
```

---

## 18. Success Checklist

## 18.1 Before Starting Development

```text
[ ] PRD.md 已确认
[ ] TECH-DESIGN.md 已确认
[ ] AGENTS.md 已生成
[ ] 已决定只做 Windows + Node.js CLI
[ ] 已确认默认 launch 模式是 Global User Config Switch Mode
```

## 18.2 During Development

```text
[x] dry-run、validate 和真实 launch 已按顺序实现
[x] 所有路径处理集中封装
[x] validate 能阻止明显错误
[x] 不复制真实 C:\Users\h\.claude
[x] 不修改项目 .claude
```

## 18.3 Before Launch

```text
[x] ccps init 成功
[x] ccps list 成功
[x] ccps create 成功
[x] ccps show 成功
[x] ccps edit 成功
[x] ccps validate 成功
[x] ccps backup 成功
[x] ccps launch --dry-run 输出正确
[x] ccps launch 能在项目目录里启动 Claude Code
[x] VERIFY-CLAUDE-CODE-BEHAVIOR.md 已完成
```

---

## 19. Definition of Technical Success

MVP 技术成功标准：

```text
[ ] 用户可以在任意项目目录执行 ccps launch coding
[ ] Claude Code 从当前项目目录启动
[ ] 当前项目配置继续生效
[ ] 用户级配置切换为 profile 的 claude-home
[ ] 真实 C:\Users\h\.claude 不被修改
[ ] 真实 C:\Users\h\.claude 不被复制
[ ] profile 可以创建、查看、编辑、校验、备份
[ ] launch 前可 dry-run
[ ] 关键行为有手动验证记录
```

---

## 20. Implementation Order

历史实现顺序已经完成：

```text
1. 项目初始化
2. 路径与错误处理
3. app config
4. profile templates，新版 claude-home 结构
5. init
6. list
7. create
8. show
9. validate
10. backup
11. edit
12. launch --dry-run
13. Claude Code 行为验证
14. real launch
15. README / AGENTS.md
```

后续维护 launch 时，必须先同步 dry-run、validate、README 和验证文档，避免真实启动行为与预览不一致。

---

## 21. Package Scripts

建议：

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format cjs --dts false --clean",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "check": "npm run lint && npm run test && npm run build"
  }
}
```

`package.json` bin：

```json
{
  "bin": {
    "ccps": "dist/index.js"
  }
}
```

---

## 22. AGENTS.md 草案

```md
# AGENTS.md

## Project

CC-Profile-Switch is a Windows-only Node.js CLI tool for switching Claude Code user-level global configuration profiles.

The CLI command is:

```bash
ccps
```

## Core Concept

This tool only switches user-level Claude Code global configuration.

It must preserve project-level Claude Code configuration.

Default behavior:

```powershell
cd D:\Projects\my-app
ccps launch coding
```

This should:
- start Claude Code from `D:\Projects\my-app`
- keep project `CLAUDE.md` and `.claude/` config active
- set `CLAUDE_CONFIG_DIR` to the selected profile's `claude-home`
- not copy or overwrite the real `C:\Users\h\.claude`

## MVP Scope

Only implement:

```text
ccps init
ccps list
ccps create <name>
ccps show <name>
ccps edit <name> [file-or-folder]
ccps launch <name>
ccps validate <name>
ccps backup <name>
```

Do not implement:
- TUI
- GUI
- cloud sync
- multi-account switching
- OAuth/session migration
- plugin marketplace
- macOS/Linux support
- settings.local.json management
- output-styles management

## Platform

Windows only.

Use:
- Node.js
- TypeScript
- Commander
- Zod
- Vitest

## Profile Structure

Use:

```text
%USERPROFILE%\.cc-profile-switch\profiles\<profile>\
  profile.json
  claude-home\
    CLAUDE.md
    settings.json
    memory\
      auto\
        MEMORY.md
    skills\
    agents\
    plugins\
  mcp.json
```

Do not use the old runtime-project isolation structure as the default.

## Safety Rules

Never:
- Copy the entire `C:\Users\h\.claude` directory.
- Overwrite `C:\Users\h\.claude`.
- Modify project `.claude`.
- Read or migrate OAuth/session/token/history/cache.
- Modify `~/.claude.json`.
- Silently delete user files.
- Silently overwrite profile files.
- Auto-install plugins from the network.

Always:
- Resolve paths to absolute paths.
- Prevent path traversal.
- Validate JSON before launch.
- Scan for sensitive file names.
- Provide `--dry-run` for launch.
- Show clear next-step hints in errors.

## Launch Strategy

Default launch mode:

```text
Global User Config Switch Mode
```

Implementation:
- cwd = current project directory
- env.CLAUDE_CONFIG_DIR = selected profile's `claude-home`
- args include `--dangerously-skip-permissions` by default unless `launch.skipPermissions=false`
- common `api-settings.json` env is merged with profile `claude-home\settings.json` env; profile wins
- auto memory is pinned to selected profile's `claude-home\memory\auto`
- do not change cwd to `.cc-profile-switch`
- do not use runtime project isolation by default
- do not use `--add-dir` by default

MCP:
- default mcpMode = merge
- strict MCP is optional, not default

## Implementation Order

1. Project setup
2. Path utilities
3. App config
4. Templates using `claude-home`
5. init
6. list
7. create
8. show
9. validate
10. backup
11. edit
12. launch --dry-run
13. Claude Code behavior verification
14. real launch
15. README

This order is complete. Future launch changes must keep dry-run, validation, README, and verification docs in sync.

## Required Verification Document

Create:

```text
VERIFY-CLAUDE-CODE-BEHAVIOR.md
```

It must verify:
- profile CLAUDE.md replaces real global CLAUDE.md
- project CLAUDE.md still loads
- profile settings replace real global settings
- project settings still load
- MCP merge/strict behavior
- auth/session behavior with CLAUDE_CONFIG_DIR
```

---

## 23. Historical First Codex Task

以下是项目初始阶段的历史任务记录，不再代表当前下一步：

```md
请根据 `TECH-DESIGN.md` 初始化 CC-Profile-Switch 项目骨架。

只完成以下内容：
1. 创建 package.json
2. 配置 TypeScript、tsup、vitest
3. 创建 src/index.ts
4. 接入 commander
5. 实现 `ccps --help`
6. 创建 commands/core/platform/schemas/templates/utils 目录
7. 创建模板目录，但只放占位文件
8. 不实现真实业务逻辑
9. 不实现 launch
10. 不读取、不复制、不修改任何真实 Claude Code 配置

注意：
默认 launch 策略是 Global User Config Switch Mode，不是 Runtime Project Isolation。
profile 结构必须使用 `claude-home`。
```

---

## 24. Technical Design Conclusion

MVP 最佳技术路线：

```text
Windows only
Node.js CLI
TypeScript
Commander
Zod
Vitest
Global User Config Switch Mode
CLAUDE_CONFIG_DIR profile switch
Preserve project config
Dry-run first
Validate before launch
No direct .claude mutation
```

最关键的修正：

```text
旧方案：runtime project isolation
  cwd = .cc-profile-switch\runtime\<profile>
  通过 --add-dir 访问项目

新方案：global user config switch
  cwd = 当前项目目录
  CLAUDE_CONFIG_DIR = profile\claude-home
  项目配置原生生效
  全局配置切换到 profile
```

第一版不要追求功能多。

先把这条链路做稳：

```text
init
→ create/list/show/edit
→ validate
→ backup
→ launch --dry-run
→ verify Claude Code behavior
→ launch
```
