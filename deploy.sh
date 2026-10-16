#!/bin/bash
# Deploy discord-forum-bridge from GitHub. Invoked ONLY through the
# gh-actions-bridge forced command, so it runs as root on imrnes.
#
# It must never touch `.env` or `data/state.json`: `.env` holds the NodeBB API
# token and the Discord bot token, and state.json holds the mirror cursors.
# Losing either silently breaks the bridge or floods Discord on restart, so both
# are stashed and restored around the checkout change.

set -euo pipefail

APP=/opt/discord-forum-bridge
BRANCH=master
STASH=/var/tmp/bridge-deploy-$$

cd "$APP"

echo "── pre-flight ──"
[ -d "$APP/.git" ] || { echo "not a git checkout"; exit 1; }
[ -f "$APP/.env" ] || { echo "FATAL: .env is missing, refusing to deploy"; exit 1; }
[ -f "$APP/data/state.json" ] || { echo "FATAL: state.json is missing, refusing to deploy"; exit 1; }

CURSOR_BEFORE=$(node -e '
  const s=require("'"$APP"'/data/state.json");
  console.log(Object.keys(s.topicCursors||{}).length + " cursors, "
    + Object.keys(s.threads||{}).length + " threads");
')
echo "state before : $CURSOR_BEFORE"

# Keep the local-only files safe from a checkout/reset.
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "local modifications present, stashing"
  git stash push --include-untracked -m "deploy-autostash-$(date +%s)" >/dev/null
  STASHED=1
fi

echo "── fetch ──"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Restore anything the stash held, then drop the stash entry. `.env` and
# `data/state.json` are gitignored so a checkout never removes them, but a
# `reset --hard` on a dirty tree would, which is what the stash prevents.
if [ "$STASHED" = "1" ]; then
  git stash pop >/dev/null 2>&1 || echo "note: stash pop reported conflicts; local files kept in stash"
fi

echo "── verify ──"
[ -f "$APP/.env" ] || { echo "FATAL: .env vanished across the checkout"; exit 1; }
[ -f "$APP/data/state.json" ] || { echo "FATAL: state.json vanished across the checkout"; exit 1; }
node --check "$APP/src/main.js"
node --check "$APP/src/nodebb.js"
node --check "$APP/src/forum-mirror.js"

CURSOR_AFTER=$(node -e '
  const s=require("'"$APP"'/data/state.json");
  console.log(Object.keys(s.topicCursors||{}).length + " cursors, "
    + Object.keys(s.threads||{}).length + " threads");
')
echo "state after  : $CURSOR_AFTER"
if [ "$CURSOR_BEFORE" != "$CURSOR_AFTER" ]; then
  echo "WARNING: mirror state changed across the deploy"
fi

# Install deps only when package-lock changed; a plain code push must not
# re-run npm and churn node_modules under a running service.
if [ -f package-lock.json ] && ! git diff --quiet HEAD@{1} HEAD -- package-lock.json 2>/dev/null; then
  echo "── npm ci (lockfile changed) ──"
  npm ci --omit=dev
fi

echo "── restart ──"
systemctl --user restart discord-forum-bridge.service

# Block on the observable state: the unit active AND the boot banner logged.
for _ in $(seq 1 30); do
  if systemctl --user is-active --quiet discord-forum-bridge.service \
     && journalctl --user -u discord-forum-bridge --since '-2min' --no-pager 2>/dev/null \
        | grep -q 'bridge running'; then
    break
  fi
  sleep 2
done

if ! systemctl --user is-active --quiet discord-forum-bridge.service; then
  echo "FAIL: bridge is not active after restart"
  journalctl --user -u discord-forum-bridge --since '-2min' --no-pager | tail -20
  exit 1
fi

echo "── result ──"
systemctl --user is-active discord-forum-bridge.service
journalctl --user -u discord-forum-bridge --since '-2min' --no-pager 2>/dev/null \
  | grep -E 'bridge running|cursors restored|threadsCreated' | tail -5
echo "deployed $(git rev-parse --short HEAD)"
rm -rf "$STASH"
echo "OK"