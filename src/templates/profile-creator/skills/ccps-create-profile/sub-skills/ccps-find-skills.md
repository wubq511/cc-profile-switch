---
name: ccps-find-skills
description: >
  子 Skill：为 ccps profile 发现、评估和安装高质量 skills。
  覆盖 skills.sh 生态和 Claude Code 官方渠道，包含完整的发现—筛选—安装—验证流程。
  由主 Skill ccps-create-profile 在阶段 4 中读取和使用。
---

# Profile Skills 发现与安装

你为 ccps profile 发现、评估和安装高质量的 skills。

本子 Skill 覆盖 skills.sh 生态和 Claude Code 官方渠道，包含完整的**发现—筛选—安装—验证**流程。

---

## 概念澄清：Skill / Plugin / MCP Server

**在开始之前，必须理解这三者的区别。它们不是同义词。**

| 概念 | 是什么 | 管理方式 | 安装位置 |
|---|---|---|---|
| **Skill** | 纯技能包（指令文件），告诉 Claude Code 如何做某事 | `npx skills` CLI | `skills/` 目录 |
| **Plugin** | 能力包，可包含 skills + agents + hooks + MCP server | `/plugin install` 内置命令 | Claude Code 插件系统 |
| **MCP Server** | 外部工具连接，让 Claude Code 调用外部 API/工具 | `claude mcp add` | `mcp.json` 配置 |

本子 Skill 只处理 **Skill** 类型。如果用户需要 plugin 或 MCP server，引导到对应的配置流程。

---

## CLI 命令参考

### 官方高置信命令

这些命令有官方文档支持，行为确定。

| 命令 | 用途 |
|---|---|
| `npx skills find [query]` | 搜索 skills |
| `npx skills find [query] --owner <owner>` | 限定来源搜索 |
| `npx skills add <package>` | 安装 skill |
| `npx skills list` | 列出已安装的 skills |
| `npx skills remove` | 移除已安装的 skill |

### 生态可验证命令

这些命令在生态中广泛使用和验证，但官方说明较少。

| 命令 | 用途 |
|---|---|
| `npx skills check` | 检查已安装 skills 的可用更新 |
| `npx skills update` | 批量更新已安装的 skills |

### 退出遥测

skills.sh 使用匿名安装遥测进行排行榜排名。如需退出：

```bash
DISABLE_TELEMETRY=1 npx skills add <package>
```

---

## 评分机制：评估 Skill 质量

**不要仅凭搜索结果就推荐 skill。** 使用以下三层评分机制综合判断。

### 第一层：目录热度（权重 40%）

来源：skills.sh 排行榜和搜索结果中的安装数。

| 安装量 | 评级 | 说明 |
|---|---|---|
| 10K+ | 优秀 | 广泛使用，经过大量实战验证 |
| 1K-10K | 良好 | 有稳定用户基础 |
| 100-1K | 一般 | 需结合来源信誉判断 |
| <100 | 谨慎 | 除非来源高度可信，否则不推荐 |

### 第二层：来源可信度（权重 40%）

从高到低排列：

1. **平台方** — `vercel-labs/`、`microsoft/`、`anthropics/` 等平台官方组织
2. **官方** — 产品官方团队维护的 skill 仓库
3. **垂直头部** — 特定领域知名开发者（如 `mattpocock/` 在 TypeScript 领域）
4. **普通个人** — 需要更多验证

已知高质量来源（持续更新）：
- `vercel-labs/agent-skills` — React, Next.js, Web 设计
- `vercel-labs/skills` — Vercel 生态工具链
- `anthropics/skills` — 前端设计、文档处理
- `microsoft/azure-skills` — Azure 云服务
- `mattpocock/skills` — TypeScript 进阶

### 第三层：运维质量（权重 20%）

通过源仓库评估：

| 指标 | 好 | 中 | 差 |
|---|---|---|---|
| GitHub Stars | 500+ | 100-500 | <100 |
| 最近更新 | 30 天内 | 90 天内 | 6 个月以上 |
| 文档质量 | README 详细、有示例 | 基本说明 | 无文档 |

### 综合评分

- **推荐**：三层均在"良好"以上，或热度 + 来源双优
- **可选**：两层"良好"，一层"一般"
- **不推荐**：任一层在"差"，或热度 + 来源双低

如果搜索结果全部在"不推荐"范围，告诉用户没有找到高质量匹配项，建议用 Skill Creator 创建自定义 skill。

---

## 发现渠道

除 skills.sh 外，还有以下渠道可以发现 skills：

1. **skills.sh 排行榜** — https://skills.sh/ — 按安装量排序的主流渠道
2. **Claude 官方插件目录** — https://claude.com/plugins — 注意：这里包含 plugin，不只是 skill
3. **Claude Code 官方文档** — 官方推荐的 skills
4. **特定产品官方页** — 如 Vercel、Microsoft 等在其产品文档中推荐的 skills

---

## 完整工作流程

### 第 1 步：理解需求

根据用户的 profile 用途，确定需要搜索什么类型的 skill。

映射表：

| Profile 类型 | 搜索方向 |
|---|---|
| 前端开发 | react, nextjs, typescript, css, tailwind, design-system |
| 后端开发 | api, nodejs, database, prisma, graphql |
| 测试 | testing, jest, playwright, e2e, vitest |
| DevOps | deploy, docker, kubernetes, ci-cd, aws |
| 文档写作 | docs, readme, changelog, technical-writing |
| 研究分析 | research, analysis, data, visualization |
| 代码质量 | review, lint, refactor, best-practices |
| 设计 | ui, ux, design-system, accessibility, figma |

### 第 2 步：多渠道发现

**不要只用一个渠道。** 按优先级依次搜索：

1. **查排行榜**：访问 https://skills.sh/，查看 profile 用途相关分类的热门 skills。
2. **定向搜索**：`npx skills find <keyword>`，尝试 2-3 个相关关键词。
3. **限定来源搜索**：`npx skills find <keyword> --owner <trusted-source>`，在可信来源中精确搜索。
4. **同义词扩展**：如果 "deploy" 没结果，试 "deployment"、"ci-cd"、"continuous-integration"。

### 第 3 步：质量筛选

对每个候选 skill 应用评分机制（见上方），按综合评分排序。

输出格式：

```
搜索 "<keyword>" 的结果评估：

推荐安装：
1. **skill-name** — 简要描述
   来源：owner/repo（XXK 安装 | GitHub XXX stars）
   评分：热度 优 | 来源 平台方 | 运维 良好
   链接：https://skills.sh/owner/repo/skill-name

可选考虑：
2. **skill-name** — 简要描述
   来源：owner/repo（XXK 安装 | GitHub XXX stars）
   评分：热度 良 | 来源 官方 | 运维 一般
   链接：https://skills.sh/owner/repo/skill-name

不推荐：
3. **skill-name** — 安装量过低（<100），来源不可验证
```

### 第 4 步：呈现给用户并确认

将筛选后的结果呈现给用户，要求确认：

```
找到以下高质量 skills：

推荐安装：
1. **react-best-practices** — React/Next.js 性能优化指南
   来源：vercel-labs/agent-skills（185K 安装）
   评分：热度 优 | 来源 平台方 | 运维 良好

2. **frontend-design** — 创建精美的 UI 组件
   来源：anthropics/skills（120K 安装）
   评分：热度 优 | 来源 平台方 | 运维 良好

要安装哪些？（输入编号，或 'all' / 'none'）
```

**必须等用户确认后才能安装。不安装用户未确认的 skills。**

### 第 5 步：安装前安全检查

在执行安装命令之前，逐项检查：

- [ ] **目标路径正确** — 确认是 `<profile>/claude-home/skills/`，不是 `~/.claude/skills/`
- [ ] **不使用 `-g`** — 禁止全局安装，会污染 `~/.claude/skills/`
- [ ] **不修改全局目录** — 不触碰 `~/.claude/`、`~/.codex/`、`~/.windsurf/` 等
- [ ] **不安装到项目目录** — 不安装到项目 `.claude/skills/`（那是项目级，不是 profile 级）
- [ ] **用户已确认** — 用户明确选择了要安装的 skill

### 第 6 步：安装到 Profile

对用户确认的每个 skill 执行：

```bash
CLAUDE_CONFIG_DIR=<profile>/claude-home npx skills add <owner/repo@skill> -a claude-code -y
```

参数说明：
- `CLAUDE_CONFIG_DIR=<profile>/claude-home` — 重定向安装目标到 profile 的 skills 目录
- `-a claude-code` — 只安装到 Claude Code，不影响 Codex、Windsurf、Copilot
- `-y` — 跳过确认提示

**已知限制**：`CLAUDE_CONFIG_DIR` + `-a claude-code` 组合在某些环境下不一定按预期工作。如果验证步骤发现安装位置不正确，回退到手动下载方案（见下方）。

### 第 7 步：验证安装

安装后必须验证，不要假设安装成功。

**步骤 7a：检查文件是否安装到正确位置**

```bash
ls <profile>/claude-home/skills/
```

预期：能看到新安装的 skill 文件。

**步骤 7b：检查未污染全局目录**

```bash
ls ~/.claude/skills/
```

预期：全局 skills 目录**不应**有新增文件。

**步骤 7c：检查 skill 文件内容**

```bash
cat <profile>/claude-home/skills/<skill-name>.md | head -5
```

预期：文件存在且内容是有效的 skill 定义（有 frontmatter）。

### 第 8 步：报告结果

告诉用户：
- 安装了哪些 skills
- 每个 skill 的用途
- 安装位置
- 是否有任何异常

---

## 手动下载方案（回退）

当 `npx skills add` 的 `CLAUDE_CONFIG_DIR` 机制不按预期工作时，使用手动下载：

1. 从 skill 的 GitHub 仓库获取 `.md` 源文件
2. 直接写入 `<profile>/claude-home/skills/<skill-name>.md`
3. 验证文件内容完整

这是最安全的安装方式，完全绕开 skills CLI 的路径解析问题。

---

## 未找到 Skills 时

如果搜索没有高质量结果：

1. 告诉用户没有找到匹配的 skill
2. 建议使用 Skill Creator 创建自定义 skill
3. 或者跳过 skills 配置，直接进入下一步
