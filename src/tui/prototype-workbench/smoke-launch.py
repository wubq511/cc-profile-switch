#!/usr/bin/env python3
# Throwaway PTY smoke driver for the launch-flow prototype (issue #32).
# Rebuilds the true screen via pyte after each step and asserts markers,
# including the two poles' real process behavior: J resumes the Workbench
# after the Claude stand-in exits; K exits to the shell with a reopen hint.
# Run from the repo root (build first, then drive it in a PTY):
#   npx esbuild src/tui/prototype-workbench/index.mts --bundle --format=esm --platform=node --packages=external --outfile=node_modules/.cache/ccps-proto-workbench.mjs
#   python3 -m venv node_modules/.cache/smoke-venv
#   node_modules/.cache/smoke-venv/bin/pip install pyte
#   node_modules/.cache/smoke-venv/bin/python src/tui/prototype-workbench/smoke-launch.py
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

import pyte

BUNDLE = "node_modules/.cache/ccps-proto-workbench.mjs"
ESC, ENTER, DOWN, UP, TAB = b"\x1b", b"\r", b"\x1b[B", b"\x1b[A", b"\t"

failures = []


def screen_text(screen):
    return "\n".join(screen.display)


def run(variant, steps):
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 140, 0, 0))
        env = dict(os.environ, CCPS_PROTO_VARIANT=variant, TERM="xterm-256color", SHELL="/bin/bash")
        os.execvpe("node", ["node", BUNDLE], env)
    screen = pyte.Screen(140, 34)
    stream = pyte.ByteStream(screen)
    screen.set_mode(pyte.modes.LNM)

    def drain(dur):
        end = time.time() + dur
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                stream.feed(data)

    def check(tag, expects):
        text = screen_text(screen)
        if "ERROR" in text:
            failures.append(f"{variant}/{tag}: Ink ERROR overlay on screen\n{text}")
            return
        for e in expects:
            if e not in text:
                failures.append(f"{variant}/{tag}: MISSING {e!r}\n--- screen ---\n{text}\n---")

    drain(1.5)
    for tag, keys, pause, expects in steps:
        for k in keys:
            os.write(fd, k)
            drain(0.4)
        drain(pause)
        check(tag, expects)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        try:
            w, _ = os.waitpid(pid, os.WNOHANG)
            if w == pid:
                break
        except ChildProcessError:
            break
        time.sleep(0.4)
    os.close(fd)


run(
    "J",
    [
        ("initial", [], 0.6, ["launch: here · resume", "launch directory:", "[l] launch · [d] dry-run plan"]),
        ("prelaunch-bar", [b"l"], 0.6, ["Launch coding →", "[enter] launch · [d] dry-run plan · [esc] cancel"]),
        ("dry-run", [b"d"], 0.6, ['Launch dry-run for profile "coding"', "CLAUDE_CONFIG_DIR=", "Dry run: Claude Code was not started."]),
        ("blocked", [ESC, DOWN, DOWN, b"l"], 0.6, ['"experiments" is not launch-ready — 2 error findings', "REQUIRED_FILE_MISSING", "ccps validate"]),
        ("launch", [ESC, UP, UP, b"l", ENTER], 2.0, ["Claude Code starts here (STAND-IN", "CLAUDE_CONFIG_DIR=~/.cc-profile-switch/profiles/coding/claude-home"]),
        ("claude-exit-resume", [b"exit\r"], 2.5, ['Workbench resumed on "coding"', "launch: here · resume"]),
    ],
)

run(
    "K",
    [
        ("initial", [], 0.6, ["launch: sheet · exit", "[l] launch — pick the project directory, then go"]),
        ("sheet", [b"l"], 0.6, ["Launch: coding", "project directory:", "(where ccps started)"]),
        ("tab-recents", [TAB], 0.6, ["~/work/api-server ✓"]),
        ("dry-inline", [b"d"], 0.6, ['Launch dry-run for profile "coding"', "Cwd: ~/work/api-server"]),
        ("blocked-sheet", [ESC, DOWN, DOWN, b"l"], 0.6, ["not launch-ready — 2 error findings", "launch — disabled"]),
        ("launch-exit", [ESC, UP, UP, b"l", ENTER], 2.0, ["Claude Code starts here (STAND-IN"]),
        ("shell-return", [b"exit\r"], 2.5, ["Claude Code exited", "Reopen Profile Workbench with: ccps"]),
    ],
)

run(
    "L",
    [
        ("initial", [], 0.6, ["launch: combined", "[l] launch here · [L] launch elsewhere · [d] dry-run"]),
        ("bar", [b"l"], 0.6, ["Launch coding →", "after-exit:", "resume [t]", "[L] choose directory"]),
        ("dirs", [b"L"], 0.6, ["choose the project directory", "(where ccps started)", "~/work/api-server"]),
        ("pick-recent", [TAB], 0.6, ["~/work/api-server ✓"]),
        ("dry-fullscreen", [b"d"], 0.6, ['Launch dry-run for profile "coding"', "Cwd: ~/work/api-server", "Dry run: Claude Code was not started."]),
        ("blocked-inline", [ESC, ESC, DOWN, DOWN, b"l"], 0.6, ["REQUIRED_FILE_MISSING", "resolve the error findings to enable launch", "[enter] launch (disabled)"]),
        ("toggle-exit", [ESC, UP, UP, b"l", b"t"], 0.6, ["after-exit: exit [t]"]),
        ("launch-exit-pole", [ENTER], 2.0, ["Claude Code starts here (STAND-IN", "[claude-stand-in]"]),
        ("shell-return", [b"exit\r"], 2.5, ["Claude Code exited", "Reopen Profile Workbench with: ccps"]),
    ],
)

if failures:
    print("\n\n".join(failures))
    sys.exit(1)
print("smoke OK — J resume and K exit poles verified on a real PTY screen")
