# Profile Workbench 跨平台 TUI 框架边界

日期：2026-07-30
决策票：[Verify the cross-platform TUI framework boundary](https://github.com/wubq511/cc-profile-switch/issues/26)

## 结论

**选择 Ink 7.x 作为 Profile Workbench 的首选 UI 基础，但采用隔离的 ESM Workbench 入口；保留现有 CommonJS `ccps` 入口、Commander 命令与 core services。正式实现前必须通过一次 Windows + macOS 原型门槛。**

具体边界：

1. `dist/index.js` 继续是 CommonJS 可执行入口，普通 `ccps <command>` 不加载 React/Ink。
2. 仅当交互式 TTY 进入 Workbench 时，CommonJS 入口通过动态 `import()` 加载独立 ESM Workbench；Node 官方支持在 CommonJS 中用动态 `import()` 加载 ES modules。[Node.js ESM interoperability](https://nodejs.org/download/release/latest-v24.x/docs/api/esm.html#interoperability-with-commonjs)
3. 最低 Node.js 版本定为 `>=22`。Ink 7.1.1 是 ESM-only、要求 Node `>=22`，并要求 React `>=19.2.0`；Node 22 当前仍是 LTS。[Ink 7.1.1 package](https://github.com/vadimdemedes/ink/blob/v7.1.1/package.json) · [Node.js releases](https://nodejs.org/en/about/previous-releases)
4. Workbench 只能调用共享 core services，不在 React components 内复制路径、安全、备份、删除或启动规则。现有可脚本化 CLI 继续是自动化与无障碍兜底面。
5. 这是一项**有条件的框架决定**：Ink 上游没有 Windows/macOS CI 证据，且当前测试辅助包与 Ink 7 的兼容性没有明确声明。原型失败时，CommonJS 备选是 Terminal Kit；不采用 blessed/neo-blessed；OpenTUI 暂留观察名单。

在已确认的终端优先产品范围内，没有发现必须改用本地 Web 的框架级限制。Web 是否进入范围仍应由导航原型而非本研究决定。

## 当前项目约束

当前代码给出的约束比框架宣传页更重要：

- 包声明为 `"type": "commonjs"`，唯一 bin 是 `dist/index.js`；生产依赖只有 Commander、fs-extra、picocolors 和 Zod。[package.json at baseline](https://github.com/wubq511/cc-profile-switch/blob/86f922706269330ee4ce0e8590f89093865980f4/package.json#L1-L51)
- `tsup` 当前只构建 CJS 并以 Node 20 为 target；采用 Ink 7 必须把最低 runtime 明确提升到 Node 22，而不能把它伪装成不影响兼容性的 UI dependency 更新。[tsup.config.ts at baseline](https://github.com/wubq511/cc-profile-switch/blob/86f922706269330ee4ce0e8590f89093865980f4/tsup.config.ts#L1-L10)
- 当前所谓 TUI 是 `readline/promises` 驱动的编号菜单，不是常驻全屏界面。[terminal.ts at baseline](https://github.com/wubq511/cc-profile-switch/blob/86f922706269330ee4ce0e8590f89093865980f4/src/tui/terminal.ts#L1-L87)
- 当前 controller 已通过 ports 调用共享 profile services；这个分层应保留，但需要从“一次一个 prompt”演进为可订阅的 Workbench state/actions，而不是把业务规则搬进视图。[controller.ts at baseline](https://github.com/wubq511/cc-profile-switch/blob/86f922706269330ee4ce0e8590f89093865980f4/src/tui/controller.ts#L39-L114)
- 当前测试可注入 input/output/services，证明 core 与 terminal adapter 可以分开验证；框架替换不应丢掉这个确定性。[tui-terminal.test.ts at baseline](https://github.com/wubq511/cc-profile-switch/blob/86f922706269330ee4ce0e8590f89093865980f4/test/tui-terminal.test.ts#L5-L82)
- 产品只承诺 Windows 与 macOS；Linux 不属于本次决策。完整 Workbench 还必须支持 Profile-first 浏览、跨 Profile 搜索、资源预览，以及挂起到 VS Code 后恢复。

## 候选比较

| 候选                                       | Node / 模块与打包                                                                                                     | Workbench 交互适配                                                                                                     | 输入、resize、无障碍                                                                                    | 测试与跨平台证据                                                                            | 决定                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Ink 7.1.1**                              | ESM-only；Node `>=22`；React `>=19.2`；JS 依赖面明显增大，但没有 OpenTUI 那类按 OS/CPU 分发的原生包                   | React + Yoga/Flexbox 适合 Profile 列表、资源树、预览、状态栏、modal；原生支持 alternate screen 与子进程 suspend/resume | `useInput`、focus、`useWindowSize`；基础 screen-reader 模式与一小部分 ARIA 语义；核心未提供鼠标组件模型 | 有静态 `renderToString` 和 `ink-testing-library`；Ink 上游 CI 只有 Ubuntu Node 22/24        | **首选，但须通过本项目 Windows/macOS 原型**  |
| **OpenTUI 0.4.5**                          | ESM + Zig native core；Node renderer 要求 Node 26.4 + experimental FFI；发布包含 8 个 OS/CPU native optional packages | 内建 Select、ScrollBox、Markdown、Code、Diff 等，能力最强                                                              | 完整键盘、鼠标、resize 与 capability 模型；官方文档未给出可替代 Ink screen-reader 模式的语义层          | 官方 test renderer 很强，可确定性驱动 keyboard、mouse、resize、clock 和 frames              | **当前淘汰；等 LTS Node 无实验 FFI 后重评**  |
| **Inquirer 8.5.2 代表的增强 prompt stack** | ESM；支持 Node 20.17、22.13、23.5+；可从 CJS 动态加载                                                                 | Search、Select、Checkbox、Editor 适合向导与确认，但一次一个 prompt，无法提供常驻的列表 + 资源树 + 预览上下文           | 依赖 raw TTY；可注入 input/output；没有 Workbench 级 layout、focus graph 或 screen-reader semantic tree | 官方有 unit/E2E testing，CI 覆盖 Ubuntu + Windows，但没有 macOS                             | **只作非全屏向导/降级，不作 Workbench 基础** |
| **Terminal Kit 3.1.4**                     | CommonJS；Node `>=16.13`；8 个直接 runtime dependencies；包内没有 first-party TypeScript 类型入口                     | Document model 有多 widget、focus、menu、form、text box 和 screen buffer，能承载 Workbench                             | 提供 key、mouse、resize events；主文档未定义 screen-reader 语义                                         | 有项目测试，但没有消费端 test renderer 或公开 Windows/macOS CI；document model 文档仍在完善 | **Ink 原型失败时的 CommonJS 备选**           |
| **neo-blessed 0.2.0**                      | CommonJS；发布于 2018；widget 丰富                                                                                    | 传统 full-screen TUI 能力足够                                                                                          | 官方明确写明 Windows 没有 mouse 或 resize event                                                         | 官方说明多数测试是交互式、由人判断显示是否正确                                              | **淘汰**                                     |

## 为什么首选 Ink

### 1. 它覆盖本产品真正需要的交互，而不是只让 prompt 更漂亮

Ink 的 `Box`/Flexbox、focus management、`useInput` 和 `useWindowSize` 能表达常驻的 Profile 列表、Profile 内资源导航、内容预览、命令提示与 modal，并在 resize 时重算布局。[Ink layout and hooks](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#hooks)

对长文本默认打开 VS Code 的决定也有直接支撑：Ink 7 的 `suspend(callback)` 会暂时停止输出和输入、退出 alternate screen、恢复 cursor/raw-mode 等终端状态，回调结束后重新应用状态并完整重绘；文档明确把 `$EDITOR`、`less`、`fzf` 列为使用场景。[Ink `suspend`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#suspendcallback)

`alternateScreen` 是正式 render option，在交互模式中使用独立 screen buffer，并在退出后恢复原终端内容；非交互输出会忽略它。[Ink alternate screen option](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#alternatescreen)

这三项使 Ink 比 Inquirer/Clack 一类逐步 prompt 更符合“完整 Workbench”，同时避免自行实现 terminal diff renderer、focus、raw input 和恢复逻辑。

### 2. 输入与 resize API 足够，但跨平台结论不能从 API 名称推断

Ink 提供：

- `useInput` 处理字符与常见 special keys，并能按 `isActive` 控制多个 handler；[Ink `useInput`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#useinputinputhandler-options)
- `useStdin().isRawModeSupported`，允许在没有 raw-mode 的输入流上显式降级；[Ink `useStdin`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#usestdin)
- `useWindowSize` 在终端 resize 时返回新 columns/rows 并触发 render，同时警告缩窄时某些 emulator 可能短暂出现 ghost lines；[Ink `useWindowSize`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#usewindowsize)
- `useFocus` / `useFocusManager` 提供 Tab focus 与显式 focus id。[Ink focus management](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#usefocusoptions)

Node 自身为 TTY write stream 定义了稳定的 `resize` event，并为 stdin 定义了 raw mode；但 raw mode 会关闭默认 `Ctrl+C` 信号处理，因此应用必须负责清理和退出。[Node.js TTY API](https://nodejs.org/download/release/latest-v24.x/docs/api/tty.html)

限制是：Ink 7.1.1 的上游 workflow 只在 Ubuntu 上测试 Node 22 与 24，没有 Windows/macOS runner。[Ink 7.1.1 test workflow](https://github.com/vadimdemedes/ink/blob/v7.1.1/.github/workflows/test.yml) 因此“底层使用 Node TTY”不能替代本项目的 Windows Terminal 与 macOS Terminal 验证。

键盘基线只能依赖各平台普遍存在的按键：字符、方向键、Tab/Shift+Tab、Enter、Escape、Backspace、Page Up/Down 与 `Ctrl+C`。Kitty keyboard、Super/Hyper、鼠标、key release/repeat 可增强，但不能成为完成核心任务的唯一方式。

### 3. 它提供当前候选中最明确的无障碍起点

Ink 文档将支持程度明确称为“basic”：可通过 render option 或 `INK_SCREEN_READER=true` 开启，并提供 `aria-label`、`aria-hidden`、有限 `aria-role` 与 `aria-state`，还可用 `useIsScreenReaderEnabled` 输出不同内容。[Ink screen-reader support](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#screen-reader-support)

这不是“已经无障碍”的证明。Workbench 仍需：

- screen-reader 模式下使用稳定的线性阅读顺序，不依赖空间位置表达关系；
- 所有动作保留可脚本化 CLI 等价路径；
- 状态不只用颜色表达；
- 键盘完成全部核心任务，鼠标只作可选增强；
- 原型中由真实 screen-reader 使用路径验证，而不只检查 ARIA props。

Terminal Kit、OpenTUI 与 prompt 候选的主要官方文档没有定义同等的 screen-reader 语义协议，所以不能把其丰富 widget 直接等同于无障碍。

### 4. 测试能力可用，但 Ink 7 的测试包兼容性必须现场证明

Ink 7 自带 `renderToString(tree, {columns})`，不会启动持久 terminal listeners，适合固定宽度的静态 layout/empty/error view 测试。[Ink `renderToString`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#rendertostringtree-options)

官方 README 推荐 `ink-testing-library`；它可注入 stdin、读取 last frame/frames 并 rerender。[Ink testing](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#testing) · [ink-testing-library 4 API](https://github.com/vadimdemedes/ink-testing-library/blob/v4.0.0/readme.md)

不过 `ink-testing-library` 4.0.0 发布于 2024，其自身开发依赖仍是 Ink `^5.0.0`，也没有声明 Ink peer dependency。[ink-testing-library 4 package](https://github.com/vadimdemedes/ink-testing-library/blob/v4.0.0/package.json) 所以报告不把“与 Ink 7 完全兼容”当作已证事实。原型必须证明输入、resize、focus 和 cleanup 测试能在 Vitest 4 下稳定运行；否则为 Ink 7 建立最小 fake TTY adapter，而不是让 UI 测试依赖真实终端。

## 为什么其他候选不作为首选

### OpenTUI：能力很强，但当前 runtime boundary 不成立

OpenTUI 的正式测试 API 是候选中最完整的：native in-memory renderer 可确定性驱动 keyboard、mouse、resize、clock、capabilities 与 frame capture。[OpenTUI testing](https://opentui.com/docs/core-concepts/testing/)

但官方 Getting Started 明确写明：在 Node 中创建 native renderer 需要 Node 26.4.0，并启用 `--experimental-ffi`；文档示例仍以 Bun 为主。[OpenTUI runtime support](https://opentui.com/docs/getting-started/#runtime-support) 当前 `@opentui/core` 0.4.5 又是 ESM、以 Zig native core 为基础，声明 Bun engine，并按 Windows/macOS/Linux 与 x64/arm64 分发 8 个 optional native packages。[OpenTUI 0.4.5 package](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/package.json)

这会把现有“Node.js LTS + npm 安装的 TypeScript CLI”变成“特定非 LTS Node experimental FFI 或 Bun + native binary matrix”。收益虽高，但属于更改产品 runtime 和发布模型，不是 UI framework 替换。待 native renderer 可在受支持的 LTS Node 上无实验 flags 运行后再重评。

### Inquirer：适合安全向导，不适合常驻 Workbench

Inquirer 8.5.2 包含 Input、Select、Checkbox、Search、Editor 等成熟 prompt，允许注入 input/output，也有专用 unit/E2E testing utilities。[Inquirer prompts](https://github.com/SBoudrias/Inquirer.js/blob/bb3f6a525b0f02402f9395d9a6da88d33809e94a/README.md#prompts) · [Inquirer advanced streams](https://github.com/SBoudrias/Inquirer.js/blob/bb3f6a525b0f02402f9395d9a6da88d33809e94a/README.md#advanced-usage) · [Inquirer testing](https://github.com/SBoudrias/Inquirer.js/blob/bb3f6a525b0f02402f9395d9a6da88d33809e94a/packages/testing/README.md)

它的 testing 文档还明确要求多个 prompts 顺序执行，符合“向导”的状态模型，却无法自然表达同屏 Profile 列表、资源树、预览、全局搜索和上下文操作。[Inquirer sequential test note](https://github.com/SBoudrias/Inquirer.js/blob/bb3f6a525b0f02402f9395d9a6da88d33809e94a/packages/testing/README.md#important-notes)

Inquirer 可以继续用于非全屏的初始化、确认或未来降级流程；不能因为它接入成本较低就把 Workbench 退化为一串更漂亮的 questions。其上游 CI 覆盖 Ubuntu 与 Windows、多个 Node 版本，但没有 macOS runner，因此同样不能替代项目自己的双平台验证。[Inquirer CI](https://github.com/SBoudrias/Inquirer.js/blob/bb3f6a525b0f02402f9395d9a6da88d33809e94a/.github/workflows/main.yml)

### Terminal Kit：CommonJS 适配最好，但类型、测试和无障碍债务更大

Terminal Kit 3.1.4 原生 CommonJS、Node `>=16.13.0`，提供 key/mouse/resize、screen buffer，以及能同时管理多个 widgets、focus 和 event dispatch 的 document model。[Terminal Kit package](https://github.com/cronvel/terminal-kit/blob/v3.1.4/package.json) · [Terminal Kit events](https://github.com/cronvel/terminal-kit/blob/v3.1.4/doc/events.md) · [Terminal Kit document model](https://github.com/cronvel/terminal-kit/blob/v3.1.4/doc/document-model.md)

它是最可信的 CommonJS fallback，但不是首选：

- package 未声明 first-party TypeScript types；
- document model 自称“99% stable”，同时说明文档仍在进行中；
- 官方事件文档提醒部分特殊按键与鼠标能力依赖 terminal，应提供替代 bindings；
- 没有像 OpenTUI 或 Inquirer 那样的消费端 deterministic test renderer；
- 没有发现公开的 Windows/macOS CI matrix 或 screen-reader semantic contract。

如果 Ink 原型暴露无法接受的 Windows resize/cleanup 或 ESM 打包问题，才进入 Terminal Kit 原型；届时项目需自行承担 typed facade、fake terminal、focus semantics 与无障碍输出层。

### blessed / neo-blessed：直接违反 Windows 要求

neo-blessed 官方 README 明确写明 Windows 当前没有 mouse 或 resize event support，同时说明多数 tests 是 interactive、由程序员人工判断显示是否正确。[neo-blessed Windows compatibility](https://github.com/embarklabs/neo-blessed/blob/fa63a5db0e0dfbc94d50fefd7703f574466b17db/README.md#windows-compatibility) · [neo-blessed testing](https://github.com/embarklabs/neo-blessed/blob/fa63a5db0e0dfbc94d50fefd7703f574466b17db/README.md#testing)

neo-blessed 0.2.0 的 npm 发布时间是 2018-06-13；原始 blessed 0.1.81 是 2015-09-03。[neo-blessed registry metadata](https://registry.npmjs.org/neo-blessed/0.2.0) · [blessed registry metadata](https://registry.npmjs.org/blessed/0.1.81) 即使它们是 CommonJS 且 widgets 丰富，也不应进入新的双平台产品核心。

## Ink 集成边界

### 构建与加载

目标构建形态：

```text
dist/
  index.js              CommonJS bin: Commander + existing commands
  workbench.mjs         ESM: React + Ink terminal renderer
  workbench/…           可选的 ESM chunks/assets
```

规则：

- 保持 package `"type": "commonjs"` 与 bin 路径不变。
- 在 package metadata、build target、CI 与安装文档中同时声明 Node `>=22`，避免源码可以构建但发布包仍声称支持 Node 20。
- CJS entry 只在 `stdin.isTTY && stdout.isTTY` 且选择 Workbench 时执行 `await import("./workbench.mjs")`。
- 非 TTY 的裸 `ccps` 输出 help；显式脚本命令保持当前输出/exit code，不导入 UI。
- 不使用 bundler 把 Ink 改写成 `require("ink")`；产物测试必须检查没有 `ERR_REQUIRE_ESM`。
- 将 Ink/React 版本精确锁定在经过原型验证的 minor line，并记录升级验证项；不因 UI 框架改写整个项目为 ESM。
- 发布验证必须从 `npm pack` 生成的 tarball 安装，而不只运行源码。

### 代码所有权

```text
Commander / TTY router
        │
        ├── scriptable CLI adapters
        │
        └── lazy ESM Workbench renderer
                    │
              Workbench state/actions
                    │
              shared core services
                    │
        filesystem / launcher / safety policy
```

- React/Ink components 只负责 render、focus、navigation 与 intent dispatch。
- 所有写操作仍走 core services；CLI 与 Workbench 共用验证、备份、Recovery Bin、link/copy 与 credential safety。
- 网络 discovery、文件扫描与 Markdown loading 不在 render path 同步执行；通过 service/state 层异步加载。
- 旧 `TuiPorts` 可以作为迁移参考，不能强行把全屏 UI 压回 `select/input/confirmByName` 三个同步 prompt。

### 输入、resize 与退出

- 核心路径只要求键盘；鼠标不进入首版验收。
- 搜索、选择、返回、帮助、退出必须有可见 shortcuts，并允许多个等价键，避免依赖 terminal-specific modifier。
- 每次 render 根据 `useWindowSize` 选择 wide/compact/minimum layout；低于最小尺寸时显示可操作的 resize guidance，而不是截断危险确认。
- `Ctrl+C`、正常退出、异常 error boundary 与 suspended child process 都必须恢复 raw mode、cursor、alternate screen 和 stdin ownership。
- 打开 VS Code 必须走 Ink `suspend()` + 现有 platform editor service；编辑器退出或打开动作完成后刷新资源状态。
- CJK/emoji/wide-character rendering 必须进入 snapshot 与真实终端用例；不能只用 ASCII 验证列对齐。

## 正式采用前的原型门槛

只有全部通过，Ink 才从“首选”变成 production dependency：

1. **包装兼容**
   - Node 22 与 24；
   - 从 `npm pack` tarball 安装；
   - `ccps --help`、一个普通命令和裸 `ccps` 均可启动；
   - CJS CLI 不提前加载 Ink，Workbench 无 `ERR_REQUIRE_ESM`。
2. **双平台**
   - hosted `windows-latest` 与 `macos-latest` 运行 build/unit/PTY smoke；
   - Windows Terminal + PowerShell、macOS Terminal.app 至少各做一次真实交互验收；
   - iTerm2 作为推荐扩展样本，不扩大正式平台范围。
3. **输入与 focus**
   - 字符搜索、arrows、Tab/Shift+Tab、Enter、Escape、Backspace、Page Up/Down、`Ctrl+C`；
   - bracketed paste 不触发快捷键误操作；
   - 不能进入无 focus、双触发或无法退出状态。
4. **resize 与文本**
   - 至少覆盖 `120x40 → 80x24 → 60x18 → 120x40`；
   - Profile/resource selection 在 resize 后保持；
   - 中文、emoji、长路径、长 Skill 名称不破坏边界或危险提示。
5. **VS Code handoff**
   - suspend 时退出 alternate screen 并恢复 cursor/raw mode；
   - Windows/macOS editor adapter 返回后完整 redraw 和资源 refresh；
   - editor 打开失败时 Workbench 可继续使用并给出 guidance。
6. **cleanup**
   - 正常退出、`Ctrl+C`、render error、service error、suspend callback error 后终端均恢复；
   - 无残留 input listeners、隐藏 cursor 或 raw stdin。
7. **确定性测试**
   - core service tests 不依赖 Ink；
   - fixed-size static frames 可稳定断言；
   - fake input、focus、resize 与 cleanup tests 在 Vitest 4 稳定重复运行；
   - 如果 `ink-testing-library` 4 与 Ink 7 不兼容，原型必须证明最小 fake TTY adapter，而不是删掉交互测试。
8. **基础无障碍**
   - `INK_SCREEN_READER=true` 呈现线性、可理解、无动画依赖的输出；
   - 所有核心动作可键盘完成，并有 scriptable CLI 等价路径；
   - 状态和危险级别不用颜色作为唯一信号。

若失败只来自某个可隔离 adapter，可以修复后重跑；若失败来自 Windows resize/cleanup、CJS/ESM 发布产物或无法建立确定性测试，则停止 Ink 路线并对 Terminal Kit 做同样大小的原型。不能为了通过门槛降低 Windows/macOS、CLI parity 或安全要求。

## 决策摘要

- **采用方向：** Ink 7.x，独立 ESM Workbench，CJS CLI/core 保持。
- **最低 runtime：** Node `>=22`。
- **非 TTY：** 裸 `ccps` 输出 help；脚本命令不加载 Workbench。
- **测试责任：** 本项目必须补 Windows + macOS matrix；上游 CI 不能代替。
- **备选：** Terminal Kit，只在 Ink 原型触发结构性失败时启用。
- **拒绝：** blessed/neo-blessed。
- **观察：** OpenTUI，直到 LTS Node 无 experimental FFI 即可创建 renderer。
- **Web：** 当前无框架证据要求 Web fallback；继续由交互原型决定。
