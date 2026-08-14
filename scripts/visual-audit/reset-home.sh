#!/usr/bin/env bash
# Reset the audit fixture home for a Workbench visual-audit run (issue #97).
#
#   reset-home.sh [--locale en|zh] [--editor CMD] [--zero-profiles] [--trim-skills]
#
# Copies the materialized baseline fixture (.fixtures-out/audit) into
# .fixtures-out/home/.cc-profile-switch, expands the generator's <apphome> /
# <userhome> placeholders, seeds backups / Recovery Bin items / a custom
# template / export bundles / a local skill source, breaks one profile for
# validation findings, and writes workbench.language (+ optional
# workbench.editor override) into config.json.
#
# --zero-profiles skips all seeding and empties profiles/ for the
# zero-profile capture session.
# --trim-skills empties every other profile's skills/ after seeding, so the
# wizard2 session's cross-profile source list holds only the manual-entry
# row (the full fixture discovers ~950 sources — 19 profiles × 50 skills —
# whose tail row no amount of DOWN presses can reach).
set -euo pipefail
cd "$(dirname "$0")/../.."

LOCALE="en"
EDITOR=""
ZERO=0
TRIM_SKILLS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --locale) LOCALE="$2"; shift 2 ;;
    --editor) EDITOR="$2"; shift 2 ;;
    --zero-profiles) ZERO=1; shift ;;
    --trim-skills) TRIM_SKILLS=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SRC=".fixtures-out/audit"
HOME_DIR="$PWD/.fixtures-out/home"
APP_HOME="$HOME_DIR/.cc-profile-switch"

[[ -d "$SRC" ]] || { echo "generate the fixture first: npx tsx test/fixtures/generate.ts --tier baseline --pathologies none --out $SRC" >&2; exit 1; }

rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"
cp -R "$SRC" "$APP_HOME"

# Expand the generator's <apphome>/<userhome> placeholders to real paths.
grep -rl '<apphome>\|<userhome>' "$APP_HOME" | while read -r f; do
  sed -i '' -e "s|<apphome>|$APP_HOME|g" -e "s|<userhome>|$HOME_DIR|g" "$f"
done

# Deterministic locale (+ optional editor override) for the run.
python3 - "$APP_HOME/config.json" "$LOCALE" "$EDITOR" <<'PY'
import json, sys
path, locale, editor = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
wb = data.setdefault("workbench", {})
wb["language"] = locale
if editor:
    wb["editor"] = editor
json.dump(data, open(path, "w"), indent=2)
PY

if [[ "$ZERO" -eq 1 ]]; then
  rm -rf "$APP_HOME/profiles"
  mkdir -p "$APP_HOME/profiles"
  rm -f "$APP_HOME/state.json"
  python3 - "$APP_HOME/config.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data.pop("defaultProfile", None)
data.pop("lastUsedProfile", None)
json.dump(data, open(path, "w"), indent=2)
PY
else
  # Seed: one durable backup, four Recovery Bin items (profile/skill/
  # auto-memory×2), one custom template, two export bundles, a broken
  # profile, and a local skill source. Bundles must not pre-exist.
  rm -rf .fixtures-out/bundles
  HOME="$HOME_DIR" node dist/index.js backup profile-001 >/dev/null
  HOME="$HOME_DIR" npx tsx scripts/visual-audit/seed.ts >/dev/null
fi

if [[ "$TRIM_SKILLS" -eq 1 ]]; then
  for d in "$APP_HOME/profiles"/*/claude-home/skills; do
    case "$d" in
      *profile-001*) ;; # the wizard target keeps its own skills
      *) find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true ;;
    esac
  done
fi

# Stub `claude` on PATH for launch captures. The Plugins card (issue #96)
# delegates its inventory to `claude plugin list --json`; the stub seeds all
# three card states by profile: sandbox → empty list, profile-018 (broken) →
# fail closed ("unavailable"), everything else → two installed plugins. Other
# plugin/mcp subcommands fail closed; plain launch exits 0 immediately.
# Stub `editor-stub` for watch captures:
# exit 0 immediately, mirroring the `code` CLI / `open -a` handoff — the
# session manager only flips opening → watching when the editor process
# closes with exit 0 (spawnEditor resolves on 'close'), so a stub that stays
# alive would pin the badge at "…opening" forever. Watching tracks the file,
# not the editor process.
STUB_DIR="$PWD/.fixtures-out/bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "plugin" && "${2:-}" == "list" ]]; then
  case "${CLAUDE_CONFIG_DIR:-}" in
    *sandbox*) echo '[]'; exit 0 ;;
    *profile-018*) exit 1 ;;
    *)
      echo '[{"id":"formatter@ccps-market","version":"1.2.0","scope":"user","enabled":true},{"id":"pr-reviewer@ccps-market","version":"0.3.1","scope":"user","enabled":false}]'
      exit 0 ;;
  esac
fi
case "${1:-}" in
  plugin|mcp) exit 1 ;;
  *) echo "[stub claude] session ran and exited"; exit 0 ;;
esac
EOF
chmod +x "$STUB_DIR/claude"
cat > "$STUB_DIR/editor-stub" <<'EOF'
#!/usr/bin/env bash
# Editor stand-in: hands off instantly like `code` / `open -a` do. The watch
# session's badge flips to "watching" on this exit; file watching continues
# independently of the editor process.
exit 0
EOF
chmod +x "$STUB_DIR/editor-stub"

echo "audit home ready: $APP_HOME (locale=$LOCALE editor=${EDITOR:-default} zero=$ZERO)"
