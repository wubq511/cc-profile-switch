# PRD: CC-Profile-Switch MVP

## Product Overview

### Product Name

**CC-Profile-Switch**

推荐命令别名：

```bash
ccps
```

### One-Sentence Description

CC-Profile-Switch 是一个 Windows 本地 Claude Code 用户级全局配置切换工具，帮助用户在 `coding`、`study`、`work`、`research`、`general` 等不同使用场景之间切换 Claude Code 的用户级配置目录，同时保留当前项目目录中的项目级配置继续按 Claude Code 原生规则生效。

### What It Builds

MVP 是一个 **Windows-only Node.js CLI**。

用户可以在任意项目目录中执行：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

工具会：

```text
1. 保持当前工作目录不变
2. 使用当前项目目录启动 Claude Code
3. 通过 CLAUDE_CONFIG_DIR 切换用户级 ~/.claude 配置来源
4. 保留当前项目的 CLAUDE.md、.claude/settings.json、.claude/agents、.claude/skills 等项目级配置
5. 不直接修改 C:\Users\h\.claude
6. 不迁移 OAuth/session/token/history/cache
```

### Core Product Boundary

CC-Profile-Switch 不是“纯隔离运行环境”，也不是“项目配置替代器”。

它的核心定位是：

> **Claude Code 用户级全局配置 Profile 启动器。**

默认行为是：

```text
切换 User scope
保留 Project scope
不处理账号
不修改项目配置
```

---

## Who It's For

### Primary User: Vibe-Coder / Claude Code Heavy User

主要用户是：

- 高频使用 Claude Code 的个人开发者
- Vibe-coder
- AI 编程学习者
- 同时把 Claude Code 用于编程、学习、工作、调研、文档整理等多种场景的人

他们通常：

- 能使用 Windows Terminal / PowerShell
- 理解 `CLAUDE.md`、settings、MCP、plugins、skills、agents 的基本概念
- 希望用 AI 写代码，但自己负责指导、测试、验收
- 不想每次使用不同场景都手动修改 `C:\Users\h\.claude`

### Example User Story

Robert 平时在 `C:\Users\h\.claude\CLAUDE.md` 中写了大量 coding 规则，例如项目开发规范、AGENTS.md 规则、代码审查习惯、测试要求。

但他有时也会用 Claude Code 做学习助手、工作助手、调研助手。

他希望：

```powershell
cd D:\Courses\math
ccps launch study
```

让 Claude Code 使用 study 场景的用户级配置。

也希望：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

让 Claude Code 使用 coding 场景的用户级配置。

同时，他不希望工具改动当前项目里的：

```text
CLAUDE.md
.claude/settings.json
.claude/agents/
.claude/skills/
```

项目配置应该继续正常生效。

---

## The Problem We're Solving

### Current Pain

Claude Code 的用户级全局配置通常位于：

```text
C:\Users\h\.claude
```

其中可能包含：

```text
CLAUDE.md
settings.json
skills/
agents/
plugins/
```

当用户把全局 `CLAUDE.md` 写成强 coding 风格后，Claude Code 在其他场景下也会受影响。

例如：

| 使用场景 | 用户真实需求 | 全局 coding 配置带来的问题 |
|---|---|---|
| coding | 项目开发、重构、测试 | 正常 |
| study | 学习辅导、知识点讲解 | 容易被代码审查、工程流程污染 |
| work | 文档整理、任务拆解 | 输出偏技术方案 |
| research | 网页调研、资料归纳 | 过度关注实现，不够像调研助手 |
| general | 临时通用任务 | 被默认当成开发任务处理 |

### Why Existing Manual Workflow Fails

手动方案通常是：

```text
打开 C:\Users\h\.claude\CLAUDE.md
手动替换成 study/coding/work/research 版本
再启动 Claude Code
```

问题：

- 容易忘记切换
- 容易误改
- 容易覆盖
- 没有备份
- 没有 profile 管理
- 没有 dry-run
- 不适合开源复用
- 不适合长期维护

### Corrected Product Scope

本项目只切换 **用户级全局配置**。

不做：

```text
不替换项目配置
不阻止项目配置加载
不把项目 cwd 改到工具 runtime 目录
不把真实项目通过 --add-dir 挂载到工具 runtime
```

用户应该可以在真实项目目录里直接使用：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

---

## User Journey

### Discovery → First Use → Success

#### 1. Discovery

用户发现自己经常在不同 Claude Code 使用场景之间来回切换：

```text
coding
study
work
research
general
```

但全局配置只有一套，导致不同场景互相污染。

#### 2. Install / Setup

用户安装工具后执行：

```powershell
ccps init
```

工具生成：

```text
%USERPROFILE%\.cc-profile-switch\
  config.json
  profiles\
    coding\
    study\
    work\
    research\
    general\
  backups\
```

#### 3. Edit Profile

用户编辑某个 profile：

```powershell
ccps edit study CLAUDE.md
ccps edit coding settings.json
```

工具实际打开的是 profile 中的用户级配置镜像：

```text
profiles\study\claude-home\CLAUDE.md
profiles\coding\claude-home\settings.json
```

#### 4. Validate

用户检查 profile 是否完整、安全：

```powershell
ccps validate study
```

工具检查：

```text
profile.json
claude-home\CLAUDE.md
claude-home\settings.json
mcp.json
claude-home\skills\
claude-home\agents\
claude-home\plugins\
敏感文件名
JSON 合法性
```

#### 5. Launch in Current Project

用户在任意目录执行：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

工具从当前目录启动 Claude Code，并设置：

```text
CLAUDE_CONFIG_DIR=%USERPROFILE%\.cc-profile-switch\profiles\coding\claude-home
```

预期效果：

```text
用户级配置：来自 coding profile
项目级配置：继续来自 D:\Projects\my-app
```

#### 6. Success

用户不用再手动改 `C:\Users\h\.claude`。

可以根据场景稳定启动：

```powershell
ccps launch coding
ccps launch study
ccps launch work
ccps launch research
ccps launch general
```

---

## MVP Features

### Must Have for Launch

#### 1. `ccps init`

初始化工具目录和默认 profiles。

输入：

```powershell
ccps init
```

输出目录：

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
        plugins\
      mcp.json
    study\
    work\
    research\
    general\
  backups\
```

验收标准：

```text
[ ] 首次执行能生成完整目录结构
[ ] 重复执行不会覆盖用户已有文件
[ ] 默认 profile 都包含 claude-home
[ ] 默认 settings.json 和 mcp.json 是合法 JSON
[ ] 不读取或复制 C:\Users\h\.claude
```

---

#### 2. `ccps list`

查看已有 profiles。

输入：

```powershell
ccps list
```

输出示例：

```text
Profiles directory: C:\Users\h\.cc-profile-switch\profiles

NAME       STATUS     LAST USED             DESCRIPTION
coding     valid      2026-05-16 14:20      Coding global config profile
study      valid      -                     Study global config profile
work       valid      -                     Work global config profile
research   warning    -                     Missing mcp.json
general    valid      -                     General lightweight profile
```

验收标准：

```text
[ ] 能列出所有 profile
[ ] 能显示 valid / warning / error
[ ] 能显示最近使用时间
[ ] profile 目录不存在时提示运行 ccps init
```

---

#### 3. `ccps create <name>`

从模板创建新 profile。

输入：

```powershell
ccps create study-plus --template study
```

输出：

```text
profiles\study-plus\
  profile.json
  claude-home\
    CLAUDE.md
    settings.json
    skills\
    agents\
    plugins\
  mcp.json
```

验收标准：

```text
[ ] 支持 coding/study/work/research/general/blank 模板
[ ] 不覆盖同名 profile
[ ] profile name 只允许安全字符
[ ] 创建完成后输出下一步建议
```

---

#### 4. `ccps show <name>`

查看某个 profile 的结构和状态。

输入：

```powershell
ccps show study
```

输出示例：

```text
Profile: study
Path: C:\Users\h\.cc-profile-switch\profiles\study

User config home:
  C:\Users\h\.cc-profile-switch\profiles\study\claude-home

Files:
  ✓ profile.json
  ✓ claude-home\CLAUDE.md
  ✓ claude-home\settings.json
  ✓ mcp.json

Directories:
  ✓ claude-home\skills\
  ✓ claude-home\agents\
  ✓ claude-home\plugins\

Launch:
  cwd: current working directory
  CLAUDE_CONFIG_DIR: profile claude-home
  project config: preserved
```

验收标准：

```text
[ ] 能展示 profile 绝对路径
[ ] 能展示 claude-home 路径
[ ] 能展示核心文件是否存在
[ ] 能展示 JSON 校验结果
[ ] 能明确说明 project config preserved
```

---

#### 5. `ccps edit <name> [file]`

用默认编辑器打开 profile 文件。

输入：

```powershell
ccps edit study CLAUDE.md
ccps edit study settings.json
ccps edit study mcp.json
ccps edit study profile.json
ccps edit study
```

文件映射：

| 用户输入 | 实际打开 |
|---|---|
| `CLAUDE.md` | `profiles\<name>\claude-home\CLAUDE.md` |
| `settings.json` | `profiles\<name>\claude-home\settings.json` |
| `mcp.json` | `profiles\<name>\mcp.json` |
| `profile.json` | `profiles\<name>\profile.json` |
| 未指定文件 | 打开 profile 目录 |

验收标准：

```text
[ ] 能打开指定文件
[ ] 文件不存在时提示是否创建
[ ] 不允许编辑 profile 目录外的路径
[ ] 不编辑 C:\Users\h\.claude
[ ] 错误提示清楚
```

---

#### 6. `ccps launch <name>`

使用指定 profile 启动 Claude Code。

输入：

```powershell
ccps launch coding
```

典型使用方式：

```powershell
cd D:\Projects\my-app
ccps launch coding
```

默认行为：

```text
cwd = 当前用户所在目录
CLAUDE_CONFIG_DIR = profiles\coding\claude-home
项目配置 = 保留
真实 C:\Users\h\.claude = 不修改
```

启动策略：

```text
1. 读取 profile
2. validate profile
3. 构造 launch plan
4. 设置 CLAUDE_CONFIG_DIR
5. 如果存在 profile mcp.json，则通过 --mcp-config 加载
6. 默认不使用 --strict-mcp-config，避免吞掉项目 MCP
7. 从当前 cwd 启动 claude
```

示例 dry-run：

```powershell
ccps launch coding --dry-run
```

输出示例：

```text
Launch plan for profile: coding

Current working directory:
  D:\Projects\my-app

User config source:
  C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Environment:
  CLAUDE_CONFIG_DIR=C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Command:
  claude --mcp-config C:\Users\h\.cc-profile-switch\profiles\coding\mcp.json

Project config:
  Preserved. Claude Code will still discover project-level config from current cwd.

No command executed because --dry-run is enabled.
```

验收标准：

```text
[ ] 可以在 D:\Projects\my-app 中执行 ccps launch coding
[ ] 进程 cwd 是 D:\Projects\my-app
[ ] CLAUDE_CONFIG_DIR 指向 profile claude-home
[ ] 不切换到 .cc-profile-switch runtime 目录
[ ] 不使用 --add-dir 访问当前项目
[ ] 不修改当前项目配置
[ ] 不修改真实 C:\Users\h\.claude
[ ] --dry-run 能展示完整启动计划
[ ] 启动失败时有清晰错误
```

---

#### 7. `ccps validate <name>`

校验 profile 是否完整、安全、可启动。

输入：

```powershell
ccps validate study
```

校验项：

| 校验项 | 说明 |
|---|---|
| profile 目录存在 | `profiles\<name>` |
| 用户级配置目录存在 | `claude-home\` |
| 核心文件存在 | `claude-home\CLAUDE.md`、`claude-home\settings.json`、`mcp.json` |
| JSON 合法性 | `profile.json`、`claude-home\settings.json`、`mcp.json` |
| skills 目录 | `claude-home\skills\` |
| agents 目录 | `claude-home\agents\` |
| plugins 目录 | `claude-home\plugins\` |
| 敏感文件名 | token/session/oauth/credentials/history/cache 等 |
| 路径安全 | 不允许路径穿越 |

验收标准：

```text
[ ] 能识别非法 JSON
[ ] 能识别缺失核心文件
[ ] 能识别常见敏感文件名
[ ] 能给出修复建议
[ ] 能被 launch 自动调用
```

---

#### 8. `ccps backup <name>`

备份指定 profile。

输入：

```powershell
ccps backup coding
```

输出：

```text
%USERPROFILE%\.cc-profile-switch\backups\coding-20260516-142030\
```

备份内容：

```text
profile.json
claude-home\
mcp.json
```

验收标准：

```text
[ ] 能完整备份 profile
[ ] 备份目录带时间戳
[ ] 不修改原 profile
[ ] 备份前后不触碰 C:\Users\h\.claude
```

---

### Nice to Have (If Time Allows)

MVP 中可以保留但不强求：

```text
ccps launch <name> --no-mcp
ccps launch <name> --strict-mcp
ccps launch <name> --debug
ccps launch <name> --print-env
```

这些能力必须服从一个原则：

> 默认模式必须保留项目配置，只切换用户级全局配置。

---

### NOT in MVP (Saving for Later)

MVP 不做：

```text
TUI
GUI
云同步
多账号切换
OAuth/session 迁移
Claude Code 历史会话管理
插件市场
自动下载插件
macOS/Linux 支持
项目配置切换
项目配置覆盖
纯隔离 runtime 模式
settings.local.json 管理
output-styles 管理
复杂 settings 可视化编辑
```

所有后续扩展见：

```text
APPENDIX-CC-Profile-Switch-Roadmap.md
```

---

## How We'll Know It's Working

### Launch Success Metrics (First 30 Days)

| 指标 | 目标 |
|---|---|
| 默认 profiles 创建成功 | `ccps init` 后生成 5 个默认 profile |
| 当前项目目录启动成功 | 用户可在任意项目目录执行 `ccps launch coding` |
| 用户级配置切换成功 | `CLAUDE_CONFIG_DIR` 指向目标 profile 的 `claude-home` |
| 项目配置保留成功 | 当前项目的 `CLAUDE.md` / `.claude` 继续生效 |
| 原全局配置不被改动 | 不直接覆盖 `C:\Users\h\.claude` |
| 校验可用 | 能发现非法 JSON 和缺失文件 |
| 备份可用 | 能完整备份 profile |
| dry-run 可用 | 能展示 cwd、CLAUDE_CONFIG_DIR、命令参数 |

### Growth Metrics (Months 2-3)

这些不进入 MVP 实现，但可以用于后续判断：

```text
用户创建 3 个以上 profile
每周使用 5 次以上 ccps launch
用户不再手动修改 C:\Users\h\.claude\CLAUDE.md
README 能让新用户独立跑通
issue 中安全/路径类问题可控
```

---

## Look & Feel

### Design Vibe

```text
清晰
可靠
轻量
开发者友好
低干扰
```

### CLI Experience

输出应该：

- 简短
- 可读
- 有明确状态
- 有下一步建议
- 不输出大段无用日志
- 不隐藏危险操作
- 不让用户误以为项目配置被替换

### Simple Wireframe

#### `ccps list`

```text
CC-Profile-Switch

Profiles directory:
  C:\Users\h\.cc-profile-switch\profiles

NAME       STATUS     LAST USED             DESCRIPTION
coding     valid      2026-05-16 14:20      Coding user config profile
study      valid      -                     Study user config profile
work       valid      -                     Work user config profile
research   warning    -                     Missing mcp.json
general    valid      -                     General lightweight profile
```

#### `ccps launch coding --dry-run`

```text
Launch plan

Profile:
  coding

Current working directory:
  D:\Projects\my-app

User config source:
  C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Project config:
  Preserved

Environment:
  CLAUDE_CONFIG_DIR=C:\Users\h\.cc-profile-switch\profiles\coding\claude-home

Command:
  claude --mcp-config C:\Users\h\.cc-profile-switch\profiles\coding\mcp.json

No command executed.
```

---

## Technical Considerations

### Platform

```text
Windows only
PowerShell / Windows Terminal first
Node.js CLI
```

### Recommended Tech

```text
Node.js LTS
TypeScript
Commander
Zod
Vitest
fs-extra
picocolors
tsup
```

### Profile Data Structure

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
        plugins\
      mcp.json
    study\
    work\
    research\
    general\
  backups\
```

### Why `claude-home`

`claude-home` 是当前 profile 的用户级 Claude Code 配置目录。

它模拟的是：

```text
%USERPROFILE%\.claude
```

但不会直接改动真实目录。

启动时通过环境变量切换：

```text
CLAUDE_CONFIG_DIR=%USERPROFILE%\.cc-profile-switch\profiles\<name>\claude-home
```

这样目标是：

```text
User scope: switched
Project scope: preserved
```

### MCP Strategy

MVP 默认：

```text
mcpMode = merge
```

含义：

```text
如果 profile 中存在 mcp.json，则通过 --mcp-config 指定
默认不加 --strict-mcp-config
避免误伤项目级 MCP
```

可选：

```text
ccps launch coding --strict-mcp
```

该选项可以进入 nice-to-have，但不是默认行为。

### Critical Verification

必须验证以下行为：

```text
[ ] 在真实 C:\Users\h\.claude\CLAUDE.md 写入 GLOBAL_ORIGINAL_MARKER
[ ] 在 profile coding 的 claude-home\CLAUDE.md 写入 PROFILE_CODING_MARKER
[ ] 在 D:\Projects\demo\CLAUDE.md 写入 PROJECT_MARKER
[ ] cd D:\Projects\demo
[ ] ccps launch coding
[ ] Claude 应看到 PROFILE_CODING_MARKER
[ ] Claude 应看到 PROJECT_MARKER
[ ] Claude 不应看到 GLOBAL_ORIGINAL_MARKER
```

---

## Quality Standards

### Product Quality Rules

```text
不能静默覆盖任何用户配置
不能复制整个 C:\Users\h\.claude
不能修改项目 .claude
不能默认 strict 掉项目 MCP
不能把 cwd 切到工具 runtime
不能让用户误解当前项目配置被替换
```

### Implementation Quality Rules

```text
路径必须使用 Node path API 处理
spawn 必须使用 args 数组，不拼 shell 字符串
profile name 必须校验
JSON 必须校验
敏感文件必须扫描
launch 必须支持 --dry-run
错误必须给出下一步建议
```

### What This Project Will NOT Accept

```text
直接复制 C:\Users\h\.claude
直接覆盖 C:\Users\h\.claude
读取或迁移 OAuth/session/token/history/cache
默认删除或覆盖项目配置
真实 launch 前没有 dry-run
没有验证 CLAUDE_CONFIG_DIR 行为就声称完成
```

---

## Budget & Constraints

### Budget

```text
0 元优先
不依赖付费服务
不需要服务器
不需要数据库
不需要云同步
```

### Timeline

```text
没有硬性时间限制
以稳定、安全、可维护为主
```

### Platform Constraints

```text
只做 Windows
PowerShell / Windows Terminal 优先
不考虑 macOS / Linux
```

### Security Constraints

```text
不迁移 OAuth
不迁移 session
不保存 token
不读取历史记录
不复制整个 .claude
不静默覆盖官方配置
不修改项目配置
```

---

## Open Questions & Assumptions

### Assumptions

```text
Claude Code 支持 CLAUDE_CONFIG_DIR 切换用户级配置目录
设置 CLAUDE_CONFIG_DIR 后，用户级 CLAUDE.md/settings/skills/agents/plugins 从该目录读取
项目级配置仍按当前 cwd 原生加载
用户接受不同 profile 可能需要独立认证或独立配置状态
```

### Open Questions

```text
1. CLAUDE_CONFIG_DIR 是否会影响当前版本 Claude Code 的所有用户级配置源？
2. 使用 CLAUDE_CONFIG_DIR 后是否会要求每个 profile 单独登录？
3. profile 的 claude-home 是否会生成 session/history/cache？
4. 如果生成，是否需要 validate 时提示但不阻止？
5. --mcp-config 默认是否与项目 MCP 合并，还是存在覆盖行为？
6. 用户级 plugins 在 CLAUDE_CONFIG_DIR 下的加载规则是否稳定？
```

这些问题必须在技术设计和实现阶段通过 `VERIFY-CLAUDE-CODE-BEHAVIOR.md` 记录验证。

---

## Launch Strategy (Brief)

MVP 先作为本地开源 CLI 发布。

推荐 launch 顺序：

```text
1. 本地开发可运行
2. 本机真实 Claude Code 验证
3. README 写清楚安全边界
4. GitHub 开源
5. npm 本地安装或 npm 发布
```

不做：

```text
官网
云服务
GUI
插件市场
跨平台宣传
```

---

## Definition of Done for MVP

```text
[ ] 可以通过 npm 或本地 node 命令运行 ccps
[ ] ccps init 可以创建默认目录结构
[ ] ccps list 可以列出 profiles
[ ] ccps create 可以创建新 profile
[ ] ccps show 可以展示 profile 状态
[ ] ccps edit 可以打开 claude-home\CLAUDE.md / settings.json / mcp.json
[ ] ccps validate 可以校验 JSON 和敏感文件名
[ ] ccps backup 可以备份 profile
[ ] ccps launch 可以在当前项目目录启动 Claude Code
[ ] ccps launch 会设置 CLAUDE_CONFIG_DIR 指向 profile claude-home
[ ] ccps launch 不会切换 cwd 到工具目录
[ ] ccps launch 不会修改项目配置
[ ] ccps launch 不会直接覆盖 C:\Users\h\.claude
[ ] ccps launch --dry-run 可以展示启动计划
[ ] 完成 GLOBAL_ORIGINAL_MARKER / PROFILE_CODING_MARKER / PROJECT_MARKER 验证
[ ] README 可以指导 Windows 用户跑通完整流程
[ ] 错误提示清晰，包含下一步建议
[ ] MVP 不包含 TUI
[ ] MVP 不包含 GUI
[ ] MVP 不包含云同步
[ ] MVP 不包含多账号切换
```

---

## Next Steps

下一步应交给 Codex / Claude Code 生成或更新：

```text
TECH-DESIGN.md
AGENTS.md
VERIFY-CLAUDE-CODE-BEHAVIOR.md
README.md
```

给 Codex 的下一步提示：

```md
请根据更新后的 `PRD.md`，重新生成 `TECH-DESIGN.md`。

关键变更：
- MVP 默认不是 runtime isolation
- MVP 默认是 Global User Config Switch Mode
- 用户在当前项目目录执行 `ccps launch <profile>`
- cwd 必须保持为用户当前目录
- 工具通过 CLAUDE_CONFIG_DIR 切换用户级 ~/.claude 配置来源
- 项目级 CLAUDE.md / .claude/settings.json / .claude/agents / .claude/skills 继续按 Claude Code 原生规则生效
- 不默认使用 --strict-mcp-config
- 不使用 --add-dir 访问当前项目
- 不修改真实 C:\Users\h\.claude
- 不修改项目 .claude

请输出：
1. 技术架构
2. profile 数据结构
3. launch 策略
4. CLAUDE_CONFIG_DIR 验证计划
5. 每个 CLI 命令实现方案
6. 安全策略
7. 测试方案
8. 开发任务拆分
9. AGENTS.md 草案
```
