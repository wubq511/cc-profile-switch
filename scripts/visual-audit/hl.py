#!/usr/bin/env python3
"""Print the highlighted (non-default bg) sidebar rows for each _raw/*.bin.

Usage: hl.py <capture-out-dir>
Replays each raw stream through replay.mjs and reports, per frame, which
sidebar rows (cols 0-25) carry a background color or inverse flag — i.e. the
tree cursor position.
"""
import json
import subprocess
import sys
from pathlib import Path

REPLAY = Path(__file__).resolve().parent / "replay.mjs"


def hl_rows(raw: bytes, cols: int, rows: int) -> list[str]:
    proc = subprocess.run(
        ["node", str(REPLAY), "/dev/stdin", str(cols), str(rows)],
        input=raw, capture_output=True, check=True,
    )
    screen = json.loads(proc.stdout)
    out = []
    for y, row in enumerate(screen["cells"]):
        text = "".join(c["ch"] or " " for c in row[:26]).rstrip()
        if any(c["bg"] is not None or c["inv"] for c in row[:26]):
            out.append(f"  y={y:2d}  {text}")
    return out


def main() -> None:
    outdir = Path(sys.argv[1])
    cols, rows = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (80, 24)
    for bin_path in sorted((outdir / "_raw").glob("*.bin")):
        rows_found = hl_rows(bin_path.read_bytes(), cols, rows)
        print(f"{bin_path.stem}:")
        for line in rows_found:
            print(line)


if __name__ == "__main__":
    main()
