# Claude Code 行为验证

状态：已完成 Windows 真实验证、macOS 隔离/真实 launch smoke、common API settings 验证；2026-07-30 已补充 Claude Code 原生 user-scope MCP 写入位置、ccps legacy MCP 兼容验证、Linux 自动化覆盖与三平台 CI。Linux hosted runner 结果需在推送后由 GitHub Actions 产生，不能用本机 macOS 结果代替。
日期：2026-05-16；macOS 支持补充：2026-06-18；MCP scope 与 Linux/CI 补充：2026-07-30
当前观测到的 Claude Code CLI 版本：`2.1.220 (Claude Code)`；早期 merge/strict 行为证据来自 `2.1.143`

## 范围

本文件验证（或明确列出待手动验证的）`ccps` 在实现真实启动方案之前所依赖的行为：

- `CLAUDE_CONFIG_DIR` 应将用户级 Claude Code 配置源替换为所选 profile 的 `claude-home`。
- 项目级配置仍应从启动时的当前工作目录（cwd）加载。
- 用户级 memory 应来自所选 profile 的 `claude-home\CLAUDE.md`（macOS：`claude-home/CLAUDE.md`），auto memory 应写入所选 profile 的 `claude-home\memory\auto`（macOS：`claude-home/memory/auto`）。
- Profile-wide MCP 应使用 Claude Code 原生 `user` scope，并由 `CLAUDE_CONFIG_DIR/.claude.json` 隔离；项目 `.mcp.json` 仍由 cwd 控制。
- 旧 profile 的非空 `mcp.json` 仅作为 legacy `--mcp-config` 兼容输入，默认不再创建。
- 默认启动应传递 `--dangerously-skip-permissions`；单个 profile 可用 `launch.skipPermissions=false` 关闭。
- 通用 `api-settings.json` 与 profile `claude-home\settings.json` 的 `env` 应合并为启动环境变量，且 profile 优先、dry-run 只显示键名。
- 认证、会话、历史和缓存行为仅作为文件位置或提示进行观察，绝不通过复制或读取敏感内容来获取。

`ccps launch <profile> --dry-run` 和真实的 `ccps launch <profile>` 均已实现。真实 launch 的行为必须继续与 dry-run 使用同一份 launch plan：相同 cwd、args、API env 合并、`CLAUDE_CONFIG_DIR` 和 memory 路径。

## 安全规则

- 不要复制、迁移或打开 OAuth、会话、令牌、凭据、缓存、转录或历史记录内容。
- `ccps init` 允许读取当前用户 Claude `settings.json` 的 `env.ANTHROPIC_*` 字符串键，目标为 app home 下的 common `api-settings.json`，且不得打印值。
- 建议使用隔离的临时 Windows `USERPROFILE` 或 macOS `HOME` 进行验证。
- 不要编辑真实的 `%USERPROFILE%\.claude\CLAUDE.md` 或 `~/.claude/CLAUDE.md`；如果必须编辑，先备份并在检查后恢复。
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

| 标记                     | 预期结果                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `GLOBAL_ORIGINAL_MARKER` | 当 `CLAUDE_CONFIG_DIR` 指向 profile 的 `claude-home` 时不可见              |
| `PROFILE_CODING_MARKER`  | 从所选 profile 的 `claude-home\CLAUDE.md` / `claude-home/CLAUDE.md` 中可见 |
| `PROJECT_MARKER`         | 从启动 cwd 项目的 `CLAUDE.md` 中可见                                       |

## 已收集的自动化证据

运行了以下不启动 Claude Code 的检查：

```powershell
claude --version
claude --help
CLAUDE_CONFIG_DIR=<temp-config> claude mcp add --scope user ccps-probe -- /usr/bin/true
CLAUDE_CONFIG_DIR=<temp-config> claude mcp list
CLAUDE_CONFIG_DIR=<temp-config> claude mcp get ccps-probe
npm run dev -- init
npm run dev -- launch coding --dry-run --cwd <temp-project>
```

观测结果：

- Claude Code CLI 当前版本为 `2.1.220`。
- Claude Code 支持 `-p/--print`, `--no-session-persistence`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, 和 `--plugin-dir`。
- 隔离 probe 把 user-scope `ccps-probe` 写入 `<temp-config>/.claude.json` 的顶层 `mcpServers`，没有写入 `settings.json` 或 `.mcp.json`。
- 使用 dummy secret 的隔离 probe 显示 `claude mcp list` 不回显值，但 `claude mcp get` 会回显存储的 environment 值；Agent 自动化只能使用 `list`/`/mcp` 做无 secret 验证。
- `ccps launch coding --dry-run` 验证了一个隔离的 profile 并打印了：
  - 所选 profile 名称
  - profile 根目录
  - `claude-home`
  - 启动 cwd
  - native user-scope MCP 路径 `<profile>\claude-home\.claude.json`
  - legacy MCP 配置状态 `inactive`
  - `--dangerously-skip-permissions`
  - 默认参数中没有 `--mcp-config`
  - `CLAUDE_CONFIG_DIR=<profile>\claude-home`
  - profile 用户 memory 路径和 auto memory 路径
  - API 配置状态和 API 环境变量键名（不打印值）
  - 验证结果 `valid`
  - `Dry run: Claude Code was not started.`
- Dry-run 没有创建 Claude Code 会话、历史或缓存文件。

## 隔离手动设置

使用此设置可避免在 Windows 验证期间触及真实的 `C:\Users\h\.claude`：

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

macOS 等价隔离设置，避免触及真实的 `~/.claude`：

```sh
VerifyRoot="$(mktemp -d "${TMPDIR:-/tmp}/ccps-claude-verify.XXXXXX")"
TempUser="$VerifyRoot/user"
Project="$VerifyRoot/project"

mkdir -p "$TempUser/.claude" "$Project"
OldHome="$HOME"
export HOME="$TempUser"

npm run dev -- init

cat > "$TempUser/.claude/CLAUDE.md" <<'EOF'
# Original Global Claude Config
GLOBAL_ORIGINAL_MARKER=CCPS_VERIFY_GLOBAL_ORIGINAL_MARKER
EOF

ProfileClaudeHome="$TempUser/.cc-profile-switch/profiles/coding/claude-home"
cat >> "$ProfileClaudeHome/CLAUDE.md" <<'EOF'

PROFILE_CODING_MARKER=CCPS_VERIFY_PROFILE_CODING_MARKER
EOF

cat > "$Project/CLAUDE.md" <<'EOF'
# Project Claude Config
PROJECT_MARKER=CCPS_VERIFY_PROJECT_MARKER
EOF
```

验证完成后恢复 `HOME`：

```sh
export HOME="$OldHome"
```

## Dry-Run 验证

命令：

```powershell
$env:USERPROFILE = $TempUser
npm run dev -- launch coding --dry-run --cwd $Project
```

macOS：

```sh
HOME="$TempUser" npm run dev -- launch coding --dry-run --cwd "$Project"
```

预期结果：

- `Profile path` 指向 `$TempUser\.cc-profile-switch\profiles\coding` 或 `$TempUser/.cc-profile-switch/profiles/coding` 内部。
- `Claude home` 指向 `$TempUser\.cc-profile-switch\profiles\coding\claude-home` 或 `$TempUser/.cc-profile-switch/profiles/coding/claude-home`。
- `Cwd` 等于 `$Project`。
- `Args` 包含 `--dangerously-skip-permissions`，除非 profile 显式关闭 `launch.skipPermissions`。
- `MCP mode` 指向 profile 的 `claude-home\.claude.json` / `claude-home/.claude.json`。
- 新 profile 的默认 `Args` 不包含 `--mcp-config` 或 `--strict-mcp-config`。
- `CLAUDE_CONFIG_DIR` 等于 profile 的 `claude-home`。
- Memory 区域显示用户 memory 为 profile 的 `claude-home\CLAUDE.md` / `claude-home/CLAUDE.md`，auto memory 为 profile 的 `claude-home\memory\auto` / `claude-home/memory/auto`。
- API 配置区域只显示 common/profile 是否存在和环境变量键名，不显示 token 或其他值。
- 输出显示 Claude Code 未被启动。

当前结果：隔离 dry-run 通过。

## 真实 Claude Code 验证

仅在可以接受手动执行 Claude Code 时运行此项。它可能会使用现有的 Claude Code 认证并可能调用模型。

通过 `ccps launch` 运行真实验证时，使用隔离 profile，并在 `profile.json` 中配置非交互 print 参数，例如 `launch.claudeArgs` 包含 `-p`、`--no-session-persistence`、`--max-budget-usd` 和一段只输出标记可见性的提示。不要通过复制真实 session 或 credential 让隔离 profile 登录。

历史等效环境命令（Windows）：

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

2026-06-18 在 macOS 隔离 `HOME` 下，通过 `ccps launch real_launch --cwd <temp-project>` 真实启动 Claude Code。`profile.json` 中的 `launch.claudeArgs` 使用 `-p`、`--no-session-persistence`、`--max-budget-usd 0.05` 和一个要求检查 `process.cwd()` / `process.env.CLAUDE_CONFIG_DIR` / 项目 `CLAUDE.md` 标记的 prompt。Dry-run 证明真实 launch 将使用：

- `CLAUDE_CONFIG_DIR=<temp-home>/.cc-profile-switch/profiles/real_launch/claude-home`
- `Cwd: <temp-project>`
- 同一组 `claudeArgs`

真实 Claude Code 进程返回：

```text
Not logged in · Please run /login
```

`ccps` 随后报告 `CLAUDE_EXITED_WITH_ERROR`，未复制、读取或迁移真实 `~/.claude`、session、token、history、cache 或 credential 内容。

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

2026-06-18 已将上述 API 复用规则固化为 `ccps init` 行为：Windows 从 `%USERPROFILE%\.claude\settings.json`、macOS 从 `~/.claude/settings.json` 抽取字符串类型的 `env.ANTHROPIC_*`，只补齐 common `api-settings.json` 缺失的键，保留已有 common 配置。所有 profile 的 launch plan 通过 common `api-settings.json` 复用这些模型/API 配置；profile `claude-home\settings.json` / `claude-home/settings.json` 只在需要 profile 专属覆盖时才配置。

## 设置、Agents、Skills、Plugins 和 MCP

使用相同的隔离 `$TempUser` 和 `$Project`。

| 区域                      | 计划检查                                                                                                                            | 预期结果                                                                                                                  | 当前结果                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 默认 profile settings env | 检查 `ccps init` 和 `ccps create` 生成的 `claude-home\settings.json`。                                                              | 新建 profile 包含 `env.CLAUDE_CODE_ATTRIBUTION_HEADER=0`；重复 `init` 会给已存在的默认 profile 补齐缺失键且保留已有 env。 | 通过：自动化测试覆盖新建 profile 和保留 profile 补齐行为                                                                               |
| 用户设置                  | 在 `$ProfileClaudeHome\settings.json` 中添加一个良性的可观测 `env` 标记；要求 Claude Code 运行 `node -e` 并报告环境。               | Profile 中的用户设置生效。                                                                                                | 通过：`CCPS_PROFILE_SETTINGS_MARKER=profile-settings-visible` 到达了工具子进程                                                         |
| Auto memory 设置          | 在 `$ProfileClaudeHome\settings.json` 中设置 `autoMemoryDirectory=$ProfileClaudeHome\memory\auto`；启动时观察 dry-run 和 settings。 | Claude Code auto memory 被指向当前 profile 的 claude-home memory 目录。                                                   | 已由 ccps 模板和验证器强制；真实 Claude 写入仍需手动验证                                                                               |
| 项目设置                  | 在 `$Project\.claude\settings.json` 中添加一个良性项目 `env` 标记；要求 Claude Code 运行 `node -e` 并报告环境。                     | 项目设置在 profile 用户配置下保持有效。                                                                                   | 通过：`CCPS_PROJECT_SETTINGS_MARKER=project-settings-visible` 到达了工具子进程                                                         |
| Agents                    | 在 `$ProfileClaudeHome\agents` 下添加 `ccps-marker-agent`；询问加载的上下文中是否可见。                                             | Profile 用户级 agent 可用。                                                                                               | 通过：Claude Code 报告了 `ccps-marker-agent: true`                                                                                     |
| Skills                    | 在 `$ProfileClaudeHome\skills` 下添加 `ccps-marker-skill`；询问加载的上下文中是否可见。                                             | Profile 用户级 skill 可用。                                                                                               | 通过：Claude Code 报告了 `ccps-marker-skill: true`                                                                                     |
| Plugins                   | 从 profile 启动 Claude Code 后观察 `$ProfileClaudeHome\plugins`。                                                                   | Claude Code 自己安装/管理的用户级 plugin 状态位于当前 profile 的 `claude-home\plugins`。                                  | 通过：真实 `study` profile 中已创建 `claude-home\plugins\installed_plugins.json`、`known_marketplaces.json`、`cache` 和 `marketplaces` |
| MCP 项目发现              | 在 `$Project\.mcp.json` 中添加一个无害的项目 MCP server；从 `$Project` 运行 `claude mcp list`。                                     | 项目 MCP 配置对 Claude Code 可见。                                                                                        | 通过：项目 MCP server 被列出                                                                                                           |
| MCP 原生 user scope       | 设置隔离 `CLAUDE_CONFIG_DIR` 后运行 `claude mcp add --scope user ccps-probe -- /usr/bin/true`。                                     | 写入隔离配置目录的 `.claude.json`，不触及真实用户配置。                                                                   | 通过：CLI 报告修改 `<temp-config>/.claude.json`；解析后 `mcpServers` 只含 `ccps-probe`                                                 |
| MCP CLI secret 输出边界   | 用 dummy environment 值配置隔离 server，分别捕获 `claude mcp list` 与 `claude mcp get`。                                            | Agent 验证命令不得回显存储的 secret。                                                                                     | `list` 通过；`get` 会回显值，因此 Profile Creator/Audit Skill 禁止在 Agent 可见终端运行 `get`                                         |
| MCP legacy 合并           | 在旧 profile `mcp.json` 中添加无害 server，并保留 `mcpMode=merge`。                                                                 | 只有非空旧文件才追加 `--mcp-config`，项目 MCP 仍保留。                                                                    | 通过：自动化 regression test 覆盖                                                                                                      |
| MCP legacy 严格           | 对非空旧 profile `mcp.json` 设置 `mcpMode=strict`。                                                                                 | 追加 `--mcp-config` 和 `--strict-mcp-config`。                                                                            | 通过：自动化 regression test 覆盖；运行时 merge/strict 证据来自 Claude Code `2.1.143`                                                  |

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

| 行为                                                           | 状态          | 证据                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ccps launch --dry-run` 在计划前验证 profile                   | 通过          | 隔离 dry-run 打印了 `Validation: valid`                                                                                                                                                                |
| Dry-run 将 `CLAUDE_CONFIG_DIR` 设置为 profile 的 `claude-home` | 通过          | 隔离 dry-run 打印了预期的环境变量更改                                                                                                                                                                  |
| Dry-run 显示 profile memory 路径                               | 通过          | dry-run 打印了 `claude-home\CLAUDE.md` 和 `claude-home\memory\auto`                                                                                                                                    |
| macOS app home 默认路径                                        | 通过          | 2026-06-18 隔离 `HOME` smoke 创建了 `<temp-home>/.cc-profile-switch`                                                                                                                                   |
| macOS dry-run 保持 profile `CLAUDE_CONFIG_DIR` 和项目 cwd      | 通过          | 2026-06-18 dry-run 打印了 `<temp-home>/.cc-profile-switch/profiles/real_launch/claude-home` 和 `<temp-project>`                                                                                        |
| macOS 真实 ccps launch                                         | auth required | 2026-06-18 隔离 profile 返回 `Not logged in · Please run /login`，未触碰真实凭据                                                                                                                       |
| Dry-run 保持项目 cwd 为启动 cwd                                | 通过          | 隔离 dry-run 打印了显式的临时项目路径                                                                                                                                                                  |
| 默认使用 native user-scope MCP                                 | 通过          | Claude Code `2.1.220` 隔离 probe 写入 `CLAUDE_CONFIG_DIR/.claude.json`                                                                                                                                 |
| 新 profile 默认不传 legacy MCP 参数                            | 通过          | 新 profile 的 `mcpMode=none`，隔离 dry-run 不包含 `--mcp-config` 或 `--strict-mcp-config`                                                                                                               |
| 默认跳过权限确认                                               | 通过          | dry-run 参数包含 `--dangerously-skip-permissions`                                                                                                                                                      |
| Dry-run 永远不启动 Claude Code                                 | 通过          | 输出中包含 `Dry run: Claude Code was not started.`                                                                                                                                                     |
| Profile 的 `CLAUDE.md` 替换了全局真实的 `CLAUDE.md`            | 通过          | 标记结果：global false, profile true                                                                                                                                                                   |
| 项目 `CLAUDE.md` 仍从 cwd 加载                                 | 通过          | 标记结果：project true                                                                                                                                                                                 |
| 用户设置行为                                                   | 通过          | Profile 设置中的环境变量标记到达了工具子进程                                                                                                                                                           |
| 项目设置行为                                                   | 通过          | 项目设置中的环境变量标记到达了工具子进程                                                                                                                                                               |
| Agents 行为                                                    | 通过          | Profile agent 标记夹具可见                                                                                                                                                                             |
| Skills 行为                                                    | 通过          | Profile skill 标记夹具可见                                                                                                                                                                             |
| Plugins 行为                                                   | 通过          | Claude Code 自己管理的 plugin 状态出现在 `claude-home\plugins`；`--plugin-dir` 只作为显式额外 session plugin-dir                                                                                       |
| MCP 项目发现                                                   | 通过          | `claude mcp list` 在无认证状态下列出了项目 `.mcp.json` 对应的 server                                                                                                                                   |
| MCP legacy 合并/严格行为                                       | 通过          | 非空旧文件的参数 regression test 通过；Claude Code `2.1.143` 真实验证曾确认 merge/strict 运行时行为                                                                                                    |
| 每个 profile 独立的认证                                        | 通过          | 隔离的 `CLAUDE_CONFIG_DIR` 返回了 `Not logged in`（在没有显式 API 设置的情况下），即使使用了真实的 `USERPROFILE`                                                                                       |
| API 设置可以显式提供                                           | 通过          | `--settings C:\Users\h\.claude\settings.json` 使模型能够执行，而无需复制凭据                                                                                                                           |
| ccps 通用 API 设置                                             | 通过          | `ccps init` 可从 Windows `%USERPROFILE%\.claude\settings.json` 或 macOS `~/.claude/settings.json` 导入 `env.ANTHROPIC_*` 到 common `api-settings.json`；dry-run 识别 common API config，输出只显示键名 |
| 会话/历史/缓存位置                                             | 部分          | 运行创建了 profile 的 `session-env` 和 `sessions` 目录；未检视敏感内容                                                                                                                                 |

## 真实 launch 保持条件

后续修改真实启动逻辑时必须保持以下约束：

1. 保持 `CLAUDE_CONFIG_DIR=<profile>\claude-home`（macOS：`<profile>/claude-home`）。
2. 保持 cwd 为项目目录。
3. 新 profile 使用 Claude Code 原生 user-scope MCP 且 legacy `mcpMode=none`；只有旧 profile 的非空 `mcp.json` 才按已有 legacy `mcpMode` 传递 `--mcp-config`，strict 不得成为默认值。
4. 不要将凭据复制或迁移到 profile 中；`ccps init` 只能把当前用户 Claude `settings.json` 中的 `env.ANTHROPIC_*` 字符串键导入本机通用 `api-settings.json`。
5. 文档说明 OAuth/keychain 风格的认证在 `CLAUDE_CONFIG_DIR` 下呈现为 profile 特有。
6. 文档说明基于 API 的用户可以通过通用 `api-settings.json` 或 profile `claude-home\settings.json` / `claude-home/settings.json` 的 `env` 传递 API 环境变量，且 profile 优先。
7. 将 `session-env` 和 `sessions` 视为 Claude Code 创建的 profile 状态，不要检视或迁移其内容。
8. 将 `autoMemoryDirectory` 固定为当前 profile 的 `claude-home\memory\auto` / `claude-home/memory/auto`，防止 auto memory 串到其他 profile。
