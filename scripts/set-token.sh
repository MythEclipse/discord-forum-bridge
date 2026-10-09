#!/usr/bin/env bash
# Set the Discord bot token without putting it in a command line or a chat log.
#
#   ./scripts/set-token.sh            # interactive, hidden input
#   ./scripts/set-token.sh --stdin    # read from a pipe
#
# Both DISCORD_BOT_TOKEN and DISCORD_BOT_USER_ID are accepted:
#   KEY=VALUE   one per line, or bare values prompted for interactively.
#
# The token is written to .env mode 600 and is never echoed. Nothing is logged.
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
MODE="${1:-}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

set_kv() {
  # set_kv KEY VALUE  (python keeps quoting correct; sed mangles ' in secrets)
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import re, sys, pathlib
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
s = p.read_text()
line = f'{key}="{value}"'
if re.search(rf'^{re.escape(key)}=', s, flags=re.M):
    s = re.sub(rf'^{re.escape(key)}=.*$', line.replace('\\', '\\\\'), s, flags=re.M)
else:
    s = s.rstrip('\n') + '\n' + line + '\n'
p.write_text(s)
print(f'  {key} set ({len(value)} chars)')
PY
}

if [ "$MODE" = "--stdin" ]; then
  while IFS='=' read -r k v; do
    [ -n "${k:-}" ] || continue
    set_kv "$k" "$v"
  done
else
  printf 'Discord bot token (input hidden): '
  read -rs TOKEN; echo
  set_kv DISCORD_BOT_TOKEN "$TOKEN"

  printf 'Application / bot user id       : '
  read -r USERID
  set_kv DISCORD_BOT_USER_ID "$USERID"
fi

chmod 600 "$ENV_FILE"
echo
echo "stored. verifying against Discord (token never printed):"
set -a; . "$ENV_FILE"; set +a
code=$(curl -sS -m 20 -o /tmp/bt.json -w '%{http_code}' \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  https://discord.com/api/v10/users/@me)
echo "  GET /users/@me -> HTTP $code"
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/bt.json'))
except Exception:
    print('  (non-json response)'); raise SystemExit(0)
if 'id' in d:
    print(f"  bot id   : {d['id']}")
    print(f"  bot name : {d.get('username')}")
    print(f"  verified : {d.get('verified')}")
else:
    print(f"  ERROR    : {d.get('message')}")
PY
rm -f /tmp/bt.json
echo
echo "now: systemctl --user start discord-forum-bridge"
