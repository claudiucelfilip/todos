#!/usr/bin/env bash
# Backup the unversioned sync store (data/db.json).
#
# data/ is git-ignored, so these rotating local copies are the store's only
# backup. Run on a schedule (launchd/cron / launchctl / systemd) and point
# BACKUP_DIR at a durable, ideally off-host location for real safety. Pure
# bash + coreutils; no deps.
#
# Env (all optional):
#   REPO       repo root            (default: derived from this script's location)
#   DATA_FILE  source file          (default: $REPO/data/db.json)
#   BACKUP_DIR where stamps live    (default: $REPO/data/backups)
#   KEEP       backups to retain    (default: 30)
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_FILE="${DATA_FILE:-$REPO/data/db.json}"
BACKUP_DIR="${BACKUP_DIR:-$REPO/data/backups}"
KEEP="${KEEP:-30}"

log() { echo "$(date +"%F %T") $*"; }
mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DATA_FILE" ]]; then
  log "no $DATA_FILE yet — nothing to back up"; exit 0
fi

stamp="$(date -u +"%Y%m%d%H%M%S")"
dst="$BACKUP_DIR/db-$stamp.json"
cp -p "$DATA_FILE" "$dst"
log "backed up $DATA_FILE -> $dst"

# Prune oldest, keep the newest $KEEP. Filenames are zero-padded UTC timestamps,
# so a lexical sort is chronological and stable even on same-second runs.
# We never prune the copy we just wrote.
all=( "$BACKUP_DIR"/db-*.json )
if [[ ${#all[@]} -gt $KEEP ]]; then
  drop=$(( ${#all[*]} - KEEP ))
  for f in "${all[@]:0:$drop}"; do
    [[ -e "$f" && "$f" != "$dst" ]] || continue
    rm -f "$f"
    log "pruned $(basename "$f")"
  done
else
  log "keeping ${#all[*]} backup(s) (<= KEEP)"
fi

# Best-effort integrity check: the freshly written copy must parse as JSON.
if command -v node >/dev/null 2>&1; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$dst"; then
    log "verified $dst parses as JSON"
  else
    log "ERROR: $dst failed JSON parse"; exit 1
  fi
elif command -v python3 >/dev/null 2>&1; then
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$dst"; then
    log "verified $dst parses as JSON"
  else
    log "ERROR: $dst failed JSON parse"; exit 1
  fi
else
  log "no node/python3 to verify — copy only"
fi
