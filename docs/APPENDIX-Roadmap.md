# Appendix: CC-Profile-Switch 后续迭代与扩展规划

## 0. 附录说明

本文档是 `CC-Profile-Switch` 的后续迭代规划附录。

主 PRD 文件：

```text
PRD-CC-Profile-Switch-MVP-v3-global-config-switch.md
```

主 PRD 只描述 MVP 范围。

本附录用于沉淀：

```text
非 MVP 功能
后续版本规划
P1 / P2 / P3 功能池
可选扩展方向
不建议过早实现的能力
长期产品化可能性
```

原则：

> 附录中的内容不进入 MVP 实现范围，除非后续经过单独评估并明确升级为新版本需求。

---

## 1. 版本边界

## 1.1 MVP 范围

MVP 只包含：

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

MVP 技术形态：

```text
Windows only
Node.js CLI
无 TUI
无 GUI
无云同步
无多账号切换
无 OAuth/session 迁移
```

MVP 默认 launch 模式：

```text
Global User Config Switch Mode
```

即：

```text
用户在当前项目目录运行 ccps launch <profile>
工具设置 CLAUDE_CONFIG_DIR 指向 profile 的 claude-home
项目级配置继续生效
默认传递 --dangerously-skip-permissions，除非 profile 显式关闭
common api-settings.json 与 profile settings.json env 合并，profile 优先
默认 profile settings env 包含 CLAUDE_CODE_ATTRIBUTION_HEADER=0
memory 和 Claude Code 自己管理的 plugins 位于当前 profile 的 claude-home 内
```

MVP 不做：

```text
纯隔离 runtime mode
项目配置覆盖
项目配置禁用
自动登录迁移
多账号切换
```

---

## 1.2 后续版本判断标准

只有当 MVP 满足以下条件后，才考虑附录中的后续能力：

```text
[ ] MVP 能稳定完成 profile 创建、编辑、校验、备份、启动
[ ] Global User Config Switch Mode 已通过真实 Claude Code 验证
[ ] 用户确实每周多次使用不同 profile
[ ] 手动管理 profile 开始明显麻烦
[ ] CLI 命令语义已经稳定
[ ] README 已能让新用户跑通
[ ] 不存在明显安全隐患
```

---

## 2. P1 功能池：Profile 管理增强

P1 重点是增强本地 profile 管理能力，不改变产品形态，不引入 TUI / GUI。

| 功能 | 命令建议 | 价值 | 风险 |
|---|---|---|---|
| 复制 profile | `ccps copy <from> <to>` | 基于已有配置快速创建变体 | 可能复制敏感文件，需要复用 validate |
| 重命名 profile | `ccps rename <old> <new>` | 管理 profile 名称 | 需要处理引用关系 |
| 删除 profile | `ccps remove <name>` | 清理不用的 profile | 有误删风险，必须删除前备份 |
| 设置默认 profile | `ccps default <name>` | 支持 `ccps launch` 默认启动 | 需要更新 config.json |
| 最近使用记录 | `ccps recent` | 快速查看使用历史 | 只记录 profile 名，不记录任务内容 |
| 生成 PowerShell 函数 | `ccps alias <name>` | 让用户用 `cc-study` 这类短命令启动 | 需要注意路径转义 |
| 导出 profile | `ccps export <name>` | 本地迁移、备份 | 必须排除敏感文件 |
| 导入 profile | `ccps import <path>` | 复用他人配置包 | 需要安全检查 |

---

## 2.1 `ccps copy`

### 目标

让用户基于已有 profile 创建新 profile。

示例：

```powershell
ccps copy study study-math
```

### 约束

```text
复制前自动执行 validate
检测敏感文件
目标 profile 已存在时阻止覆盖
复制完成后更新 profile.json 中的 name / createdAt / updatedAt
不得复制真实 C:\Users\h\.claude
```

---

## 2.2 `ccps rename`

### 目标

修改 profile 名称。

示例：

```powershell
ccps rename study study-general
```

### 约束

```text
不允许重命名为已存在 profile
更新 profile.json
如果当前 defaultProfile 指向旧名称，需要提示用户是否同步更新
不得改动 claude-home 内部用户内容
```

---

## 2.3 `ccps remove`

### 目标

删除 profile。

示例：

```powershell
ccps remove old-study
```

### 约束

```text
删除前必须自动备份
必须二次确认
不允许删除最后一个 profile
不允许删除 defaultProfile，除非先修改 default
不得删除真实 C:\Users\h\.claude
```

---

## 2.4 `ccps alias`

### 目标

生成可复制到 PowerShell Profile 的快捷函数。

示例：

```powershell
ccps alias study
```

输出：

```powershell
function cc-study {
  ccps launch study
}
```

### 约束

```text
默认只输出，不自动写入用户 PowerShell Profile
后续可增加 --write，但必须确认
注意 Windows 路径和 PowerShell escaping
```

---

## 3. P2 功能池：诊断、校验、迁移增强

P2 重点是提升可靠性和可维护性。

| 功能 | 命令建议 | 价值 |
|---|---|---|
| 环境诊断 | `ccps doctor` | 检查 Node、Claude Code、路径、profile 状态 |
| 深度校验 | `ccps validate <name> --deep` | 检查 plugins/skills/agents 内部结构 |
| profile diff | `ccps diff <a> <b>` | 对比两个 profile 差异 |
| 配置修复建议 | `ccps repair <name>` | 修复缺失目录和模板文件 |
| Claude Code 行为验证助手 | `ccps verify-behavior` | 引导用户验证 CLAUDE_CONFIG_DIR 是否生效 |
| profile export/import 增强 | `ccps export/import` | 支持本地迁移 |
| 模板列表 | `ccps templates` | 查看内置模板 |

---

## 3.1 `ccps doctor`

### 目标

检查当前环境是否能正常使用 CC-Profile-Switch 和 Claude Code。

检查项：

```text
Node.js version
npm version
Windows platform
PowerShell availability
claude command availability
ccps config directory
profiles directory
backups directory
default profile
CLAUDE_CONFIG_DIR 当前值
当前目录是否为项目目录
```

输出示例：

```text
CC-Profile-Switch Doctor

✓ Windows detected
✓ Node.js 20.x detected
✓ Claude command found
✓ Config directory exists
✓ Profiles directory exists
! CLAUDE_CONFIG_DIR is already set in current shell

Suggestion:
  Clear current CLAUDE_CONFIG_DIR before testing ccps launch.
```

---

## 3.2 `ccps verify-behavior`

### 目标

半自动引导用户验证 Claude Code 是否按预期加载：

```text
profile 用户级配置
+ 当前项目配置
- 原始 C:\Users\h\.claude 配置
```

### 验证设计

准备三个 marker：

```text
GLOBAL_ORIGINAL_MARKER
PROFILE_CODING_MARKER
PROJECT_MARKER
```

验证预期：

```text
能看到 PROFILE_CODING_MARKER
能看到 PROJECT_MARKER
不能看到 GLOBAL_ORIGINAL_MARKER
```

### 为什么不进入 MVP

MVP 可以用文档手动验证。

`ccps verify-behavior` 是体验增强，后续再做。

---

## 3.3 `ccps diff`

### 目标

对比两个 profile 的差异。

示例：

```powershell
ccps diff coding study
```

对比内容：

```text
profile.json
claude-home\CLAUDE.md
claude-home\settings.json
mcp.json
claude-home\skills\
claude-home\agents\
claude-home\plugins\
```

### 约束

```text
MVP 后再做
不需要复杂三方 merge
只输出差异摘要即可
```

---

## 4. P3 功能池：体验增强与生态化

P3 是更远期的增强，不建议早做。

| 功能 | 价值 | 风险 |
|---|---|---|
| GUI 管理台 | 降低门槛 | 开发成本高，容易偏离核心 |
| TUI 菜单 | 交互更友好 | 增加依赖和状态复杂度 |
| VS Code 集成 | 方便开发者使用 | 需要插件开发 |
| Windows Terminal 集成 | 每个 profile 一个启动入口 | 需要修改系统级配置 |
| 模板市场 | 分享 profile 模板 | 安全审核成本高 |
| 插件市场 | 分享 plugins/skills/agents | 安全风险高 |
| 云同步 | 多设备使用 | 账号、隐私、安全复杂 |
| 团队共享 | 团队统一配置 | 超出个人工具定位 |
| macOS/Linux 支持 | 扩大用户范围 | 需要重做路径和 shell 适配 |

---

## 5. 可选高级模式：Isolated Runtime Mode

## 5.1 定义

Isolated Runtime Mode 是一个远期可选模式，不进入 MVP。

它的目标是：

```text
不加载当前项目 CLAUDE.md / .claude
只加载指定 profile
通过 --add-dir 访问项目文件
```

示例：

```powershell
ccps launch coding --isolated --cwd D:\Projects\my-app
```

预期行为：

```text
cwd = 工具生成的 runtime 目录
项目目录 = 通过 --add-dir 授权访问
项目配置 = 默认不加载
profile 配置 = 加载
```

## 5.2 为什么不进入 MVP

因为用户已明确：

```text
配置切换只做全局配置切换，不动项目配置
```

所以 MVP 必须优先支持：

```text
Global User Config Switch Mode
```

而不是 isolated mode。

## 5.3 何时考虑

只有当用户出现以下需求时再考虑：

```text
我想完全忽略项目 CLAUDE.md
我想临时用纯净 profile 读取某个项目
我想避免项目配置影响某次调研/学习
我想做一次真正 sandbox 化的 Claude Code 启动
```

---

## 6. 后续版本规划建议

## 6.1 V0.1：MVP

目标：

```text
跑通核心 CLI 工作流
支持 Windows
支持默认 profile
支持 Global User Config Switch Mode
支持启动、校验、备份
支持 common/profile API env 合并
支持 profile 级 memory 与 claude-home plugin 状态隔离
```

范围：

```text
init
list
create
show
edit
launch
validate
backup
```

对应文档：

```text
PRD-CC-Profile-Switch-MVP-v3-global-config-switch.md
```

---

## 6.2 V0.2：Profile 管理增强

建议加入：

```text
copy
rename
remove
default
recent
alias
```

优先级建议：

```text
1. copy
2. remove
3. rename
4. default
5. recent
6. alias
```

原因：

```text
copy 最实用，可以快速创建变体
remove / rename 是基础管理能力
default 提升日常启动效率
recent 是锦上添花
alias 对 PowerShell 用户很有价值，但不是核心
```

---

## 6.3 V0.3：安全与诊断增强

建议加入：

```text
doctor
validate --deep
repair
diff
verify-behavior
```

优先级建议：

```text
1. doctor
2. verify-behavior
3. validate --deep
4. repair
5. diff
```

原因：

```text
开源用户最常见的问题是环境和加载行为问题
verify-behavior 能帮助验证 CLAUDE_CONFIG_DIR 行为
validate --deep 提升配置可靠性
repair 适合模板文件缺失的情况
diff 对高级用户有用，但不是刚需
```

---

## 6.4 V0.4：导入导出与模板增强

建议加入：

```text
export
import
templates
template create
```

目标：

```text
让用户可以在本地复制 profile
让开源社区可以分享非敏感模板
继续避免云同步和市场化复杂度
```

安全要求：

```text
export 前必须扫描敏感文件
import 后必须 validate
默认不允许导入包含 token/session/credentials 的包
模板只应包含非敏感配置
```

---

## 6.5 V1.0：开源稳定版

V1.0 目标不是功能多，而是稳定可用。

V1.0 应满足：

```text
[ ] MVP 核心命令稳定
[ ] Global User Config Switch Mode 通过真实验证
[ ] V0.2 profile 管理命令稳定
[ ] doctor 可诊断常见环境问题
[ ] README 完整
[ ] Windows 安装路径跑通
[ ] npm 安装跑通
[ ] 有基础测试
[ ] 有示例 profiles
[ ] 有安全说明
[ ] 有贡献指南
[ ] 有变更日志
```

---

## 7. 暂不建议做的能力

## 7.1 多账号切换

不建议做。

原因：

```text
涉及 OAuth/session
容易破坏 Claude Code 登录状态
可能带来隐私和安全问题
与 profile 场景切换不是同一个问题
```

结论：

```text
不要把 CC-Profile-Switch 做成账号切换器。
```

---

## 7.2 直接管理真实 `C:\Users\h\.claude`

不建议做。

原因：

```text
该目录可能包含敏感状态
Claude Code 官方机制可能变化
工具误操作代价高
```

结论：

```text
可以读取必要信息进行诊断，但不应主动复制、覆盖、迁移整个目录。
```

---

## 7.3 插件市场

不建议早做。

原因：

```text
插件可能执行命令
插件可能访问文件系统
插件安全审核成本高
社区生态还未稳定前，市场化没有必要
```

结论：

```text
可以先做本地 plugins 管理，不做 marketplace。
```

---

## 7.4 云同步

不建议早做。

原因：

```text
需要账号系统
需要后端
涉及配置隐私
与 MVP 的本地工具定位冲突
```

结论：

```text
优先支持本地 export/import，而不是云同步。
```

---

## 7.5 GUI

不建议早做。

原因：

```text
CLI 已能解决核心问题
GUI 会显著增加开发和维护成本
当前用户能够使用命令行
GUI 可能把工具膨胀成配置平台
```

结论：

```text
只有当 CLI 稳定并且出现大量非命令行用户需求后，再考虑 GUI。
```

---

## 7.6 TUI

不建议进入 MVP。

原因：

```text
当前用户明确要求 MVP 不做 TUI
明确命令更适合 Codex 实现和维护
TUI 会增加状态管理和依赖复杂度
```

结论：

```text
TUI 可作为远期可选项，不进入 MVP。
```

---

## 7.7 默认 strict MCP

不建议作为默认行为。

原因：

```text
用户目标是只切换全局配置，不动项目配置
strict MCP 可能忽略项目 MCP
容易造成“项目工具突然没了”的误解
```

结论：

```text
MVP 默认 merge，strict 只作为显式选项或后续能力。
```

---

## 8. 后续技术方向参考

## 8.1 Node.js CLI 继续演进

建议保持：

```text
Node.js CLI first
```

未来如果需要增强，可以考虑：

| 能力 | 可选技术 |
|---|---|
| 命令解析 | commander / cac / yargs |
| 彩色输出 | chalk / picocolors |
| 文件复制 | fs-extra |
| JSON 校验 | zod / ajv |
| 打包发布 | tsup / pkg |
| 测试 | vitest |
| 交互确认 | prompts / enquirer |

注意：

```text
MVP 阶段应避免过多依赖
优先保证 Windows 路径可靠
所有路径操作集中封装
launch 行为必须可 dry-run
```

---

## 8.2 PowerShell 辅助能力

后续可以提供：

```powershell
ccps alias study
```

生成：

```powershell
function cc-study {
  ccps launch study
}
```

更进一步可以提供：

```powershell
ccps alias --all
```

生成：

```powershell
function cc-coding { ccps launch coding }
function cc-study { ccps launch study }
function cc-work { ccps launch work }
function cc-research { ccps launch research }
function cc-general { ccps launch general }
```

默认不自动写入 PowerShell Profile。

---

## 8.3 Windows Terminal 集成

远期可以考虑生成 Windows Terminal profile。

示例目标：

```text
Claude Code - Coding
Claude Code - Study
Claude Code - Work
Claude Code - Research
```

风险：

```text
需要修改 Windows Terminal 配置
用户环境差异较大
不是核心需求
```

结论：

```text
放在远期，不进入 MVP。
```

---

## 9. 后续需求升级流程

如果未来要把附录中的某个功能升级为正式需求，建议流程：

```text
1. 先明确该功能解决的真实痛点
2. 判断是否已有手动替代方案
3. 判断是否影响安全边界
4. 判断是否会修改官方 Claude Code 配置
5. 判断是否影响项目配置保留原则
6. 写独立小 PRD 或 issue
7. 加入版本计划
8. 再进入实现
```

不建议直接因为“看起来有用”就加入主线。

---

## 10. 附录总结

CC-Profile-Switch 的长期方向可以扩展为更完整的 Claude Code profile 管理工具，但短期必须克制。

优先级判断：

```text
第一优先级：稳定、安全地切换用户级全局配置
第二优先级：保留项目配置原生行为
第三优先级：增强本地 profile 管理
第四优先级：增强诊断和行为验证
第五优先级：导入导出和模板复用
第六优先级：GUI / TUI / 生态化
```

核心边界始终不变：

```text
不做账号切换
不迁移 OAuth/session
不直接管理真实 C:\Users\h\.claude
不修改项目 .claude
不默认禁用项目配置
不把本地工具做成重型平台
```
