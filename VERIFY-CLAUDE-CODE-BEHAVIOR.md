# Claude Code 行为验证

状态：已完成真实验证（显式提供 API 设置；已验证 ccps 通用 API 配置 dry-run）。
日期：2026-05-16
观测到的 Claude Code CLI 版本：`2.1.143 (Claude Code)`

## 范围

本文件验证（或明确列出待手动验证的）`ccps` 在实现真实启动方案之前所依赖的行为：

- `CLAUDE_CONFIG_DIR` 应将用户级 Claude Code 配置源替换为所选 profile 的 `claude-home`。
- 项目级配置仍应从启动时的当前工作目录（cwd）加载。
- 用户级 memory 应来自所选 profile 的 `claude-home\CLAUDE.md`，auto memory 应写入所选 profile 的 `claude-home\memory\auto`。
- Profile 的 MCP 配置默认应是增加式的，仅在显式要求时才启用严格模式（strict）。
- 默认启动应传递 `--dangerously-skip-permissions`；单个 profile 可用 `launch.skipPermissions=false` 关闭。
- 通用 `api-settings.json` 与 profile `claude-home\settings.json` 的 `env` 应合并为启动环境变量，且 profile 优先、dry-run 只显示键名。
- 认证、会话、历史和缓存行为仅作为文件位置或提示进行观察，绝不通过复制或读取敏感内容来获取。

`ccps launch <profile> --dry-run` 目前已经实现。真实的 `ccps launch <profile>` 有意尚未实现，因此在推进 issue #10 之前，必须先使用等效的环境设置手动检查真实的 Claude Code 行为。

## 安全规则

- 不要复制、迁移或打开 OAuth、会话、令牌、凭据、缓存、转录或历史记录内容，除非用户明确要求迁移 API 环境变量。
- 允许的 API 迁移范围仅限 `settings.json` 的 `env.ANTHROPIC_*`，目标为 `%USERPROFILE%\.cc-profile-switch\api-settings.json`，且不得打印值。
- 建议使用隔离的临时 `USERPROFILE` 进行验证。
- 如果必须编辑真实的 `%USERPROFILE%\.claude\CLAUDE.md`，请先备份并在检查后恢复。
- 不要使用真实密钥作为标记文本。
- 仅记录文件路径和高层级行为，不记录敏感文件内容。

## 标记字符串

使用以下精确标记值：

```text
GLOBAL_ORIGINAL_MARKER=CCPS_VERIFY_GLOBAL_ORIGINAL_MARKER
PROFILE_CODING_MARKER=CCPS_VERIFY_PROFILE_CODING_MARKER
PROJECT_MARKER=CCPS_VERIFY_PROJECT_MARKER
```

Profile 启动期间预期的标记可见性：

| 标记 | 预期结果 |
|---|---|
| `GLOBAL_ORIGINAL_MARKER` | 当 `CLAUDE_CONFIG_DIR` 指向 profile 的 `claude-home` 时不可见 |
| `PROFILE_CODING_MARKER` | 从所选 profile 的 `claude-home\CLAUDE.md` 中可见 |
| `PROJECT_MARKER` | 从启动 cwd 项目的 `CLAUDE.md` 中可见 |

## 已收集的自动化证据

运行了以下不启动 Claude Code 的检查：

```powershell
claude --version
claude --help
npm run dev -- init
npm run dev -- launch coding --dry-run --cwd <temp-project>
```

观测结果：

- Claude Code CLI 版本为 `2.1.143`。
- Claude Code 支持 `-p/--print`, `--no-session-persistence`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, 和 `--plugin-dir`。
- `ccps launch coding --dry-run` 验证了一个隔离的 profile 并打印了：
  - 所选 profile 名称
  - profile 根目录
  - `claude-home`
  - 启动 cwd
  - MCP 模式 `merge`
  - `--dangerously-skip-permissions`
  - `--mcp-config <profile>\mcp.json`
  - `CLAUDE_CONFIG_DIR=<profile>\claude-home`
  - profile 用户 memory 路径和 auto memory 路径
  - API 配置状态和 API 环境变量键名（不打印值）
  - 验证结果 `valid`
  - `Dry run: Claude Code was not started.`
- Dry-run 没有创建 Claude Code 会话、历史或缓存文件。

## 隔离手动设置

使用此设置可避免在验证期间触及真实的 `C:\Users\h\.claude`：

```powershell
$VerifyRoot = Join-Path $env:TEMP "ccps-claude-verify"
$TempUser = Join-Path $VerifyRoot "user"
$Project = Join-Path $VerifyRoot "project"

New-Item -ItemType Directory -Path $TempUser -Force | Out-Null
New-Item -ItemType Directory -Path $Project -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $TempUser ".claude") -Force | Out-Null

$OldUserProfile = $env:USERPROFILE
$env:USERPROFILE = $TempUser

npm run dev -- init

Set-Content -Path (Join-Path $TempUser ".claude\CLAUDE.md") -Value @"
# Original Global Claude Config
GLOBAL_ORIGINAL_MARKER=CCPS_VERIFY_GLOBAL_ORIGINAL_MARKER
"@

$ProfileClaudeHome = Join-Path $TempUser ".cc-profile-switch\profiles\coding\claude-home"
Add-Content -Path (Join-Path $ProfileClaudeHome "CLAUDE.md") -Value @"

PROFILE_CODING_MARKER=CCPS_VERIFY_PROFILE_CODING_MARKER
"@

Set-Content -Path (Join-Path $Project "CLAUDE.md") -Value @"
# Project Claude Config
PROJECT_MARKER=CCPS_VERIFY_PROJECT_MARKER
"@
```

验证完成后恢复 `$env:USERPROFILE`：

```powershell
$env:USERPROFILE = $OldUserProfile
```

## Dry-Run 验证

命令：

```powershell
$env:USERPROFILE = $TempUser
npm run dev -- launch coding --dry-run --cwd $Project
```

预期结果：

- `Profile path` 指向 `$TempUser\.cc-profile-switch\profiles\coding` 内部。
- `Claude home` 指向 `$TempUser\.cc-profile-switch\profiles\coding\claude-home`。
- `Cwd` 等于 `$Project`。
- `Args` 包含 `--dangerously-skip-permissions`，除非 profile 显式关闭 `launch.skipPermissions`。
- `Args` 包含 `--mcp-config` 和 profile 的 `mcp.json`。
- 对于默认的合并模式，`Args` 不包含 `--strict-mcp-config`。
- `CLAUDE_CONFIG_DIR` 等于 profile 的 `claude-home`。
- Memory 区域显示用户 memory 为 profile 的 `claude-home\CLAUDE.md`，auto memory 为 profile 的 `claude-home\memory\auto`。
- API 配置区域只显示 common/profile 是否存在和环境变量键名，不显示 token 或其他值。
- 输出显示 Claude Code 未被启动。

当前结果：隔离 dry-run 通过。

## 真实 Claude Code 验证

仅在可以接受手动执行 Claude Code 时运行此项。它可能会使用现有的 Claude Code 认证并可能调用模型。

在真实的 `ccps launch` 存在之前，请使用等效环境：

```powershell
$env:USERPROFILE = $TempUser
$env:CLAUDE_CONFIG_DIR = $ProfileClaudeHome
Push-Location $Project

claude -p --no-session-persistence --settings C:\Users\h\.claude\settings.json --max-budget-usd 0.20 @"
Reply with only a JSON object showing whether these marker strings are present in your loaded instructions:
GLOBAL_ORIGINAL_MARKER
PROFILE_CODING_MARKER
PROJECT_MARKER
"@

Pop-Location
```

预期 JSON 含义：

- `GLOBAL_ORIGINAL_MARKER`: `false`
- `PROFILE_CODING_MARKER`: `true`
- `PROJECT_MARKER`: `true`

如果 Claude Code 需要为隔离 profile 进行认证且没有显式 API 设置，记录提示如下：

```text
auth_required: true
profile: coding
```

不要将令牌、会话文件或凭据内容复制到此仓库中。

2026-05-16 在没有显式 API 设置的情况下观测到的结果：

```text
Not logged in · Please run /login
```

这发生于：

- 隔离的 `USERPROFILE`
- 隔离的 `CLAUDE_CONFIG_DIR`
- `claude -p --no-session-persistence --max-budget-usd 0.05`

当 `USERPROFILE` 恢复为真实用户但 `CLAUDE_CONFIG_DIR` 仍指向隔离的 profile `claude-home` 时也会发生。这证明 Claude Code 的 OAuth/keychain 风格认证在 `CLAUDE_CONFIG_DIR` 下是 profile 特有的。

2026-05-16 通过 `--settings C:\Users\h\.claude\settings.json` 显式传递现有 API 设置时观测到的结果：

```json
{
  "GLOBAL_ORIGINAL_MARKER": false,
  "PROFILE_CODING_MARKER": true,
  "PROJECT_MARKER": true
}
```

真实的个人设置文件没有被复制到 profile 中、提交或打印。它作为现有的本地设置文件传递给 Claude Code，以便 Claude Code 可以自行加载配置好的 API 环境。

2026-05-17 验证了 ccps 通用 API 配置方式：

- 已将真实用户 `C:\Users\h\.claude\settings.json` 中 `env.ANTHROPIC_*` 迁移到 `C:\Users\h\.cc-profile-switch\api-settings.json`。
- 迁移输出只记录键名和数量，不记录值。
- 从 `D:\AILearning` 运行 `ccps launch coding --dry-run`，输出显示：
  - `common: present (6 env key(s))`
  - `profile: missing (no env keys)`
  - 6 个 `ANTHROPIC_*` 键名
- Dry-run 未显示 token、base URL 或模型值。

## 设置、Agents、Skills、Plugins 和 MCP

使用相同的隔离 `$TempUser` 和 `$Project`。

| 区域 | 计划检查 | 预期结果 | 当前结果 |
|---|---|---|---|
| 用户设置 | 在 `$ProfileClaudeHome\settings.json` 中添加一个良性的可观测 `env` 标记；要求 Claude Code 运行 `node -e` 并报告环境。 | Profile 中的用户设置生效。 | 通过：`CCPS_PROFILE_SETTINGS_MARKER=profile-settings-visible` 到达了工具子进程 |
| Auto memory 设置 | 在 `$ProfileClaudeHome\settings.json` 中设置 `autoMemoryDirectory=$ProfileClaudeHome\memory\auto`；启动时观察 dry-run 和 settings。 | Claude Code auto memory 被指向当前 profile 的 claude-home memory 目录。 | 已由 ccps 模板和验证器强制；真实 Claude 写入仍需手动验证 |
| 项目设置 | 在 `$Project\.claude\settings.json` 中添加一个良性项目 `env` 标记；要求 Claude Code 运行 `node -e` 并报告环境。 | 项目设置在 profile 用户配置下保持有效。 | 通过：`CCPS_PROJECT_SETTINGS_MARKER=project-settings-visible` 到达了工具子进程 |
| Agents | 在 `$ProfileClaudeHome\agents` 下添加 `ccps-marker-agent`；询问加载的上下文中是否可见。 | Profile 用户级 agent 可用。 | 通过：Claude Code 报告了 `ccps-marker-agent: true` |
| Skills | 在 `$ProfileClaudeHome\skills` 下添加 `ccps-marker-skill`；询问加载的上下文中是否可见。 | Profile 用户级 skill 可用。 | 通过：Claude Code 报告了 `ccps-marker-skill: true` |
| Plugins | 从 profile 启动 Claude Code 后观察 `$ProfileClaudeHome\plugins`。 | Claude Code 自己安装/管理的用户级 plugin 状态位于当前 profile 的 `claude-home\plugins`。 | 通过：真实 `study` profile 中已创建 `claude-home\plugins\installed_plugins.json`、`known_marketplaces.json`、`cache` 和 `marketplaces` |
| MCP 项目发现 | 在 `$Project\.mcp.json` 中添加一个无害的项目 MCP server；从 `$Project` 运行 `claude mcp list`。 | 项目 MCP 配置对 Claude Code 可见。 | 通过：项目 MCP server 被列出 |
| MCP 合并 | 在 profile `mcp.json` 中添加一个无害的 profile MCP server，在 `$Project\.mcp.json` 中添加一个无害的项目 MCP server；使用 profile `--mcp-config` 运行。 | Profile 和项目 MCP 配置均可用。 | 通过：`claude -p` 返回了 profile 和项目 MCP 标记 |
| MCP 严格 | 使用 `--strict-mcp-config` 重复上述操作。 | 在严格模式下不加载项目 MCP 配置。 | 通过：`claude -p` 返回了 profile MCP 标记且 `projectAvailable: false` |

如果某种行为取决于 Claude Code 版本或无法安全检查，请将其标记为 `unknown` 并注明 Claude Code 版本。

## 认证、会话、历史和缓存位置

在真实的模拟运行之后，仅记录路径名：

```powershell
Get-ChildItem -Force -Recurse $ProfileClaudeHome |
  Where-Object { $_.Name -match 'session|history|cache|oauth|token|credential' } |
  Select-Object FullName

Get-ChildItem -Force -Recurse (Join-Path $TempUser ".claude") |
  Where-Object { $_.Name -match 'session|history|cache|oauth|token|credential' } |
  Select-Object FullName
```

不要对任何匹配的文件运行 `Get-Content`。

当前结果：

- Dry-run 未创建任何 Claude Code 会话、历史或缓存文件。
- 没有显式 API 设置的真实 Claude Code 运行停在 `Not logged in · Please run /login`。
- 带有显式 API 设置的真实 Claude Code 运行完成了标记、设置、agents、skills、plugin-dir 和 MCP 检查。
- Profile 的 `claude-home` 增加了与会话相关的目录：
  `C:\Users\h\AppData\Local\Temp\ccps-claude-verify-1f8bd5ceaefc4bbeb11c79d4deddc844\user\.cc-profile-switch\profiles\coding\claude-home\session-env`
  `C:\Users\h\AppData\Local\Temp\ccps-claude-verify-1f8bd5ceaefc4bbeb11c79d4deddc844\user\.cc-profile-switch\profiles\coding\claude-home\sessions`
- 隔离的原始全局配置目录中没有匹配的认证/会话/历史/缓存路径。
- 隔离的 `USERPROFILE\AppData\Roaming` 目录已创建，未检视任何敏感文件内容。

## 结果矩阵

| 行为 | 状态 | 证据 |
|---|---|---|
| `ccps launch --dry-run` 在计划前验证 profile | 通过 | 隔离 dry-run 打印了 `Validation: valid` |
| Dry-run 将 `CLAUDE_CONFIG_DIR` 设置为 profile 的 `claude-home` | 通过 | 隔离 dry-run 打印了预期的环境变量更改 |
| Dry-run 显示 profile memory 路径 | 通过 | dry-run 打印了 `claude-home\CLAUDE.md` 和 `claude-home\memory\auto` |
| Dry-run 保持项目 cwd 为启动 cwd | 通过 | 隔离 dry-run 打印了显式的临时项目路径 |
| 默认 MCP 模式避免使用 `--strict-mcp-config` | 通过 | 隔离 dry-run 参数中仅包含 `--mcp-config` |
| 默认跳过权限确认 | 通过 | dry-run 参数包含 `--dangerously-skip-permissions` |
| Dry-run 永远不启动 Claude Code | 通过 | 输出中包含 `Dry run: Claude Code was not started.` |
| Profile 的 `CLAUDE.md` 替换了全局真实的 `CLAUDE.md` | 通过 | 标记结果：global false, profile true |
| 项目 `CLAUDE.md` 仍从 cwd 加载 | 通过 | 标记结果：project true |
| 用户设置行为 | 通过 | Profile 设置中的环境变量标记到达了工具子进程 |
| 项目设置行为 | 通过 | 项目设置中的环境变量标记到达了工具子进程 |
| Agents 行为 | 通过 | Profile agent 标记夹具可见 |
| Skills 行为 | 通过 | Profile skill 标记夹具可见 |
| Plugins 行为 | 通过 | Claude Code 自己管理的 plugin 状态出现在 `claude-home\plugins`；`--plugin-dir` 只作为显式额外 session plugin-dir |
| MCP 项目发现 | 通过 | `claude mcp list` 在无认证状态下列出了项目 `.mcp.json` 对应的 server |
| MCP 合并/严格行为 | 通过 | 合并模式下暴露了 profile 和项目 MCP 标记；严格模式下仅暴露 profile 标记 |
| 每个 profile 独立的认证 | 通过 | 隔离的 `CLAUDE_CONFIG_DIR` 返回了 `Not logged in`（在没有显式 API 设置的情况下），即使使用了真实的 `USERPROFILE` |
| API 设置可以显式提供 | 通过 | `--settings C:\Users\h\.claude\settings.json` 使模型能够执行，而无需复制凭据 |
| ccps 通用 API 设置 | 通过 | `C:\Users\h\.cc-profile-switch\api-settings.json` 被 dry-run 识别为 common API config，输出只显示 `ANTHROPIC_*` 键名 |
| 会话/历史/缓存位置 | 部分 | 运行创建了 profile 的 `session-env` 和 `sessions` 目录；未检视敏感内容 |

## Issue #10 的准入条件

Issue #10 可以按照以下约束实现真实启动：

1. 保持 `CLAUDE_CONFIG_DIR=<profile>\claude-home`。
2. 保持 cwd 为项目目录。
3. 默认使用合并（merge）MCP，仅在明确配置时使用严格（strict）MCP。
4. 不要将凭据复制或迁移到 profile 中；用户明确要求时，只能把 `ANTHROPIC_*` 迁移到本机通用 `api-settings.json`。
5. 文档说明 OAuth/keychain 风格的认证在 `CLAUDE_CONFIG_DIR` 下呈现为 profile 特有。
6. 文档说明基于 API 的用户可以通过通用 `api-settings.json` 或 profile `claude-home\settings.json` 的 `env` 传递 API 环境变量，且 profile 优先。
7. 将 `session-env` 和 `sessions` 视为 Claude Code 创建的 profile 状态，不要检视或迁移其内容。
8. 将 `autoMemoryDirectory` 固定为当前 profile 的 `claude-home\memory\auto`，防止 auto memory 串到其他 profile。
