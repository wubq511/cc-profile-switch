# CLAUDE.md 参考模板 — 技术写作

> 本文件是 CLAUDE.md 生成参考，不要原样复制。根据用户文档的实际类型和发布平台裁剪。

---

```markdown
# <文档项目名称>

## 文档概述

<一句话说明这是什么文档、面向什么读者。>

文档类型：产品文档 / API 文档 / 教程 / 博客 / 知识库
发布平台：<网站> / <Wiki> / <静态站点生成器>

## 命令面板

```bash
# 本地预览
npm run dev / mkdocs serve / docusaurus start / mintlify dev

# 构建
npm run build / mkdocs build

# 检查
npm run lint               # Markdown lint
npm run check:links        # 死链检查
npm run check:nav          # 导航一致性检查
npm run format             # Prettier/markdownlint 格式化

# 发布前完整检查
npm run pre-publish        # lint + links + nav + build 全流程
```

所有命令必须可直接复制运行。Push 前必须跑完 `pre-publish`。

## 写作风格

### 语言

- American English，不用 British English（用 color 不用 colour，用 organize 不用 organise）。
- 第二人称祈使句为主："Configure the server" 而非 "The server should be configured"。
- 主动语态优先："The API returns a JSON object" 而非 "A JSON object is returned by the API"。
- 删除 filler words：去掉 "basically"、"simply"、"just"、"note that"、"it should be noted"。
- 缩写首次出现时展开：Application Programming Interface (API)，之后直接用 API。

### 句子和段落

- 一句话一个信息。复合句拆成两句。
- 段落不超过 4 句。超过就分段或用列表。
- 步骤类内容用编号列表，非步骤类用无序列表。
- 数字：1-9 用英文单词（one, two），10 以上用数字（42）。
- 行内代码用反引号标记：文件名、命令、变量名、API 端点、配置值。

### 语气

- 直接、精确、不废话。
- 不用 "please"、"thank you"。
- 不用感叹号。
- 不用 "easy"、"simple"、"straightforward"——对读者来说可能并不简单。

## 文档结构

### Frontmatter

每篇文档必须有 frontmatter，至少包含：

```yaml
---
title: "精确的页面标题"
description: "一句话摘要，用于 SEO 和社交分享"
---
```

可选字段：`sidebar_label`、`sidebar_position`、`keywords`、`last_updated`。

### 导航

- 新增页面必须同步更新导航文件（sidebar / SUMMARY.md / mkdocs.yml）。
- 导航层级不超过 3 层。超过就重组目录结构。
- 页面标题和导航标题保持一致（除非有明确的简化理由）。

### 内容组织

```
docs/
  getting-started/       # 入门指南，新手最先读
  guides/                # 操作指南，按任务组织
  concepts/              # 概念解释，帮助理解
  api-reference/         # API 文档，精确完整
  tutorials/             # 教程，端到端场景
  changelog/             # 变更日志
```

## 内容规则

1. **一篇文章只解决一个问题。** 标题就是读者会搜索的问题。如果一篇文章讲了三件事，拆成三篇。
2. **开头一句话说清楚"这篇文章教你什么"。** 读者扫 3 秒就决定要不要继续看。不要用历史背景或定义开头。
3. **代码示例必须完整可运行。** 不要省略 import、不要省略配置、不要写 `// ...`。读者复制粘贴就能跑。
4. **每张图都必须有 alt text 和说明文字。** 图片不能传递纯文字应该传递的信息——图片是辅助，不是替代。
5. **链接必须有描述性文字。** 不要写 "click here" 或 "this page"，直接用链接目标的标题作为链接文字。

## 非协商规则

1. **Push 前必须跑完 lint + 死链检查 + 导航检查。** CI 挂了就是你的问题。`npm run pre-publish` 必须通过才能 push。
2. **所有用户可见的示例代码必须经过验证。** 不要写"理论上应该这样"的代码。手动运行确认输出正确。
3. **Changelog 每条必须关联版本号和日期。** 遵循 Keep a Changelog 格式。不写 changelog 的 PR 不合并。
4. **不猜 DOI、不编造引用。** 学术引用必须来自真实来源并可核验。URL 必须可访问。
5. **不复制粘贴其他文档站点的内容。** 可以参考结构和写法，但内容必须用自己的话重写，适配自己的产品。

## 验证清单

提交 PR 前自查：

- [ ] 所有新增页面已加入导航
- [ ] 所有链接可访问（死链检查通过）
- [ ] 代码示例手动运行过
- [ ] frontmatter 包含 title 和 description
- [ ] 拼写检查通过
- [ ] 图片有 alt text
- [ ] 格式化检查通过

## Scoped Guidance

以下主题建议拆分为独立 Skill/Rules 文件，按需加载：

- **API 文档规范**：OpenAPI/Swagger 生成、endpoint 描述模板、示例代码规范 -> `skills/api-docs-rules.md`
- **Changelog 规范**：Keep a Changelog 格式、变更分类、Breaking Change 标注 -> `skills/changelog-rules.md`
- **SEO 优化**：meta 描述、关键词策略、结构化数据 -> `skills/seo-rules.md`
- **多语言文档**：翻译流程、语言切换导航、翻译一致性 -> `skills/i18n-docs-rules.md`
- **图表规范**：Mermaid/D2 图表语法、截图标准、动图规范 -> `skills/diagram-rules.md`
```

---

## 使用说明

- 替换所有 `<占位符>` 为实际内容
- 写作风格部分根据团队偏好调整（如是否允许 British English）
- 内容规则和非协商规则必须具体到可验证
- 验证清单是给用户手动检查的，每条对应一个可判断的条件
- Scoped Guidance 列出扩展主题但不展开
- 总行数控制在 100-150 行
