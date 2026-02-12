#!/bin/bash
# Publish and Commit Script for fetch_and_build.js

# Ensure the script stops on first failure
set -euo pipefail

LOCKFILE="/tmp/aipages-build.lock"
PIDFILE="${LOCKFILE}.pid"
WORKLOG="/home/unirdp/clawd/projects/aipages/worklog.md"

# Acquire lock: if lock exists and process alive, exit. Otherwise create lock and write PID.
if [ -e "$LOCKFILE" ]; then
  if [ -e "$PIDFILE" ]; then
    oldpid=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
      msg="Another build is running (PID $oldpid). Exiting."
      echo "$msg" >&2
      # append to worklog
      printf "%s: SKIP - %s\n" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$msg" >> "$WORKLOG" || true
      exit 0
    else
      echo "Stale lock found. Removing." >&2
      rm -f "$LOCKFILE" "$PIDFILE"
    fi
  else
    echo "Lock file present but no PID file. Removing stale lock." >&2
    rm -f "$LOCKFILE"
  fi
fi

# create lock
mkdir -p "$(dirname "$LOCKFILE")"
printf "locked" > "$LOCKFILE"
echo $$ > "$PIDFILE"

# Ensure lock is removed on exit
cleanup() {
  rm -f "$LOCKFILE" "$PIDFILE"
}
trap cleanup EXIT INT TERM

# Move to the aipages directory
cd ~/clawd/projects/aipages

# Attempt to update translations first (non-fatal)
TRANS_LOG=/tmp/aipages_trans_$(date +%s).log
if node scripts/update_translations.js > "$TRANS_LOG" 2>&1; then
  echo "update_translations: success" >> "$TRANS_LOG"
else
  echo "update_translations: failed (continuing)" >> "$TRANS_LOG"
fi

# Run fetch_and_build.js script and capture output
BUILD_LOG=/tmp/aipages_build_$(date +%s).log
if node src/fetch_and_build.js > "$BUILD_LOG" 2>&1; then
  BUILD_STATUS=success
else
  BUILD_STATUS=fail
fi
# attach translation log tail to build log for auditing
printf "%s\n" "-- translation log tail --" >> "$BUILD_LOG" || true
tail -n 50 "$TRANS_LOG" >> "$BUILD_LOG" || true
printf "%s\n" "-- end translation log tail --" >> "$BUILD_LOG" || true

# Git operations
# Add changes
git add -A || true

TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

if git diff --cached --quiet; then
  echo "No changes to commit." >&2
  printf "%s: NO_CHANGES\n" "$TIMESTAMP" >> "$WORKLOG" || true
else
  if git commit -m "Auto: Updated items using fetch_and_build.js"; then
    # Push with simple retry logic (3 attempts)
    attempts=0
    PUSH_OK=0
    until [ "$attempts" -ge 3 ]
    do
      if git push origin main; then
        echo "Push successful"
        PUSH_OK=1
        break
      fi
      attempts=$((attempts+1))
      echo "Push failed, retrying ($attempts/3)..." >&2
      sleep 5
    done
    if [ "$PUSH_OK" -ne 1 ]; then
      echo "Push failed after 3 attempts." >&2
      printf "%s: PUSH_FAIL after commit\n" "$TIMESTAMP" >> "$WORKLOG" || true
      # attach last lines of build log
      tail -n 200 "$BUILD_LOG" >> "$WORKLOG" || true
      exit 1
    else
      printf "%s: BUILD=%s COMMIT=YES PUSH=YES\n" "$TIMESTAMP" "$BUILD_STATUS" >> "$WORKLOG" || true
    fi
  else
    echo "Git commit failed" >&2
    printf "%s: COMMIT_FAIL\n" "$TIMESTAMP" >> "$WORKLOG" || true
    tail -n 200 "$BUILD_LOG" >> "$WORKLOG" || true
    exit 1
  fi
fi

# Append a short summary of build log to worklog (last 50 lines)
printf "%s\n" "-- Build log tail (%s) --" "$TIMESTAMP" >> "$WORKLOG" || true
tail -n 50 "$BUILD_LOG" >> "$WORKLOG" || true
printf "%s\n\n" "-- End build log --" >> "$WORKLOG" || true

# Output success message and cleanup
echo "Build and push successful!"
