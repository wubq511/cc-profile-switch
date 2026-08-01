#!/usr/bin/env python3
# Throwaway PTY smoke driver for the local Skill install prototype (issue #30).
# Rebuilds the true screen via pyte after each step and asserts markers.
# Run from the repo root (build first, then drive it in a PTY):
#   npx esbuild src/tui/prototype-workbench/index.mts --bundle --format=esm --platform=node --packages=external --outfile=node_modules/.cache/ccps-proto-workbench.mjs
#   python3 -m venv node_modules/.cache/smoke-venv
#   node_modules/.cache/smoke-venv/bin/pip install pyte
#   node_modules/.cache/smoke-venv/bin/python src/tui/prototype-workbench/smoke-install.py
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
ESC, ENTER, TAB = b"\x1b", b"\r", b"\t"
UP, DOWN, LEFT, RIGHT = b"\x1b[A", b"\x1b[B", b"\x1b[D", b"\x1b[C"

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
            else:
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


def absent(*needles):
    def check_fn(text):
        for n in needles:
            if n in text:
                return f"unexpected {n!r} on screen"
        return None

    return check_fn


run(
    "O",
    [
        ("source", [], ["step 1/3 source", "Which Local Skill Source?", "commit-helper", "scratch-skill", "install: wizard cards"]),
        ("mode", [ENTER], ['Install "commit-helper" — as a Copy or a Link?', "Copy", "(default)", "Link", "Profile owns an independent", "Profile uses the source live."]),
        ("confirm-copy", [ENTER], ['Confirm — install "commit-helper" (Copy)', "create  ", "skills-provenance.json", "✓ source readable · SKILL.md found", "[enter] install"]),
        ("back-to-mode", [ESC], ["2/3 copy or link"]),
        ("confirm-link", [RIGHT, ENTER], ['Confirm — install "commit-helper" (Link)', "link    ", "✓ platform can create links"]),
        ("denied", [b"f"], ["✕ platform cannot create links", "[c] fall back to Copy", "✕ cannot install — nothing was written"]),
        ("fallback-copy", [b"c"], ['Confirm — install "commit-helper" (Copy)', "[enter] install"]),
        ("installed", [ENTER], ['installed "commit-helper" — snapshot owned by Profile "coding"', "step 1/3 source"]),
        ("collision", [DOWN, ENTER, ENTER], ['⚠ "tdd" already exists (copied)', "[v] replace it — old copy → Recovery Bin"]),
        ("rename", [b"r"], ['Confirm — install "tdd-2" (Copy)', "[enter] install", absent("already exists")]),
        ("install-renamed", [ENTER], ['installed "tdd-2"']),
        ("invalid-source", [DOWN, DOWN, ENTER, ENTER], ["✕ no SKILL.md in source — not a Skill", "✕ cannot install — nothing was written"]),
    ],
)

run(
    "P",
    [
        ("initial", [], ["1 · Local Skill Source", "2 · Install as", "3 · Preview & checks", "● Copy", "○ Link", "create  ", "✓ source readable", "install: one-screen sheet"]),
        ("link-mode", [TAB, RIGHT], ["● Link", "link    ", "✓ platform can create links"]),
        ("denied", [b"f"], ["✕ platform cannot create links", "[c] fall back to Copy"]),
        ("fallback", [TAB, b"c"], ["● Copy", "create  "]),
        ("collision", [TAB, DOWN], ['⚠ "tdd" exists (copied)', '[r] rename → "tdd-2"']),
        ("rename-install", [TAB, TAB, b"r", ENTER], ['installed "tdd-2"']),
    ],
)

run(
    "Q",
    [
        ("picker", [], ["Which Local Skill Source?", "commit-helper", "install: compare futures"]),
        ("compare", [ENTER], ["▶ If you Copy (default)", "If you Link", "coding › Skills becomes:", "← new", "source edits → appear live", "remove → link only, source kept", "update → re-copy (undo 3 days)"]),
        ("select-link", [RIGHT], ["▶ If you Link"]),
        ("denied", [b"f"], ["✕ platform cannot create links", "this future is unavailable"]),
        ("link-blocked", [ENTER], ["✕ Link is unavailable here — nothing written; the Copy future still works"]),
        ("take-copy", [LEFT, ENTER], ['installed "commit-helper" — snapshot owned by Profile "coding"']),
        ("collision", [DOWN, ENTER], ['⚠ "tdd" exists (copied)', '[r] rename → "tdd-2"', "old copy → Recovery Bin"]),
        ("rename-take", [b"r", ENTER], ['installed "tdd-2"']),
    ],
)

if failures:
    print("\n\n".join(failures))
    sys.exit(1)
print("smoke OK — O/P/Q install variants verified on a real PTY screen")
