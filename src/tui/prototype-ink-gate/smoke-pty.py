#!/usr/bin/env python3
# Throwaway PTY smoke driver for the Ink packaging gate (issue #36).
# Rebuilds the true screen via pyte after each step and asserts markers.
# POSIX only; skips with a note elsewhere. Run from the repo root:
#   npm run build
#   python3 -m venv node_modules/.cache/smoke-venv
#   node_modules/.cache/smoke-venv/bin/pip install pyte
#   node_modules/.cache/smoke-venv/bin/python src/tui/prototype-ink-gate/smoke-pty.py
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time

if os.name != "posix":
    print("SKIP — PTY smoke requires a POSIX platform")
    sys.exit(0)

import pyte

BUNDLE = "dist/ink-gate-workbench.mjs"
CJK_TEXT = "配置切换プロファイル"
ALT_OFF = b"\x1b[?1049l"
CURSOR_SHOW = b"\x1b[?25h"
FOCUS_ON = b"\x1b[?1004h"
FOCUS_OFF = b"\x1b[?1004l"

failures = []


def screen_text(screen):
    return "\n".join(screen.display)


def check(tag, text, expects):
    if "ERROR" in text:
        failures.append(f"{tag}: Ink ERROR overlay on screen\n{text}")
        return
    for e in expects:
        if e not in text:
            failures.append(f"{tag}: MISSING {e!r}\n--- screen ---\n{text}\n---")


def main():
    if not os.path.exists(BUNDLE):
        print(f"{BUNDLE} missing — run `npm run build` first")
        sys.exit(1)

    pid, fd = os.forkpty() if hasattr(os, "forkpty") else (None, None)
    if pid is None:
        import pty

        pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = dict(os.environ, TERM="xterm-256color")
        env.pop("CCPS_INK_GATE_AUTORUN", None)
        os.execvpe("node", ["node", BUNDLE], env)

    screen = pyte.Screen(100, 30)
    stream = pyte.ByteStream(screen)
    screen.set_mode(pyte.modes.LNM)
    raw = bytearray()

    def drain(dur):
        end = time.time() + dur
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                raw.extend(data)
                stream.feed(data)

    def resize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)

    # --- initial screen at 100x30 -------------------------------------------
    drain(2.0)
    check(
        "initial",
        screen_text(screen),
        ["INK-GATE prototype · issue #36 · size: 100x30", "key: none · focus:", "ruler |0123456789"],
    )

    # --- resize to 60x20 ------------------------------------------------------
    resize(20, 60)
    screen.resize(20, 60)
    drain(1.0)
    check("resize", screen_text(screen), ["size: 60x20"])

    # --- key echo --------------------------------------------------------------
    os.write(fd, b"\x1b[B")  # arrow down
    drain(0.6)
    check("key-down", screen_text(screen), ["key: down"])
    os.write(fd, b"k")
    drain(0.6)
    check("key-letter", screen_text(screen), ['key: "k"'])

    # --- CJK width alignment ---------------------------------------------------
    # Find the cjk line in pyte's cell buffer: the end marker must sit at
    # display column 27 (7-column prefix + 20-column CJK string), under ruler
    # digit index 20.
    cjk_row = None
    for row in range(20):
        line = "".join(screen.buffer[row][col].data for col in range(60))
        if CJK_TEXT in line:
            cjk_row = row
            break
    if cjk_row is None:
        failures.append(f"cjk-align: cjk line not found\n--- screen ---\n{screen_text(screen)}\n---")
    else:
        marker = screen.buffer[cjk_row][27].data
        if marker != "│":
            cells = "".join(screen.buffer[cjk_row][col].data or "·" for col in range(35))
            failures.append(f"cjk-align: marker at col 27 is {marker!r}, expected '│'\nrow: {cells}")
        ruler_row = cjk_row - 1
        if screen.buffer[ruler_row][27].data != "0":
            failures.append(
                f"cjk-align: ruler digit above marker is "
                f"{screen.buffer[ruler_row][27].data!r}, expected '0' (column 20)"
            )

    # --- VS Code handoff --------------------------------------------------------
    os.write(fd, b"v")
    drain(2.5)
    if b"INK-GATE-HANDOFF-CHILD" not in bytes(raw):
        failures.append("handoff: child marker missing from raw output")
    check("handoff-resume", screen_text(screen), ["refreshed after handoff #1"])

    # --- clean quit + cleanup sequences ------------------------------------------
    os.write(fd, b"q")
    deadline = time.time() + 5
    status = None
    while time.time() < deadline:
        drain(0.2)
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done = pid
            status = 0
        if done == pid:
            break
    else:
        failures.append("quit: process did not exit after 'q'")
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)

    if status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) != 0:
        failures.append(f"quit: exit code {os.WEXITSTATUS(status)}, expected 0")

    tail = bytes(raw)
    for name, seq in (("focus-on", FOCUS_ON), ("alt-off", ALT_OFF), ("cursor-show", CURSOR_SHOW), ("focus-off", FOCUS_OFF)):
        if seq not in tail:
            failures.append(f"cleanup: {name} sequence {seq!r} missing from byte stream")

    os.close(fd)

    if failures:
        print("\n\n".join(failures))
        sys.exit(1)
    print("smoke OK — ink gate surfaces verified on a real PTY screen")


main()
