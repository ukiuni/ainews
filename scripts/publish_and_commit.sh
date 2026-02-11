#!/bin/bash
# Publish and Commit Script for fetch_and_build.js

# Ensure the script stops on first failure
set -euo pipefail

LOCKFILE="/tmp/aipages-build.lock"
PIDFILE="${LOCKFILE}.pid"

# Acquire lock: if lock exists and process alive, exit. Otherwise create lock and write PID.
if [ -e "$LOCKFILE" ]; then
  if [ -e "$PIDFILE" ]; then
    oldpid=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
      echo "Another build is running (PID $oldpid). Exiting." >&2
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

# Run fetch_and_build.js script
node src/fetch_and_build.js

# Git operations
# Add changes
# Only add tracked files and data to avoid adding stray temp files
git add -A

# If there are changes to commit
if git diff --cached --quiet; then
  echo "No changes to commit." >&2
else
  git commit -m "Auto: Updated items using fetch_and_build.js"
  # Push with simple retry logic (3 attempts)
  attempts=0
  until [ "$attempts" -ge 3 ]
  do
    if git push origin main; then
      echo "Push successful"
      break
    fi
    attempts=$((attempts+1))
    echo "Push failed, retrying ($attempts/3)..." >&2
    sleep 5
  done
  if [ "$attempts" -ge 3 ]; then
    echo "Push failed after 3 attempts." >&2
    exit 1
  fi
fi

# Output success message
echo "Build and push successful!"
