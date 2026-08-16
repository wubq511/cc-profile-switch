# Real-Machine Acceptance Results — 2026-08-15

> ⚠️ **SUPERSEDED / 已作废**：下表中的 fail/skip 行来自修复前一轮运行的向导断点续跑状态，不代表最终验收结论。最终结果以 issue #87 的关闭评论为准（2026-08-15，owner 真机复测 macOS 全项 PASS；当时表中的真实问题已在 #101 修复；Windows 部分由 owner 明确暂缓）。本文件仅作为过程记录保留。

- Executor: robert
- Machine: arm64 / macOS 26.5.2
- Node: v26.0.0（验收矩阵 22/24 LTS，偏差已注明；矩阵由 CI 覆盖）
- ccps: 0.1.0 @ 9b7a592（branch feature/profile-workbench）
- Source: issue #87 / docs/acceptance/real-machine-checklist.md

| Section | Verdict | Notes |
|---|---|---|
| §1.3 Terminal.app T1–T10 | skip | — |
| §1.4 VS Code 终端 V1–V6 | skip | 这里是的“显闪存是什么意思“ |
| Ghostty 冒烟（额外） | skip | 我不知道我们用CCPS启动Claude Code是什么情况，反正就是API那里有问题。但是我在终端里用原生的启动方式是能够正常使用的。这个问题等一下我们继续讨论，我到时候讨论时候我把具体的情况发给你 |
| §2 启动/恢复链 L1–L7 | fail | 在真实的使用中发现了不少问题。这时候，到时候我们在会话里具体讨论，不然我在这里有一些截图都没办法发给你 |
| §4 编辑器接力 E1–E6 | fail | 显示正在打开VS Code，但实际上就是我看电脑上有一个反应，就是VS Code跳了一下，但是实际上并没有打开 |
| §5 CJK 渲染 K1–K6 | pass | — |
| §7 性能复测（baseline+3x） | pass | baseline p95: cold-start 12.5ms / keystroke 0.12ms / search 0.02ms / content-search 5.37ms；3x 单操作 max 45.53ms（Node v26.0.0） |
| Windows 部分（§1.1/§1.2/§3/P2/V-win） | pending-external | macOS 侧已完成；Windows 侧待真机执行 |

**macOS-side verdict: FAIL**
