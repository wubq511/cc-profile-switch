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

`ccps edit` 需要 VS Code 的 `code` 命令可用；VS Code 安装后可通过命令面板启用 Shell Command。

## 命令

```powershell
ccps init
ccps list
ccps create <name> --template <coding|study|work|research|general|blank>
ccps show <name>
ccps validate <name>
ccps backup <name>
ccps edit <name> [file-or-folder]
ccps copy <from> <to>
ccps rename <old> <new>
ccps remove <name>
ccps default [name]
ccps default --clear
ccps launch <profile> --dry-run
ccps launch <profile>
ccps launch --dry-run
ccps launch
ccps tui
```

在执行真正的启动前，建议使用 `ccps launch <profile> --dry-run` 或 `ccps launch --dry-run` 检查计划。

`ccps copy <from> <to>` 会基于已有 profile 创建变体，目标已存在时会拒绝覆盖。`ccps rename <old> <new>` 会移动 profile，并同步更新 `config.json` 中指向旧名称的 default / last-used 引用。

`ccps default [name]` 用于查看或设置默认 profile；`ccps default --clear` 会清除默认值。没有传入 profile 时，`ccps launch` 会使用已设置的默认 profile；如果没有默认 profile，会提示先传入 profile 名称或运行 `ccps default <profile>`。

`ccps remove <name>` 删除前会先创建备份，并要求精确输入 profile 名称确认。它允许删除当前 default profile，也允许删除最后一个 profile；删除后会清理 default / last-used 中指向该 profile 的引用。没有任何 profile 时，`ccps list` 和 `ccps tui` 会提示先运行 `ccps init` 或 `ccps create <name> --template blank`。

`ccps edit <name>` 会用新的 VS Code 窗口打开整个 profile 文件夹。带上文件或文件夹参数时，会打开该 profile 内的已有目标；常用别名包括 `CLAUDE.md`、`settings.json`、`mcp.json`、`profile.json`、`claude-home`、`memory`、`skills`、`agents`、`plugins`。

`ccps tui` 是覆盖同一套核心行为的轻量交互入口，适合在终端里选择 profile、执行 copy / rename / remove / default / validate / launch dry-run。它不是 GUI，也不是单独的产品模式；真正的启动、校验、删除备份和配置安全边界仍由相同的 core service 执行。

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
        CLAUDE.md            # 当前 profile 的用户级 memory / instructions
        settings.json        # autoMemoryDirectory + 默认 env + 可选 API env 覆盖
        memory\
          auto\
            MEMORY.md         # 当前 profile 的 Claude Code auto memory
        skills\
        agents\
        plugins\              # Claude Code 自己安装/管理的 plugins
      mcp.json
  backups\
```

`claude-home` 将作为 `CLAUDE_CONFIG_DIR` 传递给 Claude Code。项目级的 `CLAUDE.md`、`.claude/settings.json`、`.claude/agents`、`.claude/skills` 以及 `.mcp.json` 仍由启动时的 cwd 控制。

## Memory 隔离

每个 profile 有独立的 memory：

- 用户级 memory / instructions：`profiles\<name>\claude-home\CLAUDE.md`
- Claude Code auto memory：`profiles\<name>\claude-home\memory\auto`

`profiles\<name>\claude-home\settings.json` 会显式包含：

```json
{
  "autoMemoryDirectory": "C:\\Users\\<you>\\.cc-profile-switch\\profiles\\<name>\\claude-home\\memory\\auto",
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}
```

因此使用 `ccps launch coding` 启动时，Claude Code 的用户配置目录是 coding 的 `claude-home`，auto memory 写入 coding 的 `claude-home\memory\auto`；切换到 `study` 时会写入 study 自己的 `claude-home\memory\auto`，互不混用。

新建 profile 会默认写入 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。对已经存在的 profile，重新运行 `ccps init` 会在缺失时补齐这个 env 键，并保留已有 `settings.json` 字段。

Claude Code 自己安装和管理的 plugin 位于当前 profile 的 `claude-home\plugins`。`profiles\<name>\mcp.json` 是 ccps 传给 Claude Code 的 profile MCP 配置文件；项目级 `.mcp.json` 仍由启动 cwd 控制。

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

`ccps launch <profile>` 会验证配置文件，构建与 dry-run 相同的计划，然后启动 Claude Code。`<profile>` 可省略；省略时会解析 `ccps default <profile>` 设置的默认 profile。

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

默认会传入 `--dangerously-skip-permissions`，让 Claude Code 跳过权限确认。单个 profile 可以在 `profile.json` 中关闭：

```json
{
  "launch": {
    "skipPermissions": false
  }
}
```

默认 MCP 模式为 `merge`（合并）：`ccps` 传递 `--mcp-config <profile>\mcp.json` 且**不**传递 `--strict-mcp-config`。严格模式（Strict mode）仅在配置文件显式配置时启用。只有在 `profile.json` 显式配置 `launch.pluginDirs` 时，ccps 才会额外传递 `--plugin-dir`，这些路径相对当前 profile 的 `claude-home` 解析。

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
