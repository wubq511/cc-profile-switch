---
name: ccps-audit-profile
description: >
  子 Skill：审查已有 ccps profile 的完整度和质量，给出具体改进建议。
  由主 Skill ccps-create-profile 在需要审查/优化已有 profile 时读取和使用。
  也可独立使用：当用户说"审查 profile"、"检查 profile 质量"、"audit profile"、
  "profile 哪里需要改进"时触发。
---

# Profile 审查指南

你审查一个已有的 ccps profile，从文件完整性、配置质量、CLAUDE.md 内质量三个维度打分并给出具体可操作的改进建议。

---

## 工作流程

### 步骤 1：定位 Profile

如果用户指定了 profile 名称，直接使用。否则先运行：

```bash
ccps list
```

列出所有 profile，让用户选择要审查的那个。如果只有一个非 default 的 profile，直接审查它。

确认 profile 名称后，确定路径：

- macOS / Linux: `~/.cc-profile-switch/profiles/<name>/`
- Windows: `%USERPROFILE%\.cc-profile-switch\profiles\<name>\`

后续所有路径基于此根目录。用 `<profile>` 指代。

### 步骤 2：信息收集

并行读取以下文件（存在的读内容，不存在的标记缺失）：

1. `<profile>/profile.json`
2. `<profile>/claude-home/CLAUDE.md`
3. `<profile>/claude-home/settings.json`
4. `<profile>/claude-home/rules/ccps-profile.md`
5. `<profile>/claude-home/memory/auto/MEMORY.md`（可选，自动记忆）

不要直接读取 `<profile>/claude-home/.claude.json`。使用目标 profile 的原生 MCP CLI
查看不含配置详情的连接列表。

macOS、Linux 或 Git Bash：

```bash
env CLAUDE_CONFIG_DIR="<profile>/claude-home" claude mcp list
```

Windows PowerShell：

```powershell
$previousClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
try {
  $env:CLAUDE_CONFIG_DIR = 'C:\absolute\profile\claude-home'
  claude mcp list
} finally {
  if ($null -eq $previousClaudeConfigDir) {
    Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  } else {
    $env:CLAUDE_CONFIG_DIR = $previousClaudeConfigDir
  }
}
```

并运行：

```bash
ccps validate <name>
ccps show <name>
```

### 步骤 3：逐项审查

按以下六个维度审查，每项给出 ✅/⚠️/❌ 状态。

### 步骤 4：生成报告

按下方输出格式生成完整审查报告。

---

## 审查清单

### 维度一：文件完整性

检查所有必需文件和目录是否存在。

| 检查项                                      | 检查方法                  | 判定                             |
| ------------------------------------------- | ------------------------- | -------------------------------- |
| `profile.json` 存在且有效 JSON              | 读取文件，尝试 JSON.parse | 缺失 = ❌，无效 JSON = ❌        |
| `claude-home/CLAUDE.md` 存在                | 检查文件是否存在          | 缺失 = ❌                        |
| `claude-home/settings.json` 存在且有效 JSON | 读取文件，尝试 JSON.parse | 缺失 = ❌，无效 JSON = ❌        |
| `claude-home/rules/ccps-profile.md` 存在    | 检查 ccps 托管边界规则    | 缺失 = ⚠️，运行 `ccps init` 修复 |
| `claude-home/memory/auto/` 目录存在         | 检查目录是否存在          | 缺失 = ⚠️                        |
| `claude-home/skills/` 目录存在              | 检查目录是否存在          | 缺失 = ⚠️                        |
| `claude-home/agents/` 目录存在              | 检查目录是否存在          | 缺失 = ⚠️                        |
| `ccps validate` 通过                        | 运行命令检查输出          | 有错误 = ❌，有警告 = ⚠️         |

### 维度二：CLAUDE.md 质量

逐项检查 CLAUDE.md 的内容质量。读取文件全文后评估。

| 检查项                   | 检查方法                                                                                                                                            | 判定                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Identity/Role 定义**   | 是否有明确说明这个 profile 的角色定位和适用场景。搜索 `## Identity`、`## Role`、`## 关于` 等章节，或文件开头是否有清晰的角色描述                    | 有 = ✅，无 = ❌                                                                    |
| **Commands 章节**        | 是否有可执行命令列表（build/test/run/lint 等）。搜索 `## Command`、`## 命令`、`## Workflow`，检查是否包含实际可执行的 shell 命令                    | 有且含具体命令 = ✅，有但模糊 = ⚠️，无 = ❌                                         |
| **目录/架构说明**        | 是否描述了项目结构或工作对象的组织方式。搜索 `## Structure`、`## 目录`、`## Architecture`、`## 架构`，或代码块中的 tree 结构                        | 有 = ✅，无 = ⚠️                                                                    |
| **非协商规则**           | 是否有明确的禁止事项或硬性约束。搜索 `## Constraint`、`## 禁止`、`## 规则`、`## Rules`、`## Anti-pattern`，检查是否有"不要/禁止/必须/NEVER"等关键词 | 有且具体 = ✅，有但模糊 = ⚠️，无 = ❌                                               |
| **测试/验证规范**        | 是否说明了如何验证改动。搜索 `## Test`、`## 测试`、`## 验证`，检查是否包含具体测试命令                                                              | 有且含命令 = ✅，有但模糊 = ⚠️，无 = ⚠️（非 coding profile 可不强制）               |
| **Scoped Guidance 入口** | 是否指向更细粒度的 rules 或 skill。检查 `@path` 引用或 `.claude/rules/` 提示                                                                        | 有 = ✅，无 = ⚠️（加分项）                                                          |
| **长度合理性**           | 统计行数                                                                                                                                            | 100-200 行 = ✅，<100 行 = ⚠️（可能太抽象），>300 行 = ⚠️（考虑拆分），>500 行 = ❌ |
| **无空话**               | 检查是否包含无法验证的模糊表述。关键词："保持整洁"、"适当测试"、"合理组织"、"尽量优化"、"好的实践"、"注意质量"                                      | 无空话 = ✅，少量 = ⚠️，大量 = ❌                                                   |
| **无通用知识**           | 检查是否包含 Claude 已经知道的通用编程知识（如"变量名要有意义"、"函数不要太长"、"写注释"）。这些不提供价值，浪费上下文                              | 无 = ✅，少量 = ⚠️，大量 = ❌                                                       |
| **无流程堆砌**           | 检查是否有超过 10 步的详细流程应拆为独立 Skill。多步骤流程（如部署流程、发布流程、完整 CI 配置步骤）应作为 Skill 按需加载                           | 无长流程 = ✅，有但短 = ⚠️，有长流程 = ❌                                           |

### 维度三：settings.json 质量

读取 `<profile>/claude-home/settings.json`，逐项检查。

| 检查项                             | 检查方法                                                                                                                                    | 判定                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **autoMemoryDirectory**            | 检查值是否为 `<profile>/claude-home/memory/auto`（绝对路径）                                                                                | 正确 = ✅，缺失或路径错误 = ❌                  |
| **CLAUDE_CODE_ATTRIBUTION_HEADER** | 检查 `env.CLAUDE_CODE_ATTRIBUTION_HEADER` 是否为 `"0"`                                                                                      | 存在且为 "0" = ✅，缺失 = ⚠️，值不对 = ❌       |
| **env 变量合理性**                 | 检查 `env` 对象中的所有键值对。值必须是字符串。不应包含 API 密钥或 token。常见合理变量：`CLAUDE_CODE_MAX_TURNS`、`NODE_ENV`、自定义路径变量 | 全部合理 = ✅，有可疑项 = ⚠️，含密钥/token = ❌ |
| **permissions 匹配用途**           | 根据 profile 的 template 和 description 判断 permissions 是否合理。coding profile 通常需要更宽松的权限，research/writing profile 应更严格   | 匹配 = ✅，不匹配 = ⚠️                          |

### 维度四：profile.json 质量

读取 `<profile>/profile.json`，逐项检查。

| 检查项                   | 检查方法                                                                                                                                                   | 判定                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **description 有意义**   | `description` 字段不为空且描述了 profile 的具体用途，不是"默认 profile"或"测试"之类的占位符                                                                | 有意义 = ✅，空或占位 = ⚠️                        |
| **template 匹配用途**    | `template` 值（coding/study/work/research/general/blank）是否与 profile 实际用途匹配                                                                       | 匹配 = ✅，不匹配 = ⚠️                            |
| **skipPermissions 合理** | coding/work profile: `true`（频繁操作，确认影响效率）。study/research/writing profile: `false`（低风险，保持确认更安全）                                   | 合理 = ✅，不合理 = ⚠️                            |
| **legacy mcpMode 合理**  | 只在旧 `<profile>/mcp.json` 实际含 server 时评估。新 profile 的 user-scope MCP 不依赖该字段                                                                | 无旧文件用 `none` = ✅；有旧 server 用 `merge` = ✅；无理由使用 `strict` = ⚠️ |
| **JSON schema 合规**     | 字段必须符合 `profileConfigSchema`：name、description、template、launch（mcpMode/pluginDirs/disableAutoMemory/skipPermissions/claudeArgs）。不应有额外字段 | 合规 = ✅，有多余字段 = ⚠️，缺少必需字段 = ❌     |

### 维度五：MCP 配置

使用目标 `CLAUDE_CONFIG_DIR` 运行 `claude mcp list`。不要直接读取 `.claude.json`。不要在 Agent 可见的终端运行 `claude mcp get`：当前 Claude Code 版本可能回显存储的 environment
或 header secret。server 的 scope、transport 和环境变量名只使用不含 secret 的创建计划或用户提供的信息审查。

| 检查项               | 检查方法                                                                                                                                                   | 判定                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **目标 scope 正确**  | 确认 server 在目标 profile 的 `user` scope，而不是真实 user config 或误放的 project scope                                                                  | 正确 = ✅，scope 错误 = ❌            |
| **服务器与用途相关** | 根据 profile 的 template/description 列出已配置的 MCP 服务器，判断是否与用途相关。如 coding profile 配了数据库 MCP 是合理的，但配了 Twitter MCP 可能不相关 | 相关 = ✅，部分相关 = ⚠️，不相关 = ❌ |
| **Secret 未泄漏**    | 只检查所需环境变量名与认证方式，不读取或展示值                                                                                                             | 无明文 = ✅，命令/文档含明文 = ❌     |
| **命令和参数有效**   | 检查每个 MCP server 的 `command` 和 `args` 是否合理（如 `npx`、`node`、`python` 等合法命令）                                                               | 有效 = ✅，可疑 = ⚠️                  |

### 维度六：Skills/Agents

检查 `<profile>/claude-home/skills/` 和 `<profile>/claude-home/agents/` 目录。

| 检查项               | 检查方法                                                                                        | 判定                                 |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| **skills/ 目录内容** | 列出目录下所有文件。检查是否有 skill 文件（`.md`），是否与 profile 用途相关                     | 有且相关 = ✅，为空 = ⚠️（建议配置） |
| **agents/ 目录内容** | 列出目录下所有文件。检查是否有 agent 文件（`.md`），是否与 profile 用途相关                     | 有且相关 = ✅，为空 = ⚠️（建议配置） |
| **内容质量**         | 如果有 skill/agent 文件，快速检查：是否有 frontmatter（name/description）、是否有明确的指令内容 | 质量好 = ✅，质量差 = ⚠️             |

---

## 评分标准

### 完整度评分（0-10）

基于文件完整性维度的所有检查项：

| 分数 | 标准                                               |
| ---- | -------------------------------------------------- |
| 10   | 所有必需文件存在且有效，所有可选目录存在           |
| 8-9  | 所有必需文件存在且有效，少量可选目录缺失           |
| 6-7  | 必需文件存在但有 JSON 格式问题，或缺失部分可选目录 |
| 4-5  | 缺失 1-2 个必需文件                                |
| 0-3  | 大量必需文件缺失                                   |

### 质量评分（0-10）

基于维度二到维度六的所有检查项：

| 分数 | 标准                           |
| ---- | ------------------------------ |
| 10   | 所有维度全部 ✅                |
| 8-9  | 绝大多数 ✅，少量 ⚠️（非关键） |
| 6-7  | 有 ⚠️ 但无 ❌                  |
| 4-5  | 有 1-2 个 ❌                   |
| 0-3  | 多个 ❌                        |

---

## 输出格式

```markdown
# Profile 审查报告：<name>

## 总评

- 完整度：X/10
- 质量：X/10
- 建议数量：N

## 发现

### ✅ 通过项

- [维度] 检查项：简要说明
- ...

### ⚠️ 建议改进

- [维度] 检查项：问题描述
  - **建议**：具体改进建议
- ...

### ❌ 必须修复

- [维度] 检查项：问题描述
  - **修复**：具体修复步骤和命令/内容
- ...

## 具体修复建议

按优先级排列，每条给出：

1. 问题是什么
2. 为什么重要
3. 怎么修（具体的命令、文件路径、内容片段）

4. **[修复标题]**
   - 问题：...
   - 影响：...
   - 修复：
```

具体命令或内容

```

2. ...
```

---

## 具体修复建议模板

以下是常见问题的修复建议模板。审查时根据实际情况选用和调整。

### CLAUDE.md 缺少 Identity/Role

```markdown
## Identity & Role

你是 [具体角色描述]。你的主要职责是 [具体职责]。
你在这个 profile 中关注 [具体关注点]。
```

### CLAUDE.md 缺少 Commands

```markdown
## Commands

# 开发

npm run dev # 启动开发服务器
npm run build # 构建生产版本

# 验证

npm test # 运行测试
npm run lint # 代码检查
npm run check # 全部检查（lint + test + build）
```

### CLAUDE.md 包含空话

**识别方法：** 搜索以下关键词并检查上下文是否可验证：

- "保持整洁" → 改为 "每个文件不超过 300 行，超过时按模块拆分"
- "适当测试" → 改为 "修改后运行 `npm test`，新增功能必须有对应测试用例"
- "好的实践" → 改为具体的实践规则
- "合理组织" → 改为 "按 `<具体目录结构>` 组织文件"

### settings.json 缺少 CLAUDE_CODE_ATTRIBUTION_HEADER

```json
{
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

### settings.json autoMemoryDirectory 路径错误

修复为正确的绝对路径：

- macOS / Linux: `~/.cc-profile-switch/profiles/<name>/claude-home/memory/auto`
- Windows: `C:\Users\<username>\.cc-profile-switch\profiles\<name>\claude-home\memory\auto`

### profile.json description 为空

```json
{
  "description": "<根据 profile 的实际用途填写，50字以内描述>"
}
```

### MCP 配置包含硬编码密钥

不要在报告中复制密钥。先让用户轮换已暴露的值，再通过目标 profile 的
`claude-home/settings.json` `env` 或 OAuth 流程提供认证；MCP CLI 和报告中只出现变量名。

### Skills/Agents 目录为空

根据 profile 用途推荐：

**Coding profile 推荐 skills：**

- 代码审查 skill
- 测试生成 skill
- 性能分析 skill

**Writing profile 推荐 skills：**

- 技术写作 skill
- 审校清单 skill

**Research profile 推荐 skills：**

- 文献检索 skill
- 数据分析 skill

安装命令：

```bash
CLAUDE_CONFIG_DIR=<profile>/claude-home npx skills add <source> -a claude-code -y
```

---

## 重要约束

- 只读审查，不修改任何文件。修复建议以文字形式给出，由用户决定是否执行。
- 不读写真实的 `~/.claude` 目录。
- 不检查 API 密钥的有效性，只检查是否存在硬编码。
- 不检查 `plugins/`、`projects/`、`sessions/` 目录（Claude Code 自动管理）。
- 审查完成后，询问用户是否需要我帮忙执行任何修复建议。
