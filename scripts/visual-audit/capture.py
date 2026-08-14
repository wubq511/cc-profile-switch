#!/usr/bin/env python3
"""PTY screenshot harness for the ccps Profile Workbench visual audit (issue #97).

Spawns a TUI command under a real PTY at a fixed size, feeds keystrokes from a
simple script file, and on each `shot` directive replays the accumulated raw
byte stream through @xterm/headless (reference terminal emulator, same engine
as the VS Code integrated terminal) and renders the settled frame to PNG and
plain text with Pillow.

Usage:
  capture.py --cols 80 --rows 24 --home DIR --script FILE --out DIR
             [--locale en|zh] [--no-color] [--theme dark|light|both]
             [-- cmd...]   (default: node dist/workbench.mjs)

Script DSL (one directive per line, '#' comments):
  send <text>          literal text; escapes: \\e=ESC \\n \\r \\t; keys: {UP} {DOWN}
                       {LEFT} {RIGHT} {ENTER} {ESC} {TAB} {BACKSPACE} {SPACE}
  wait <ms>            fixed delay
  shot <label>         settle, then capture <label>.png (+ .txt); theme=both also captures -light
  sh <command>         run a shell command mid-session (fixture mutations)
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import re
import select
import shlex
import struct
import subprocess
import sys
import termios
import threading
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPLAY = HERE / "replay.mjs"

# --- 16-color ANSI palette (xterm defaults) ------------------------------------

PALETTE_DARK = [
    (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16),
    (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
    (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]
PALETTE_LIGHT = [
    (0, 0, 0), (205, 0, 0), (0, 135, 0), (148, 116, 0),
    (0, 0, 238), (205, 0, 205), (0, 135, 175), (102, 102, 102),
    (0, 0, 0), (255, 0, 0), (0, 175, 0), (190, 150, 0),
    (92, 92, 255), (255, 0, 255), (0, 175, 175), (255, 255, 255),
]
THEMES = {
    "dark": {"bg": (20, 20, 20), "fg": (229, 229, 229), "palette": PALETTE_DARK},
    "light": {"bg": (255, 255, 255), "fg": (26, 26, 26), "palette": PALETTE_LIGHT},
}

FONT_LATIN = "/System/Library/Fonts/Menlo.ttc"
FONT_CJK_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]

KEY_BYTES = {
    "UP": "\x1b[A", "DOWN": "\x1b[B", "RIGHT": "\x1b[C", "LEFT": "\x1b[D",
    "ENTER": "\r", "ESC": "\x1b", "TAB": "\t", "BACKSPACE": "\x7f", "SPACE": " ",
}


def unescape(text: str) -> str:
    parts = re.split(r"\{([A-Z]+)\}", text)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            if part not in KEY_BYTES:
                raise ValueError(f"unknown key {{{part}}}")
            out.append(KEY_BYTES[part])
        else:
            out.append(part.replace("\\e", "\x1b").replace("\\n", "\n")
                         .replace("\\r", "\r").replace("\\t", "\t"))
    return "".join(out)


def palette_256(index: int) -> tuple[int, int, int]:
    if index < 16:
        raise ValueError(index)
    if index < 232:
        index -= 16
        r, g, b = index // 36, (index // 6) % 6, index % 6
        conv = lambda v: 55 + 40 * v if v else 0
        return conv(r), conv(g), conv(b)
    level = 8 + 10 * (index - 232)
    return level, level, level


class Renderer:
    def __init__(self, cols: int, rows: int, font_size: int = 15):
        self.cols = cols
        self.rows = rows
        self.latin = ImageFont.truetype(FONT_LATIN, font_size)
        cjk_path = next((p for p in FONT_CJK_CANDIDATES if Path(p).exists()), None)
        self.cjk = ImageFont.truetype(cjk_path, font_size) if cjk_path else self.latin
        self.cell_w = round(self.latin.getlength("M"))
        ascent, descent = self.latin.getmetrics()
        self.cell_h = ascent + descent + 2

    def _color(self, value, theme, is_fg_bold: bool) -> tuple[int, int, int] | None:
        if value is None:
            return None
        if isinstance(value, list):
            return tuple(value)
        if value < 16:
            if is_fg_bold and value < 8:
                value += 8
            return theme["palette"][value]
        return palette_256(value)

    def render(self, screen: dict, theme_name: str, path: Path) -> None:
        theme = THEMES[theme_name]
        img = Image.new("RGB", (self.cols * self.cell_w, self.rows * self.cell_h), theme["bg"])
        draw = ImageDraw.Draw(img)
        for y in range(min(self.rows, len(screen["cells"]))):
            x = 0
            for cell in screen["cells"][y]:
                ch = cell["ch"] or " "
                wide = cell.get("wide", 1) == 2
                fg = self._color(cell["fg"], theme, cell["bold"]) or theme["fg"]
                bg = self._color(cell["bg"], theme, False) or theme["bg"]
                if cell["inv"]:
                    fg, bg = bg, fg
                if cell["dim"]:
                    fg = tuple(int(a + (b - a) * 0.6) for a, b in zip(theme["bg"], fg))
                px, py = x * self.cell_w, y * self.cell_h
                if bg != theme["bg"]:
                    draw.rectangle(
                        [px, py, px + (2 if wide else 1) * self.cell_w, py + self.cell_h],
                        fill=bg,
                    )
                if ch.strip():
                    font = self.cjk if wide else self.latin
                    draw.text((px, py + 1), ch, font=font, fill=fg)
                x += 2 if wide else 1
        img.save(path)


class PtySession:
    def __init__(self, cmd: list[str], cols: int, rows: int, env: dict):
        self.raw = bytearray()
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.proc = subprocess.Popen(
            cmd, stdin=slave, stdout=slave, stderr=slave, env=env,
            close_fds=True, start_new_session=True,
        )
        os.close(slave)
        self._lock = threading.Lock()
        self._dirty = 0
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        while True:
            try:
                ready, _, _ = select.select([self.master], [], [], 0.05)
                if not ready:
                    continue
                data = os.read(self.master, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:  # child exited, pty closed
                    break
                raise
            if not data:
                break
            with self._lock:
                self.raw.extend(data)
                self._dirty += 1

    def send(self, text: str) -> None:
        # CAP_SETTLE_SEND=1: wait for the app to go quiet before writing —
        # tests the hypothesis that keypresses landing mid-render are dropped.
        if os.environ.get("CAP_SETTLE_SEND"):
            self.settle(quiet_ms=120, timeout_s=3)
        os.write(self.master, text.encode())
        # Pace sends: a following send within a few ms would merge with a lone
        # ESC byte and parse as Alt+<key> in Ink's keypress parser.
        time.sleep(0.09)

    def type_text(self, text: str) -> None:
        for ch in text:
            self.send(ch)

    def settle(self, quiet_ms: int = 250, timeout_s: float = 8.0) -> None:
        """Block until the output stream has been quiet for quiet_ms.

        At process start (no bytes seen yet) this waits for the first paint
        instead of returning immediately on an idle stream.
        """
        deadline = time.monotonic() + timeout_s
        with self._lock:
            last = self._dirty
        seen_any = last > 0
        while time.monotonic() < deadline:
            time.sleep(0.03)
            with self._lock:
                current = self._dirty
            if current != last:
                last = current
                seen_any = True
                continue
            if not seen_any:
                continue
            time.sleep(quiet_ms / 1000)
            with self._lock:
                if self._dirty == current:
                    return

    def stop(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()
        os.close(self.master)


def replay_screen(raw: bytes, cols: int, rows: int) -> dict:
    proc = subprocess.run(
        ["node", str(REPLAY), "/dev/stdin", str(cols), str(rows)],
        input=raw, capture_output=True, check=True,
    )
    return json.loads(proc.stdout)


def plain_dump(screen: dict) -> str:
    lines = []
    for row in screen["cells"]:
        lines.append("".join(c["ch"] or " " for c in row).rstrip())
    return "\n".join(lines).rstrip() + "\n"


def write_locale_config(home: Path, locale: str) -> None:
    config = home / ".cc-profile-switch" / "config.json"
    data = json.loads(config.read_text())
    data.setdefault("workbench", {})["language"] = locale
    config.write_text(json.dumps(data, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--locale", choices=["en", "zh"], default=None)
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--theme", choices=["dark", "light", "both"], default="dark")
    parser.add_argument("cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        cmd = ["node", "dist/workbench.mjs"]

    args.out.mkdir(parents=True, exist_ok=True)
    if args.locale:
        write_locale_config(args.home, args.locale)

    env = dict(os.environ)
    env["HOME"] = str(args.home.resolve())
    env["TERM"] = "xterm-256color"
    env.pop("NO_COLOR", None)
    if args.no_color:
        env["NO_COLOR"] = "1"
    env.setdefault("LANG", "en_US.UTF-8" if args.locale != "zh" else "zh_CN.UTF-8")

    renderer = Renderer(args.cols, args.rows)
    session = PtySession(cmd, args.cols, args.rows, env)

    def capture(label: str) -> None:
        session.settle()
        with session._lock:
            raw = bytes(session.raw)
        (args.out / "_raw").mkdir(exist_ok=True)
        (args.out / "_raw" / f"{label}.bin").write_bytes(raw)
        screen = replay_screen(raw, args.cols, args.rows)
        (args.out / f"{label}.txt").write_text(plain_dump(screen))
        renderer.render(screen, "dark", args.out / f"{label}.png")
        if args.theme == "both":
            renderer.render(screen, "light", args.out / f"{label}-light.png")
        elif args.theme == "light":
            renderer.render(screen, "light", args.out / f"{label}.png")

    def screen_text() -> str:
        """Full visible text of the current frame (settled + replayed)."""
        session.settle()
        with session._lock:
            raw = bytes(session.raw)
        screen = replay_screen(raw, args.cols, args.rows)
        return "\n".join("".join(c["ch"] or " " for c in row) for row in screen["cells"])

    def highlighted_row(x0: int, x1: int) -> str:
        """Texts of every cursor row (bg/inverse cells) inside the column band
        [x0, x1), joined by newlines; "" when none is visible. Several rows can
        be highlighted at once (the sidebar profile cursor stays lit while a
        picker cursor moves below it), so all of them are returned. Ink drops
        keypresses non-deterministically under scripted input (reproduced at
        90/500/1000 ms pacing), so absolute DOWN counts are unreliable —
        until-hl/nav-grid navigate by observed state instead."""
        session.settle()
        with session._lock:
            raw = bytes(session.raw)
        screen = replay_screen(raw, args.cols, args.rows)
        hits = []
        for row in screen["cells"]:
            cells = row[x0:x1]
            if any(c["bg"] is not None or c["inv"] for c in cells):
                hits.append("".join(c["ch"] or " " for c in cells))
        return "\n".join(hits)

    def hit(targets: list[str], text: str) -> bool:
        return any(t in text for t in targets)

    try:
        session.settle(quiet_ms=400, timeout_s=15)
        for raw_line in args.script.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.replace("{PWD}", os.getcwd())
            directive, _, rest = line.partition(" ")
            if directive == "rep":
                # rep N <directive> <rest> — repeat a directive N times.
                count_s, _, sub = rest.partition(" ")
                for _ in range(int(count_s)):
                    sub_d, _, sub_r = sub.partition(" ")
                    if sub_d == "send":
                        session.send(unescape(sub_r))
                    elif sub_d == "type":
                        session.type_text(unescape(sub_r))
                    elif sub_d == "wait":
                        time.sleep(int(sub_r) / 1000)
                    else:
                        raise ValueError(f"rep does not support: {sub_d}")
            elif directive == "send":
                session.send(unescape(rest))
            elif directive == "type":
                # One write per character: Ink apps collapse batched writes
                # (paste semantics), dropping prompt input.
                session.type_text(unescape(rest))
            elif directive == "sh":
                # Local dev-tooling escape hatch: runs author-controlled DSL
                # lines only (fixture mutations between shots), never user
                # input — the AGENTS.md no-shell-concatenation rule targets
                # shipped product code, not this harness.
                subprocess.run(rest, shell=True, check=True, env=env)
            elif directive == "wait":
                time.sleep(int(rest) / 1000)
            elif directive == "shot":
                capture(rest)
            elif directive == "until-hl":
                # until-hl "<t1|t2>" [max] [up] [band=X0:X1] — send DOWN (or
                # UP) until the highlighted cursor row inside the band contains
                # one of the |-separated candidates. On timeout, warn and dump
                # a diagnostic frame instead of aborting the matrix run.
                parts = shlex.split(rest)
                targets = parts[0].split("|")
                max_presses = next((int(p) for p in parts[1:] if p.isdigit()), 30)
                key = "{UP}" if "up" in parts[1:] else "{DOWN}"
                band_p = next((p for p in parts[1:] if p.startswith("band=")), None)
                bx0, _, bx1 = band_p[5:].partition(":") if band_p else ("0", ":", "28")
                x0 = int(bx0) if bx0 else 0
                x1 = int(bx1) if bx1 else args.cols
                for attempt in range(int(max_presses) + 1):
                    hl = highlighted_row(int(x0), int(x1))
                    if hit(targets, hl):
                        break
                    if attempt == int(max_presses):
                        print(f"WARN until-hl timeout: {targets} (last {hl.strip()!r})",
                              file=sys.stderr)
                        capture(f"untilhl-timeout-{targets[0].replace(' ', '_')}")
                        break
                    session.send(unescape(key))
                    time.sleep(0.35)
            elif directive == "press-until":
                # press-until "<key>" "<t1|t2>" [max] — press <key> until the
                # screen shows one of the candidates (idempotent keys only:
                # the key must be a no-op once the target state is reached).
                parts = shlex.split(rest)
                key = unescape(parts[0])
                targets = parts[1].split("|")
                max_presses = int(parts[2]) if len(parts) > 2 else 6
                for attempt in range(max_presses + 1):
                    if hit(targets, screen_text()):
                        break
                    if attempt == max_presses:
                        print(f"WARN press-until timeout: {targets}", file=sys.stderr)
                        capture(f"pressuntil-timeout-{targets[0].replace(' ', '_')}")
                        break
                    session.send(key)
                    time.sleep(0.4)
            elif directive == "until-marker":
                # until-marker "<t1|t2>" [max] [up] — for lists whose cursor is
                # a plain "▸" prefix without bg (template picker, wizard source
                # list, restore picker): send DOWN/UP until the ▸-marked row
                # contains a candidate.
                parts = shlex.split(rest)
                targets = parts[0].split("|")
                max_presses = next((int(p) for p in parts[1:] if p.isdigit()), 30)
                key = "{UP}" if "up" in parts[1:] else "{DOWN}"
                for attempt in range(int(max_presses) + 1):
                    marked = [ln for ln in screen_text().splitlines() if "▸" in ln]
                    if any(hit(targets, ln) for ln in marked):
                        break
                    if attempt == int(max_presses):
                        print(f"WARN until-marker timeout: {targets}", file=sys.stderr)
                        capture(f"untilmarker-timeout-{targets[0].replace(' ', '_')}")
                        break
                    session.send(unescape(key))
                    time.sleep(0.35)
            elif directive == "until-gone":
                # until-gone "<key>" "<t1|t2>" [max] — press <key> (usually ESC)
                # until none of the candidates remains on screen. For closing
                # bars/overlays whose ESC keypress may itself be dropped.
                parts = shlex.split(rest)
                key = unescape(parts[0])
                targets = parts[1].split("|")
                max_presses = int(parts[2]) if len(parts) > 2 else 6
                for attempt in range(int(max_presses) + 1):
                    if not hit(targets, screen_text()):
                        break
                    if attempt == max_presses:
                        print(f"WARN until-gone timeout: {targets}", file=sys.stderr)
                        capture(f"untilgone-timeout-{targets[0].replace(' ', '_')}")
                        break
                    session.send(key)
                    time.sleep(0.4)
            elif directive == "wait-until":
                # wait-until "<t1|t2>" [timeout_ms] — pure wait (no keypresses)
                # until a candidate appears, e.g. async phase transitions.
                parts = shlex.split(rest)
                targets = parts[0].split("|")
                timeout_s = (int(parts[1]) if len(parts) > 1 else 8000) / 1000
                deadline = time.monotonic() + timeout_s
                while True:
                    if hit(targets, screen_text()):
                        break
                    if time.monotonic() > deadline:
                        print(f"WARN wait-until timeout: {targets}", file=sys.stderr)
                        capture(f"waituntil-timeout-{targets[0].replace(' ', '_')}")
                        break
                    time.sleep(0.4)
            elif directive == "nav-grid":
                # nav-grid "<t1|t2>" [key] [rounds] — enter a grid drill-down
                # by walking the category cards: ensure grid focus, DOWN once,
                # press [key] (default Enter), check the screen; on a miss back
                # out with ESC and walk on. DOWN wraps, so ≤7 unique cards plus
                # slack for dropped keypresses. Cursor position never needs to
                # be known — the walk visits every card.
                parts = shlex.split(rest)
                targets = parts[0].split("|")
                key = unescape(parts[1]) if len(parts) > 1 else "\r"
                rounds = int(parts[2]) if len(parts) > 2 else 11
                grid_marks = ["Enter to drill in", "Enter 进入"]
                for round_ in range(rounds):
                    if hit(targets, screen_text()):
                        break
                    if not hit(grid_marks, screen_text()):
                        session.send("\t")
                        time.sleep(0.4)
                    session.send(unescape("{DOWN}"))
                    time.sleep(0.3)
                    session.send(key)
                    time.sleep(0.9)
                    if hit(targets, screen_text()):
                        break
                    session.send(unescape("{ESC}"))
                    time.sleep(0.5)
                else:
                    print(f"WARN nav-grid failed: {targets}", file=sys.stderr)
                    capture(f"navgrid-fail-{targets[0].replace(' ', '_')}")
            else:
                raise ValueError(f"unknown directive: {line}")
    finally:
        session.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
