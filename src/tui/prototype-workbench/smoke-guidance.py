#!/usr/bin/env python3
# Throwaway PTY smoke driver for the guidance-density prototype (issue #29).
# Rebuilds the true screen via pyte after each step and asserts markers.
# Run from the repo root (build first, then drive it in a PTY):
#   npx esbuild src/tui/prototype-workbench/index.mts --bundle --format=esm --platform=node --packages=external --outfile=node_modules/.cache/ccps-proto-workbench.mjs
#   python3 -m venv node_modules/.cache/smoke-venv
#   node_modules/.cache/smoke-venv/bin/pip install pyte
#   node_modules/.cache/smoke-venv/bin/python src/tui/prototype-workbench/smoke-guidance.py
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
ESC, ENTER, DOWN, LEFT = b"\x1b", b"\r", b"\x1b[B", b"\x1b[D"
CTRL_D = b"\x04"

failures = []


def screen_text(screen):
    return "\n".join(screen.display)


def run(variant, steps):
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = dict(os.environ, CCPS_PROTO_VARIANT=variant, TERM="xterm-256color")
        os.execvpe("node", ["node", BUNDLE], env)
    screen = pyte.Screen(100, 30)
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
            if isinstance(e, str):
                if e not in text:
                    failures.append(f"{variant}/{tag}: MISSING {e!r}\n--- screen ---\n{text}\n---")
            else:  # callable(text) -> error string or None
                err = e(text)
                if err:
                    failures.append(f"{variant}/{tag}: {err}\n--- screen ---\n{text}\n---")

    drain(1.5)
    for tag, keys, expects in steps:
        for k in keys:
            os.write(fd, k)
            drain(0.4)
        drain(0.6)
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


def footer_retired(text):
    """G: after 3 launches the 'l launch' hint must be gone from the action line."""
    for line in text.splitlines():
        if "b backup" in line:
            if "l launch" in line:
                return "hint 'l launch' not retired after 3 uses"
            return None
    return "action line with 'b backup' not found"


def retired_full_screen(text):
    """I: after 3 launches the 'l launch' hint must be gone from the whole screen."""
    if "l launch" in text:
        return "hint 'l launch' not retired after 3 uses"
    if "e edit" not in text:
        return "remaining hints ('e edit') not rendered"
    return None


run(
    "F",
    [
        ("initial", [], ["Profiles (3/3)", "guidance: on-demand"]),
        ("help", [b"?"], ["Variant F — on-demand guidance · help", "Recovery Bin  temporary holding"]),
        ("confirm", [ESC, b"x"], ['Remove "coding"? backup kept']),
        ("confirm-y", [b"y"], ['removed "coding" — backup kept']),
        ("launch-error", [LEFT, DOWN, DOWN, b"l"], ['launch failed: "claude" not found on PATH']),
        ("empty", [CTRL_D, CTRL_D], ["No Profiles yet — [n] create one"]),
    ],
)

run(
    "G",
    [
        ("welcome", [], ["Welcome to Profile Workbench"]),
        ("nav", [ENTER], ["Profiles (3/3)", "l launch"]),
        ("use-l-3x", [b"l", b"l", b"l"], [footer_retired]),
        ("confirm", [b"x"], ['Remove Profile "coding"?', "back up first, then remove"]),
        ("confirm-u", [b"u"], ["without backup → Recovery Bin"]),
        ("search-tip", [b"/"], ["tip: covers names"]),
        ("empty", [ESC, CTRL_D, CTRL_D], ["A Profile is an isolated Claude Code environment"]),
    ],
)

run(
    "H",
    [
        ("tour-1", [], ["Quick tour — step 1/3"]),
        ("tour-3", [ENTER, ENTER], ["step 3/3"]),
        ("nav", [ENTER], ["Coach · Profile", "tip 1/7", "Profiles (3/3)"]),
        ("tip-next", [b"t"], ["tip 2/7"]),
        ("confirm", [b"x"], ['Remove Profile "coding"?', "back up first (default)"]),
        ("error-panel", [ESC, LEFT, DOWN, DOWN, b"l"], ["✕ launch failed", "install Claude Code"]),
    ],
)

run(
    "I",
    [
        ("welcome", [], ["Welcome to Profile Workbench"]),
        ("nav", [ENTER], ["Profiles (3/3)", "l launch", "hints fade · [?] all keys"]),
        ("search-tip", [b"/"], ["tip: searches everything"]),
        ("leave-search", [ESC], []),
        ("use-l-3x", [b"l", b"l", b"l"], [retired_full_screen]),
        ("confirm", [b"x"], ['Remove Profile "coding"?', "back up first, then remove"]),
        ("confirm-u", [b"u"], ["without backup → Recovery Bin"]),
        ("help", [b"?"], ["keys & concepts", "Linked Skill  shares a local source", "Recovery Bin  temporary holding"]),
        ("error-panel", [ESC, LEFT, DOWN, DOWN, b"l"], ["✕ launch failed", "install Claude Code"]),
        ("empty", [CTRL_D, CTRL_D], ["A Profile is an isolated Claude Code environment"]),
    ],
)

if failures:
    print("\n\n".join(failures))
    sys.exit(1)
print("smoke OK — F/G/H/I guidance surfaces verified on a real PTY screen")
