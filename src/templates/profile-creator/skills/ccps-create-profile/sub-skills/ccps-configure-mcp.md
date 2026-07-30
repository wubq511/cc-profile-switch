---
name: ccps-configure-mcp
description: >
  子 Skill：为目标 ccps profile 配置 Claude Code 原生 user-scope MCP 服务器。
  由主 Skill ccps-create-profile 在阶段 6 中读取和使用。
---

# Profile MCP 配置指南

你为目标 ccps profile 配置 MCP (Model Context Protocol) 服务器。

## 配置边界

Claude Code 当前有三种常用 MCP scope：

| Scope     | 用途                     | Claude Code 存储位置                         | ccps 中的用法                  |
| --------- | ------------------------ | -------------------------------------------- | ------------------------------ |
| `user`    | 当前 profile 跨项目使用  | `$CLAUDE_CONFIG_DIR/.claude.json`            | **profile MCP 的正确 scope**   |
| `project` | 团队共享、提交到项目仓库 | 当前项目根目录 `.mcp.json`                   | 仅在用户明确要求项目共享时使用 |
| `local`   | 当前用户、当前项目私有   | `$CLAUDE_CONFIG_DIR/.claude.json` 的项目条目 | 不用于 profile-wide 配置       |

`settings.json` 不支持 `mcpServers`。不要把 MCP 写入：

- 真实的 `~/.claude/settings.json` 或 `~/.claude.json`
- `<profile>/mcp.json`
- `<profile>/claude-home/.mcp.json`
- `<profile>/claude-home/settings.json` 的 `mcpServers`

旧 profile 根目录可能保留 `mcp.json`。这是 ccps 的 legacy `--mcp-config` 兼容文件，不是新 MCP 的写入目标。

## 最重要的执行规则

当前会话运行在 `profile-creator` 自己的 `CLAUDE_CONFIG_DIR` 下。直接执行：

```bash
claude mcp add --scope user ...
```

会改错 profile。为目标 profile 执行任何 `claude mcp` 命令时，必须按当前平台显式覆盖。

macOS、Linux 或 Git Bash：

```bash
env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" claude mcp ...
```

Windows PowerShell：

```powershell
$previousClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
try {
  $env:CLAUDE_CONFIG_DIR = 'C:\absolute\profile\claude-home'
  claude mcp ...
} finally {
  if ($null -eq $previousClaudeConfigDir) {
    Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  } else {
    $env:CLAUDE_CONFIG_DIR = $previousClaudeConfigDir
  }
}
```

先解析目标 profile 的绝对路径，不依赖相对路径，不永久修改用户或 shell 环境。

## Transport 选择

| Transport | 适用场景                  | 选择               |
| --------- | ------------------------- | ------------------ |
| `http`    | 官方提供远程 MCP endpoint | 优先               |
| `stdio`   | 本地 CLI 或 npm/pip 包    | 需要本地进程时使用 |
| `sse`     | 旧服务兼容                | 新配置避免使用     |

不要根据名称猜 endpoint、包名或参数。先查 MCP 提供方的官方安装文档，再构造命令。

## 命令格式

Claude Code 要求所有 Claude 选项放在 server name 前面。

### HTTP

```bash
env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" \
  claude mcp add --scope user --transport http <name> <url>
```

### stdio

```bash
env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" \
  claude mcp add --scope user --transport stdio <name> -- <command> <args...>
```

### 查看、验证、删除

```bash
env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" claude mcp list
env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" claude mcp remove <name>
```

不要在 Agent 可见的终端运行 `claude mcp get`。当前 Claude Code 版本可能原样打印 server
environment 或 header 中的 secret。`claude mcp list` 与重启后的 `/mcp` 足以验证名称和连接状态。

## Secret 处理

- 不要求用户把 API key、token 或密码粘贴到聊天中。
- 不把 secret 放进文档、CLAUDE.md、Skill、命令示例或 project `.mcp.json`。
- 如果 stdio server 从进程环境读取 key，把对应环境变量放在目标 profile 的 `claude-home/settings.json` `env` 中，并在回复和日志里只显示变量名。
- 不使用包含真实 secret 的 `-e KEY=value` 命令，因为命令和 `.claude.json` 都可能留下明文。
- OAuth MCP 优先使用远程 HTTP endpoint，并让用户在目标 profile 启动后通过 `/mcp` 完成交互认证。

## 配置流程

### 1. 确认目标和 scope

确认用户要的是：

- 目标 profile 跨项目使用 → `user`
- 当前项目团队共享 → `project`，退出本流程并明确说明会修改项目根 `.mcp.json`

没有明确要求 project scope 时，一律使用目标 profile 的 `user` scope。

### 2. 核对官方配置

确认：

- transport
- 官方 URL 或包名
- 所需环境变量名
- OAuth/认证方式
- 最低 Claude Code 或 runtime 版本

### 3. 展示不含 secret 的计划

只展示 server 名、transport、来源和环境变量名。用户确认 server 后再执行。

### 4. 写入目标 profile

使用目标 `CLAUDE_CONFIG_DIR` 执行 `claude mcp add --scope user`。不要直接编辑 `.claude.json`。

### 5. 验证写入位置和内容

使用同一目标 `CLAUDE_CONFIG_DIR` 执行 `claude mcp list`。不要运行会回显存储配置的
`claude mcp get`。

```bash
claude mcp list
```

只报告 server 名和连接状态。scope、transport、来源和环境变量名来自执行前已经确认的不含
secret 的计划，不通过读取 `.claude.json` 或回显存储配置再次推断。

### 6. 会话内验证

已启动的 Claude Code 会话可能不会热加载外部命令刚写入的 MCP。若 `/mcp` 未刷新：

1. 退出当前目标 profile 会话
2. 使用 `ccps launch <profile>` 重新启动
3. 在新会话运行 `/mcp`

## 完成标准

- 配置写入目标 profile 的 native user scope
- 真实 `~/.claude` 和 `~/.claude.json` 未修改
- 项目 `.mcp.json` 未被误改
- 没有把 `mcpServers` 写入 `settings.json`
- `claude mcp list` 在目标 `CLAUDE_CONFIG_DIR` 下可见
- 输出不包含 secret 值
