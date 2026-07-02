---
name: ccps-configure-mcp
description: >
  子 Skill：为 ccps profile 配置 MCP 服务器。
  由主 Skill ccps-create-profile 在阶段 6 中读取和使用。
---

# Profile MCP 配置指南

你为 ccps profile 配置 MCP (Model Context Protocol) 服务器。

## MCP 核心概念

MCP 是开放协议，让 Claude Code 连接外部工具、资源和提示模板。配置存放在 `<profile-root>/mcp.json`。

MCP server 可暴露三类能力：
- **Tools**：可调用的函数（搜索、数据库查询、API 调用等）
- **Resources**：可读取的数据源
- **Prompts**：预定义的提示模板

## Transport 选择指南

| Transport | type 值 | 推荐度 | 适用场景 | 说明 |
|---|---|---|---|---|
| 远程 HTTP (Streamable HTTP) | `http` | 推荐 | 大多数远程服务 | 官方推荐方式，支持认证 header |
| 本地 stdio | `stdio` | 推荐 | 本地工具、CLI 封装 | 通过子进程通信，无需网络 |
| 远程 SSE | `sse` | 已废弃 | 不推荐新配置 | 已被 HTTP 取代，仅保留向后兼容 |
| 远程 WebSocket | `ws` | 特殊场景 | 需要持久双向连接 | 少数服务专用 |

**选择原则**：远程服务优先用 `http`，本地工具用 `stdio`，避免 `sse`。

## mcpMode 说明

> **注意**：`mcpMode` 是 ccps 自己的启动抽象，不是 Claude Code 官方公开字段。

profile.json 中的 `launch.mcpMode` 控制 ccps 如何传递 MCP 配置：

| 模式 | ccps 行为 | 映射 | 适用场景 |
|---|---|---|---|
| `merge` | Profile MCP + 项目 MCP 都传递 | 默认合并行为 | 大多数场景（默认） |
| `strict` | 只传递 Profile MCP | `--strict-mcp-config` | 隔离环境 |
| `none` | 不传递 Profile MCP | ccps 推断型建模 | 不需要 MCP |

## 配置格式

### 远程 HTTP MCP（推荐）

```json
{
  "mcpServers": {
    "example-http": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

### 动态 Header HTTP MCP

适用于需要短期 token 或复杂认证流程的场景：

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.internal.example.com",
      "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
    }
  }
}
```

### 本地 stdio MCP

```json
{
  "mcpServers": {
    "example-stdio": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@scope/package"],
      "env": {
        "CACHE_DIR": "/tmp/server-cache"
      }
    }
  }
}
```

### 环境变量展开

支持 `${VAR}` 和 `${VAR:-default}` 语法，运行时自动替换：

```json
{
  "url": "${API_BASE_URL:-https://api.example.com}/mcp",
  "headers": {
    "Authorization": "Bearer ${API_KEY}"
  }
}
```

## MCP 服务器推荐（按官方验证级别）

### 高置信（有官方插件页）

#### 文档和知识

| 服务器 | 用途 | 工具 | 推荐场景 |
|---|---|---|---|
| Context7 | 最新库文档与代码样例 | resolve-library-id, query-docs | 使用流行库（React, Express, Prisma 等） |
| Exa | AI 网络搜索、深度研究、内容提取 | web search, deep research | 研究任务、需要最新信息 |

#### 浏览器和前端

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Playwright | 通过 accessibility data 做浏览器自动化 | 前端项目、E2E 测试 |

#### 数据库

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Supabase | 20+ 工具，覆盖数据库、项目管理、后端 | 使用 Supabase 的项目 |
| Neon | 管理 Neon projects 与 databases | 使用 Neon 无服务器 Postgres |
| Prisma（Postgres） | 数据库管理、migrations、SQL 查询 | 使用 Prisma ORM 的项目 |

#### 版本控制和项目管理

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| GitHub | 管理仓库、issue、PR、workflow | GitHub 仓库 |
| GitLab | repo、merge request、CI/CD、issues、wiki | GitLab 仓库 |
| Linear | issue/project/status/workspace 级能力 | 使用 Linear 的团队 |

#### 云基础设施

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Vercel | 管理 deployments、builds、logs、domains | Vercel 部署 |
| Cloudflare | Workers、Durable Objects、Agents SDK | Cloudflare 用户 |

#### 监控和通信

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Sentry | 错误分析与生产问题排查 | 使用 Sentry 的项目 |
| Datadog | 直接查询 logs、metrics、traces、dashboards | 使用 Datadog 的项目 |
| Slack | 消息、频道、搜索 | 使用 Slack 的团队 |
| Notion | workspace 搜索、page/database 读写 | 使用 Notion 的团队 |
| Chrome DevTools | performance trace、network request 分析 | 前端性能调优 |

### 中等置信（第三方目录可验证）

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Brave Search | web/news/image/video/local search，需 BRAVE_API_KEY | 需要网络搜索的场景 |

### 候选生态项（证据较弱，使用前请自行验证）

| 服务器 | 用途 | 推荐场景 |
|---|---|---|
| Convex | Convex 后端集成 | 使用 Convex 的项目 |
| Turso | 边缘 SQLite 数据库 | 使用 Turso 的项目 |
| Docker | 容器管理 | Docker 工作流 |
| Kubernetes | 集群管理 | K8s 部署 |

## 场景化推荐组合

根据 profile 用途选择合适的 MCP 组合，避免盲目叠加。

### 开发包（全栈开发）

适用于日常编码、调试、部署。

```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/playwright-mcp"]
    }
  }
}
```

### 研究包（调研、写作、分析）

适用于深度研究、信息收集、文档写作。

```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "exa": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "exa-mcp-server"],
      "env": {
        "EXA_API_KEY": "${EXA_API_KEY}"
      }
    },
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

### 协作包（团队协作、项目管理）

适用于团队开发、issue 追踪、沟通协作。

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    },
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp"
    }
  }
}
```

## 配置流程

### 第 1 步：分析技术栈

根据用户的 profile 用途和提到的技术栈，推荐合适的 MCP 服务器。
只推荐真正相关的，不要推荐所有可用的。

### 第 2 步：选择 transport

根据服务器类型选择 transport：
- 远程服务（有 HTTP 端点）：用 `type: "http"`
- 本地 npm 包或 CLI 工具：用 `type: "stdio"` + `npx -y`
- 避免使用 `sse`

### 第 3 步：呈现推荐

```
根据你的技术栈，推荐以下 MCP 服务器：

1. **Context7** (stdio) — 实时查询 React/TypeScript/Tailwind 文档
   价值：避免 Claude 使用过时的 API

2. **Playwright** (stdio) — 浏览器自动化和 E2E 测试
   价值：可以直接在浏览器中测试 UI

要配置哪些？
```

### 第 4 步：生成 mcp.json

用户确认后，更新 `<profile-root>/mcp.json`。

示例（stdio 为主）：

```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/playwright-mcp"]
    }
  }
}
```

**注意**：保留已有的 mcpServers 配置，用 Edit 工具合并新服务器。

### 第 5 步：更新 profile.json（如果需要）

如果用户需要 strict 模式，更新 profile.json 的 `launch.mcpMode`。
默认使用 `merge`，不需要更改。

### 第 6 步：健康检查

配置完成后，验证 MCP 服务器是否正常工作：

1. **CLI 验证**：
   ```bash
   claude mcp list          # 列出已配置的 MCP 服务器
   claude mcp get <name>    # 查看特定服务器详情
   ```

2. **交互验证**：启动 Claude Code 后使用 `/mcp` 命令检查：
   - 连接状态是否为 connected
   - 工具数量是否正确
   - 认证状态是否通过（如有 OAuth）

3. **OAuth 服务器**：如需认证，使用 `claude mcp login <name>` 完成授权。

## 重要约束

- 不添加用户未确认的 MCP 服务器
- 不在 mcp.json 中写入真实的 API key、token 或密码，使用 `${VAR}` 变量
- 默认使用 `merge` 模式，不随意改为 `strict`
- stdio 类型使用 `npx -y` 包名格式，确保自动安装
- 远程服务优先推荐 `http` transport，不推荐 `sse`（已废弃）
