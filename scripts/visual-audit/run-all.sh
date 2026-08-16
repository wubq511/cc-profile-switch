#!/usr/bin/env bash
# Run the full issue #97 capture matrix into audit-output/<suite>/.
#
#   run-all.sh [output-root]   (default: audit-output/)
#
# Sessions × en|zh × compact(80×24)|wide(140×40); resize guard at 79×23
# (en+zh); NO_COLOR at 80×24 (en+zh). Compact runs also render
# light-background variants.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="${1:-audit-output}"
PY=.audit-venv/bin/python
STUB="$PWD/.fixtures-out/bin"
EDITOR_BROKEN="nonexistent-editor-xyz"

run() { # <session-script> <locale> <cols> <rows> <name> [extra capture args...]
  local script="$1" locale="$2" cols="$3" rows="$4" name="$5"
  shift 5
  local theme="dark"
  [[ "$cols" -eq 80 ]] && theme="both"
  ./scripts/visual-audit/reset-home.sh --locale "$locale" ${RESET_ARGS[@]+"${RESET_ARGS[@]}"} >/dev/null
  rm -f .fixtures-out/out.tar.gz
  PATH="$STUB:$PATH" $PY scripts/visual-audit/capture.py \
    --cols "$cols" --rows "$rows" \
    --home .fixtures-out/home \
    --script "scripts/visual-audit/scripts/$script" \
    --theme "$theme" \
    --out "$OUT/$name" "$@"
  echo "done: $name"
}

SESSIONS=(main wizard drills bulk automem recovery launch)
for s in "${SESSIONS[@]}"; do
  RESET_ARGS=(--editor "$EDITOR_BROKEN")
  run "$s.script" en 80 24 "$s-en-compact"
  run "$s.script" en 140 40 "$s-en-wide"
  run "$s.script" zh 80 24 "$s-zh-compact"
  run "$s.script" zh 140 40 "$s-zh-wide"
done

# wizard2: manual-path + collision flow on a trimmed fixture (empty
# cross-profile source list — see scripts/wizard2.script).
RESET_ARGS=(--editor "$EDITOR_BROKEN" --trim-skills)
run wizard2.script en 80 24 wizard2-en-compact
run wizard2.script en 140 40 wizard2-en-wide
run wizard2.script zh 80 24 wizard2-zh-compact
run wizard2.script zh 140 40 wizard2-zh-wide

RESET_ARGS=(--zero-profiles)
run zero.script en 80 24 zero-en-compact
run zero.script en 140 40 zero-en-wide
run zero.script zh 80 24 zero-zh-compact
run zero.script zh 140 40 zero-zh-wide

RESET_ARGS=(--editor editor-stub)
run watch.script en 80 24 watch-en-compact
run watch.script en 140 40 watch-en-wide
run watch.script zh 80 24 watch-zh-compact
run watch.script zh 140 40 watch-zh-wide

RESET_ARGS=()
run resize.script en 79 23 resize-en
run resize.script zh 79 23 resize-zh

RESET_ARGS=(--editor "$EDITOR_BROKEN")
run nocolor.script en 80 24 nocolor-en --no-color
run nocolor.script zh 80 24 nocolor-zh --no-color

echo "all captures complete under $OUT"
