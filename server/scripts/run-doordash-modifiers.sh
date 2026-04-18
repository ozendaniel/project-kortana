#!/bin/bash
#
# Unattended DoorDash modifier backfill wrapper.
# Auto-restarts with --resume on failure (Chrome crash, 429s, etc).
#
# Usage:
#   bash server/scripts/run-doordash-modifiers.sh
#
# Run from project root (C:\Users\ozend\dev\project-kortana).
# Logs to server/data/doordash-modifiers-YYYYMMDD-HHMMSS.log

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$SERVER_DIR/data"
mkdir -p "$DATA_DIR"

LOGFILE="$DATA_DIR/doordash-modifiers-$(date +%Y%m%d-%H%M%S).log"
COOLDOWN_SECS=90
MAX_RESTARTS=50

restart_count=0

echo "=== DoorDash Modifier Backfill Wrapper ===" | tee "$LOGFILE"
echo "Log: $LOGFILE" | tee -a "$LOGFILE"
echo "Max restarts: $MAX_RESTARTS" | tee -a "$LOGFILE"
echo "Started: $(date)" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

while [ $restart_count -lt $MAX_RESTARTS ]; do
  echo "[$(date)] Run #$((restart_count + 1)) starting..." | tee -a "$LOGFILE"

  cd "$SERVER_DIR" && npx tsx src/scripts/backfill-dd-modifiers.ts \
    --all --resume \
    2>&1 | tee -a "$LOGFILE"

  EXIT_CODE=${PIPESTATUS[0]}

  if [ $EXIT_CODE -eq 0 ]; then
    echo "" | tee -a "$LOGFILE"
    echo "[$(date)] Script completed successfully (exit 0). All done!" | tee -a "$LOGFILE"
    break
  fi

  restart_count=$((restart_count + 1))
  echo "" | tee -a "$LOGFILE"
  echo "[$(date)] Script exited with code $EXIT_CODE. Restart #$restart_count in ${COOLDOWN_SECS}s..." | tee -a "$LOGFILE"

  # Kill stale Chrome on port 9224 before restart
  npx kill-port 9224 2>/dev/null || true

  sleep $COOLDOWN_SECS
done

if [ $restart_count -ge $MAX_RESTARTS ]; then
  echo "[$(date)] Hit max restart limit ($MAX_RESTARTS). Giving up." | tee -a "$LOGFILE"
fi

echo "[$(date)] Wrapper finished. Total restarts: $restart_count" | tee -a "$LOGFILE"
