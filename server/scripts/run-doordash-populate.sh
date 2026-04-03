#!/bin/bash
#
# Unattended DoorDash menu population wrapper.
# Auto-restarts with --resume on failure (auth expiry, Chrome crash, 429 storms, etc).
#
# Usage:
#   bash server/scripts/run-doordash-populate.sh                # All non-delisted DoorDash restaurants
#   bash server/scripts/run-doordash-populate.sh --matched-only # Only cross-platform matched
#
# Run from project root (C:\Users\ozend\dev\project-kortana).
# Logs to server/data/doordash-populate-YYYYMMDD-HHMMSS.log

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$SERVER_DIR/data"
mkdir -p "$DATA_DIR"

LOGFILE="$DATA_DIR/doordash-populate-$(date +%Y%m%d-%H%M%S).log"
EXTRA_ARGS="${*:-}"
COOLDOWN_SECS=90
MAX_RESTARTS=50
restart_count=0

echo "=== DoorDash Menu Population Wrapper ===" | tee "$LOGFILE"
echo "Log: $LOGFILE" | tee -a "$LOGFILE"
echo "Args: --resume --sustained --skip-match $EXTRA_ARGS" | tee -a "$LOGFILE"
echo "Max restarts: $MAX_RESTARTS" | tee -a "$LOGFILE"
echo "Started: $(date)" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

while [ $restart_count -lt $MAX_RESTARTS ]; do
  echo "[$(date)] Run #$((restart_count + 1)) starting..." | tee -a "$LOGFILE"

  cd "$SERVER_DIR" && npx tsx src/scripts/populate-doordash-menus.ts \
    --resume --sustained --skip-match $EXTRA_ARGS \
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

  # Check progress file for context
  if [ -f "$DATA_DIR/doordash-menu-progress.json" ]; then
    echo "  Progress: $(cat "$DATA_DIR/doordash-menu-progress.json")" | tee -a "$LOGFILE"
  fi

  sleep $COOLDOWN_SECS
done

if [ $restart_count -ge $MAX_RESTARTS ]; then
  echo "[$(date)] Hit max restart limit ($MAX_RESTARTS). Giving up." | tee -a "$LOGFILE"
fi

echo "[$(date)] Wrapper finished. Total restarts: $restart_count" | tee -a "$LOGFILE"
