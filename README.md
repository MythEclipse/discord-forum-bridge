# Discord <-> forum.imrnes.team bridge

Mirrors a Discord channel and a forum topic in both directions.

- **Discord -> Forum** — every new channel message becomes a reply in the forum topic.
- **Forum -> Discord** — every new reply in the bridged topic is posted to the channel,
  with the author's **forum username** and **forum rank** as the Discord display name.
- **Echo protection** — bridged forum posts embed `BRIDGE_MARKER`; any post containing
  it is skipped on the way back, and bot-authored Discord messages are skipped outbound.

## Status: awaiting credentials

Two credentials are required and are **not** in this repo:

| Variable | Where to get it |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer Portal -> your app -> **Bot** -> *Reset Token* |
| `NODEBB_API_TOKEN` | `ACP -> Manage -> Users -> <bridge user> -> User API Token` |

`DISCORD_CLIENT_SECRET` is **not** used to log in. Per Discord's auth docs, bot
login requires the **bot token**; the client secret only authorises OAuth2 grants
and application-command updates. `npm start` refuses to boot without
`DISCORD_BOT_TOKEN`.

## Layout

```
src/config.js     .env loader, fails fast on missing required values
src/nodebb.js     minimal NodeBB write API v3 client (dedicated user token only)
src/identity.js   rank ladder + identity links (data/links.json)
src/bridge.js     transport-agnostic two-way sync core
src/main.js       discord.js wiring + forum poller
scripts/smoke.js  offline tests: ladder, escaping, echo loops, routing
```

## Setup

```bash
cp .env.example .env
chmod 600 .env
# fill DISCORD_BOT_TOKEN, NODEBB_API_TOKEN, NODEBB_BRIDGE_UID
npm install
npm run check     # offline tests, no credentials needed
npm start
```

## Discord application checklist

### 1. Invite the bot into the guild

```bash
npm run invite
```

prints the OAuth2 authorize URL built from the ids in `.env`, with the requested
permission bits printed by name so the grant is reviewable. It prints two: one
without `guild_id` (a server picker, safest) and one pinned to `DISCORD_GUILD_ID`.
Open it in a browser as the guild owner and authorise.

Scope is `bot` only. Verified against the live authorize endpoint: `bot` and
`bot applications.commands` return 200, while `applications.commands.update`
returns **400** with the near-useless body `{"scope":["1"]}` and
`applications.commands.permissions` is not a scope at all. The bridge registers no
slash commands (`!link` is a plain message handler), so `bot` is sufficient. Add
`applications.commands.update` only after enabling that scope in the Developer
Portal under OAuth2 → URL Generator.

### 2. Get the bot token

Developer Portal → the application → **Bot** → *Reset Token*. This is a **different
secret** from the client secret; a client secret returns `401 Unauthorized` on
`GET /api/v10/gateway/bot` and cannot log in.

### 3. Enable privileged intents

**Bot → Privileged Gateway Intents**: enable **Message Content Intent**, and
**Server Members Intent** if you want nickname → forum rank matching. Without
these the bot connects successfully but every message body reads as empty — the
most common "the bot is online but does nothing" cause.

### 4. Configure and start

Put `DISCORD_BOT_TOKEN` and `DISCORD_BOT_USER_ID` into `.env`, then:

```bash
systemctl --user start discord-forum-bridge
journalctl --user -u discord-forum-bridge -f
```

Confirm membership and permissions were actually granted:

```bash
curl -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  https://discord.com/api/v10/users/@me/guilds
```

## Forum side

- Create the destination category. The bridge looks it up by
  `FORUM_CATEGORY_SLUG` and falls back to the first category, so a missing
  category is not fatal — it logs a warning.
- The bridge authors posts as `NODEBB_BRIDGE_UID`. Use a dedicated account
  (e.g. `discord-bridge`) so bridged posts are attributable and its privileges
  are scoped (`read`, `post:read`, `post:create` on the target category).
- Posts are created with `postQueue = 0`, so they publish immediately.

## Identity linking

In the bridged channel:

```
!link aryma
```

replies with a confirmation and stores `data/links.json`. Without a link the
bridge still mirrors messages, using the Discord nickname in the byline and
deriving the rank from the forum post count once a link exists.

## Rank synchronisation

`identity.js` parses the ladder in the same `min | [Title]` format the forum's
rank plugin uses, so changing levels in `ACP -> Extend -> Plugins -> IMRNES Ranks`
propagates on the next `RANK_SYNC_INTERVAL_SECONDS` refresh without a redeploy.
Edit `DEFAULT_MIN` / `DEFAULT_NAMES` only if you also change the forum ladder.

## Operations

```bash
systemctl --user status discord-forum-bridge
journalctl --user -u discord-forum-bridge -f
systemctl --user restart discord-forum-bridge
```

The forum poller seeds its cursor from the newest post on start, so a restart
never replays history back into Discord.
