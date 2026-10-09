'use strict';

/**
 * Configuration loader. Reads .env (never printed, never logged) and exposes a
 * frozen config object. Fails fast on missing required values so the service
 * refuses to start half-configured instead of silently no-op'ing.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function parseEnv(file) {
	const out = {};
	// default to ENV_PATH: an undefined path makes fs.existsSync throw a
	// deprecation warning and returns false, silently yielding an empty env.
	const target = file || ENV_PATH;
	if (!fs.existsSync(target)) {
		return out;
	}
	fs.readFileSync(target, 'utf8').split(/\r?\n/).forEach((raw) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			return;
		}
		const eq = line.indexOf('=');
		if (eq === -1) {
			return;
		}
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[line.slice(0, eq).trim()] = value;
	});
	return out;
}

const env = parseEnv(ENV_PATH);

function required(name) {
	const value = env[name];
	if (!value) {
		throw new Error(`Missing required config ${name} in ${ENV_PATH}`);
	}
	return value;
}

function num(name, fallback) {
	const value = parseInt(env[name], 10);
	return Number.isFinite(value) ? value : fallback;
}

function buildConfig() {
	return Object.freeze({
	discord: {
		appId: required('DISCORD_APP_ID'),
		botToken: required('DISCORD_BOT_TOKEN'),
		publicKey: env.DISCORD_PUBLIC_KEY || '',
		clientSecret: env.DISCORD_CLIENT_SECRET || '',
		guildId: required('DISCORD_GUILD_ID'),
		channelId: required('DISCORD_CHANNEL_ID'),
		botUserId: env.DISCORD_BOT_USER_ID || '',
		// Cap on attachments mirrored Discord -> forum per message. Each file is
		// downloaded and re-uploaded, so this bounds the work one message can cause.
		maxAttachments: Number(env.DISCORD_MAX_ATTACHMENTS || 5),
	},
	nodebb: {
		url: (env.NODEBB_URL || 'https://forum.imrnes.team').replace(/\/+$/, ''),
		apiToken: required('NODEBB_API_TOKEN'),
		// The token handed to the bridge is a MASTER token, which NodeBB only
		// accepts together with `?_uid=`. Leaving authMode on 'user' would 400 on
		// every single call, so this is explicit rather than inferred.
		authMode: env.NODEBB_AUTH_MODE || 'master',
		bridgeUid: env.NODEBB_BRIDGE_UID || '',
	},
	forum: {
		categorySlug: env.FORUM_CATEGORY_SLUG || 'general-discussion',
		// '1' creates a Discord thread for every existing topic at boot. Set to
		// '0' to only mirror topics that get activity after start.
		backfill: env.FORUM_BACKFILL || '1',
	},
	behaviour: {
		syncIntervalMs: num('SYNC_INTERVAL_SECONDS', 20) * 1000,
		raceSyncIntervalMs: num('RANK_SYNC_INTERVAL_SECONDS', 300) * 1000,
		marker: env.BRIDGE_MARKER || '<!-- imrnes-bridge -->',
	},
	});
}

// Lazy on purpose. An eager `Object.freeze({...})` runs the `required()` checks
// at require() time, so merely importing this module throws when DISCORD_BOT_TOKEN
// is absent - which blocks forum-only tooling from loading the NodeBB half.
let cached = null;

module.exports = {
	parseEnv,
	loadNodebbConfig,
	get config() {
		if (!cached) {
			cached = buildConfig();
		}
		return cached;
	},
};

/**
 * Load only the NodeBB half of the config.
 *
 * `config` is built eagerly and fail-fasts on a missing DISCORD_BOT_TOKEN, which
 * is correct for the bridge process but blocks forum-only tooling (the ACP panel
 * verification script, the live probe) from checking the forum side before the
 * bot credentials exist. `loadNodebbConfig()` parses .env again and validates
 * only what the forum half needs.
 */
function loadNodebbConfig() {
	const env = parseEnv();
	if (!env.NODEBB_API_TOKEN) {
		throw new Error(`Missing required config NODEBB_API_TOKEN in ${ENV_PATH}`);
	}
	if ((env.NODEBB_AUTH_MODE || 'master') === 'master' && !env.NODEBB_BRIDGE_UID) {
		throw new Error('NODEBB_AUTH_MODE=master requires NODEBB_BRIDGE_UID');
	}
	return {
		url: (env.NODEBB_URL || 'https://forum.imrnes.team').replace(/\/+$/, ''),
		apiToken: env.NODEBB_API_TOKEN,
		authMode: env.NODEBB_AUTH_MODE || 'master',
		bridgeUid: env.NODEBB_BRIDGE_UID || '',
	};
}

