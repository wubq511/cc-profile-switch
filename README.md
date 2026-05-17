# CC-Profile-Switch

`ccps` 是一个仅限 Windows 的 Node.js CLI，用于在保留当前项目上下文的同时，切换 Claude Code 的用户级全局配置（Profile）。

```powershell
cd D:\Projects\my-app
ccps launch coding
```

启动时将保持当前工作目录（CWD）作为项目目录，并将 `CLAUDE_CONFIG_DIR` 设置为所选配置文件的 `claude-home`。

## 安装

```powershell
npm install
npm run build
npm link
```

本地开发（不使用 link）：

```powershell
npm run dev -- --help
npm run dev -- init
npm run dev -- launch coding --dry-run
```

## 命令

```powershell
ccps init
ccps list
ccps create <name> --template <coding|study|work|research|general|blank>
ccps show <name>
ccps validate <name>
ccps backup <name>
ccps edit <name> [CLAUDE.md|settings.json|mcp.json|profile.json]
ccps launch <profile> --dry-run
ccps launch <profile>
```

在执行真正的启动前，建议使用 `ccps launch <profile> --dry-run` 检查计划。

## 配置布局

配置文件（Profiles）存放路径：

```text
%USERPROFILE%\.cc-profile-switch\
  config.json
  api-settings.json          # 可选：通用 API 环境变量
  profiles\
    <name>\
      profile.json
      claude-home\
        CLAUDE.md
        settings.json        # 可选：当前 profile 的 env 覆盖
        skills\
        agents\
      mcp.json
      plugins\
  backups\
```

`claude-home` 将作为 `CLAUDE_CONFIG_DIR` 传递给 Claude Code。项目级的 `CLAUDE.md`、`.claude/settings.json`、`.claude/agents`、`.claude/skills` 以及 `.mcp.json` 仍由启动时的 cwd 控制。

## API 配置

通用 API 认证信息放在 `%USERPROFILE%\.cc-profile-switch\api-settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_BASE_URL": "...",
    "ANTHROPIC_MODEL": "..."
  }
}
```

某个 profile 自己的 API 覆盖直接写在 `profiles\<name>\claude-home\settings.json` 的 `env` 中。优先级为：profile 优先，其次是通用 `api-settings.json`，最后是启动 `ccps` 时继承的进程环境变量。也就是说，`claude-home\settings.json` 中的同名 `env` 键会覆盖 `%USERPROFILE%\.cc-profile-switch\api-settings.json`，profile 没有配置的键会从通用配置继承。

`ccps launch <profile> --dry-run` 只显示 API 环境变量键名和配置来源状态，不显示 token 或其他值。

## 启动行为

`ccps launch <profile>` 会验证配置文件，构建与 dry-run 相同的计划，然后启动 Claude Code：

```ts
spawn('claude', args, {
  cwd,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ...apiEnv,
    CLAUDE_CONFIG_DIR: profileClaudeHome
  }
})
```

默认 MCP 模式为 `merge`（合并）：`ccps` 传递 `--mcp-config <profile>\mcp.json` 且**不**传递 `--strict-mcp-config`。严格模式（Strict mode）仅在配置文件显式配置时启用。Profile 插件目录将作为 `--plugin-dir` 参数传递。

`ccps` 永远不会对当前项目使用 `--add-dir`，也永远不会将 cwd 更改为 `.cc-profile-switch` 目录。

## 安全边界

`ccps` 不会自动从真实的 `C:\Users\<you>\.claude` 中复制、读取、迁移或管理 OAuth、会话（session）、令牌（token）、历史记录、缓存或凭据内容。

基于 API 的 Claude Code 用户可以把通用 `ANTHROPIC_*` 环境变量放进 `api-settings.json`，把 profile 专属覆盖放进对应的 `claude-home\settings.json`。这些文件包含真实密钥时应只留在本机用户目录，不要复制进项目仓库或提交到 Git。验证说明详见 `VERIFY-CLAUDE-CODE-BEHAVIOR.md`。

## 运行验证

```powershell
npm run lint
npm run test
npm run build
npm run check
```

`npm run check` 会运行 lint、测试和构建。
