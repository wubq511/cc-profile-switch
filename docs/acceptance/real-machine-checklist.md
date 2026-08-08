# Real-Machine Acceptance Checklist — Issue #79

This checklist covers the CI-unobservable acceptance dimensions that require
real hardware, real terminals, and real OS-level semantics. It is executed
manually before every release and the results are recorded in the release notes.

**Executor:** ________ (name)
**Date:** ________
**Machine:** ________ (model / OS version / Node version)
**ccps version:** ________

---

## 1. Terminal Environments

### 1.1 Windows Terminal (Windows 10/11)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| W1 | `ccps` launches Workbench in Windows Terminal | ☐ Pass / ☐ Fail | |
| W2 | Alternate screen enters and exits cleanly (no residual output) | ☐ Pass / ☐ Fail | |
| W3 | CJK characters render with correct width (no misalignment) | ☐ Pass / ☐ Fail | |
| W4 | Emoji in profile/skill names display without breaking layout | ☐ Pass / ☐ Fail | |
| W5 | Resize handling: live re-layout at any terminal size | ☐ Pass / ☐ Fail | |
| W6 | 80×24 degraded mode: operable, no truncated destructive confirmations | ☐ Pass / ☐ Fail | |
| W7 | `NO_COLOR=1`: full operability, no color-only information channels | ☐ Pass / ☐ Fail | |
| W8 | Search (`/`): type `stu`, tree filters, `esc` clears | ☐ Pass / ☐ Fail | |
| W9 | Launch (`l`): Claude spawns with correct `CLAUDE_CONFIG_DIR` | ☐ Pass / ☐ Fail | |
| W10 | Resume: Claude exits → Workbench re-renders, "Claude exited (N)" flash | ☐ Pass / ☐ Fail | |

### 1.2 conhost (Windows Command Prompt, degraded)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| C1 | `ccps` launches in conhost (may be degraded) | ☐ Pass / ☐ Fail | |
| C2 | Core navigation works (arrow keys, enter, esc) | ☐ Pass / ☐ Fail | |
| C3 | Alternate screen cleanup on exit | ☐ Pass / ☐ Fail | |
| C4 | CJK rendering (may be degraded — document behavior) | ☐ Pass / ☐ Fail / ☐ N/A | |

### 1.3 Terminal.app (macOS)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| T1 | `ccps` launches Workbench in Terminal.app | ☐ Pass / ☐ Fail | |
| T2 | Alternate screen enters and exits cleanly | ☐ Pass / ☐ Fail | |
| T3 | CJK characters render with correct width | ☐ Pass / ☐ Fail | |
| T4 | Emoji in profile/skill names display without breaking layout | ☐ Pass / ☐ Fail | |
| T5 | Resize handling: live re-layout | ☐ Pass / ☐ Fail | |
| T6 | 80×24 degraded mode: operable | ☐ Pass / ☐ Fail | |
| T7 | `NO_COLOR=1`: full operability | ☐ Pass / ☐ Fail | |
| T8 | Search (`/`): type `stu`, tree filters, `esc` clears | ☐ Pass / ☐ Fail | |
| T9 | Launch (`l`): Claude spawns with correct `CLAUDE_CONFIG_DIR` | ☐ Pass / ☐ Fail | |
| T10 | Resume: Claude exits → Workbench re-renders | ☐ Pass / ☐ Fail | |

### 1.4 VS Code Integrated Terminal (both platforms)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| V1 | `ccps` launches in VS Code integrated terminal | ☐ Pass / ☐ Fail | |
| V2 | Alternate screen enters and exits cleanly | ☐ Pass / ☐ Fail | |
| V3 | CJK rendering | ☐ Pass / ☐ Fail | |
| V4 | Resize handling | ☐ Pass / ☐ Fail | |
| V5 | Launch (`l`): Claude spawns correctly | ☐ Pass / ☐ Fail | |
| V6 | Resume: Claude exits → Workbench re-renders | ☐ Pass / ☐ Fail | |

---

## 2. Launch / Resume Chain

| # | Check | Result | Notes |
|---|-------|--------|-------|
| L1 | Launch from `/path/to/project` → child cwd is exactly that directory | ☐ Pass / ☐ Fail | |
| L2 | No `--add-dir` in spawn args | ☐ Pass / ☐ Fail | |
| L3 | `CLAUDE_CONFIG_DIR` points to the profile's `claude-home` | ☐ Pass / ☐ Fail | |
| L4 | macOS PTY wrapper (`script -q /dev/null …`) applies | ☐ Pass / ☐ Fail / ☐ N/A | |
| L5 | SIGCHLD path: Claude exits → parent receives signal → Workbench resumes | ☐ Pass / ☐ Fail / ☐ N/A | |
| L6 | Resume with non-zero exit code: "Claude exited (N)" flash shown | ☐ Pass / ☐ Fail | |
| L7 | Dry-run (`d`) plan matches real launch plan (same env, same dir) | ☐ Pass / ☐ Fail | |

---

## 3. Windows Junction Install

| # | Check | Result | Notes |
|---|-------|--------|-------|
| J1 | Linked Skill on Windows creates a junction (not symlink) | ☐ Pass / ☐ Fail / ☐ N/A | |
| J2 | Junction target absent → P7 pathology observable | ☐ Pass / ☐ Fail / ☐ N/A | |
| J3 | Removing a Linked Skill only deletes the junction, not the source | ☐ Pass / ☐ Fail / ☐ N/A | |
| J4 | Junction-based Skill content is live (source edit → content updates) | ☐ Pass / ☐ Fail / ☐ N/A | |

---

## 4. Editor Handoff

| # | Check | Result | Notes |
|---|-------|--------|-------|
| E1 | `e` opens VS Code (or system editor) on the selected resource | ☐ Pass / ☐ Fail | |
| E2 | `✎ watching` badge appears while editor is open | ☐ Pass / ☐ Fail | |
| E3 | External save → preview refreshes with `updated HH:MM:SS` stamp | ☐ Pass / ☐ Fail | |
| E4 | File renamed externally → `missing` state with warning | ☐ Pass / ☐ Fail | |
| E5 | File restored → watching resumes | ☐ Pass / ☐ Fail | |
| E6 | VS Code unavailable → inline error with fallback options | ☐ Pass / ☐ Fail | |

---

## 5. CJK Rendering

| # | Check | Result | Notes |
|---|-------|--------|-------|
| K1 | CJK profile names display with correct East Asian Width | ☐ Pass / ☐ Fail | |
| K2 | CJK skill/agent names in sidebar tree align correctly | ☐ Pass / ☐ Fail | |
| K3 | CJK in descriptions does not break card layout | ☐ Pass / ☐ Fail | |
| K4 | Emoji in names do not break alignment or truncate mid-character | ☐ Pass / ☐ Fail | |
| K5 | Chrome uses BMP glyphs only (● ✓ ⚠ ✗), no emoji | ☐ Pass / ☐ Fail | |
| K6 | `zh` locale: Chinese UI renders correctly | ☐ Pass / ☐ Fail | |

---

## 6. Permission Bits

| # | Check | Result | Notes |
|---|-------|--------|-------|
| P1 | Export with `--include-secrets` → file written with mode 0600 | ☐ Pass / ☐ Fail / ☐ N/A | |
| P2 | On Windows: verify ACL restricts to current user only | ☐ Pass / ☐ Fail / ☐ N/A | |

---

## 7. Performance Thresholds (Real Machine)

Run `tsx test/perf/harness.ts --tier baseline --iterations 20` and record:

| Metric | Threshold | Measured (p95) | Pass? |
|--------|-----------|----------------|-------|
| Cold start to interactive | ≤ 400 ms | ________ ms | ☐ / ☐ |
| Keystroke to repaint | ≤ 50 ms | ________ ms | ☐ / ☐ |
| Search filtering per keystroke | ≤ 100 ms | ________ ms | ☐ / ☐ |

Run `tsx test/perf/harness.ts --tier 3x --iterations 10` and record:

| Metric | Threshold | Measured (max) | Pass? |
|--------|-----------|----------------|-------|
| Any single operation | ≤ 2 s or loading state | ________ ms | ☐ / ☐ |

---

## 8. Verdict

- [ ] All checks pass on **macOS** (Terminal.app + VS Code terminal)
- [ ] All checks pass on **Windows** (Windows Terminal + conhost + VS Code terminal)
- [ ] Performance thresholds met on real hardware
- [ ] Results recorded in release notes

**Overall verdict:** ☐ PASS — release gate open / ☐ FAIL — blocks release

**Failures requiring resolution:**

-
-

---

## Automated Evidence (macOS)

The following can be filled in by running the automated harness:

```bash
# Run the perf harness
tsx test/perf/harness.ts --tier baseline --iterations 20 --out docs/acceptance/baseline-perf.json
tsx test/perf/harness.ts --tier 3x --iterations 10 --out docs/acceptance/3x-perf.json

# Run the full test suite
npm run check
```
