'use strict';

/**
 * Print the OAuth2 invite URL for this bot, built from the ids already in .env.
 *
 * Why a script instead of a hardcoded link: the guild id, channel id and app id
 * live in .env, and a link pasted into a README goes stale the moment one of them
 * changes. It also makes the *permissions* auditable - the number below is the
 * sum of the named bits, printed individually so a reviewer can see what the bot
 * is actually being granted.
 */

// config.js exports `config` as a lazy getter precisely so importing it does not
// throw on a missing DISCORD_BOT_TOKEN; parseEnv is safe to call here.
const { parseEnv } = require('../src/config');

const env = parseEnv();

const APP_ID = env.DISCORD_APP_ID;
const GUILD_ID = env.DISCORD_GUILD_ID;
const CHANNEL_ID = env.DISCORD_CHANNEL_ID;

if (!APP_ID) {
	console.error('Set DISCORD_APP_ID in .env first.');
	process.exit(1);
}

// OAuth2 permission bits. Kept explicit (no magic number) so the grant is reviewable.
const PERMISSIONS = {
	VIEW_CHANNEL: 1n << 10n,          // 1024    read the bridged channel
	SEND_MESSAGES: 1n << 11n,         // 2048    post replies back to the channel
	EMBED_LINKS: 1n << 14n,           // 16384   rich embeds carrying the rank
	READ_MESSAGE_HISTORY: 1n << 16n,  // 65536   mirror existing messages
	CHANGE_NICKNAME: 1n << 26n,       // keeps the bot's guild profile tidy
};

const bits = Object.entries(PERMISSIONS);
const total = bits.reduce((sum, [, bit]) => sum + bit, 0n);

console.log('Permissions requested:');
bits.forEach(([name, bit]) => console.log(`  ${name.padEnd(20)} ${bit}`));
console.log(`  ${'TOTAL'.padEnd(20)} ${total}\n`);

// A channel id and a guild id are different snowflake namespaces and must never
// be equal. Equality means the guild id was copy-pasted off the wrong screen.
const guildSuspect = Boolean(GUILD_ID) && Boolean(CHANNEL_ID) && GUILD_ID === CHANNEL_ID;
if (guildSuspect) {
	console.warn('WARNING: DISCORD_GUILD_ID is identical to DISCORD_CHANNEL_ID.');
	console.warn('         Those are different id spaces, so one of them is wrong.');
	console.warn('         Right-click the server name -> "Copy Server ID" (enable');
	console.warn('         User Settings -> Advanced -> Developer Mode first).\n');
}

// Scope list.
//
// Verified empirically against the live authorize endpoint (2026-10-09), because
// the docs list scopes this application is not configured for and a wrong scope
// makes Discord answer HTTP 400 with the unhelpful body `{"scope":["1"]}`:
//
//   scope=bot                              -> 200  (join as a bot)
//   scope=bot+applications.commands        -> 200  (implied by `bot` anyway)
//   scope=bot+applications.commands.update -> 400  {"scope":["1"]}  <- rejected
//   scope=bot+applications.commands.permissions -> 400 (not a scope at all)
//
// The bridge registers no slash commands - `!link` is a plain message handler -
// so `bot` alone is both sufficient and the minimal grant. Add
// `applications.commands.update` ONLY after enabling the matching scope in the
// Developer Portal under OAuth2 -> URL Generator.
const scopes = 'bot';

// Preferred URL deliberately OMITS guild_id, so the authorize screen shows the
// picker and you can see which server you are installing into.
const safe = new URLSearchParams({
	client_id: APP_ID,
	scope: scopes,
	permissions: total.toString(),
	disable_guild_select: 'false',
});

console.log('STEP 1 - open this, then pick the server in the dropdown:\n');
console.log(`https://discord.com/api/oauth2/authorize?${safe.toString()}`);

if (GUILD_ID && !guildSuspect) {
	const pinned = new URLSearchParams({
		client_id: APP_ID,
		scope: scopes,
		permissions: total.toString(),
		guild_id: GUILD_ID,
		disable_guild_select: 'true',
	});
	console.log('\n\nSTEP 1 (alternative) - pin directly if DISCORD_GUILD_ID is already correct:\n');
	console.log(`https://discord.com/api/oauth2/authorize?${pinned.toString()}`);
}

console.log('\n\nSTEP 2 - Developer Portal -> your app -> Bot page:');
console.log('  a. Reset Token -> DISCORD_BOT_TOKEN. This is a DIFFERENT secret from');
console.log('     the client secret you already have.');
console.log('  b. Copy Application ID -> DISCORD_BOT_USER_ID. (The bot\'s own user id');
console.log('     is a separate field further down the same page; either is accepted');
console.log('     because the bridge overwrites it at login, but the bot user id is');
console.log('     the correct value.)');
console.log('  c. Enable Message Content Intent - and Server Members Intent if you want');
console.log('     nickname -> forum rank matching. Without these the bot connects');
console.log('     successfully but sees every message body as empty.');
console.log('\nSTEP 3 - write the values into .env, then:');
console.log('  systemctl --user start discord-forum-bridge');
console.log('  journalctl --user -u discord-forum-bridge -f');
console.log('\nSTEP 4 - confirm it really joined and can read:');
console.log('  curl -H "Authorization: Bot $DISCORD_BOT_TOKEN" \\');
console.log('    https://discord.com/api/v10/users/@me/guilds');
