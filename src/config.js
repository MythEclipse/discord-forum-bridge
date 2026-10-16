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
		// Where the bridge SENDS its API requests. The loopback address is
		// deliberate and cheap: it skips Caddy entirely and cannot be affected by
		// a proxy or certificate problem.
		url: (env.NODEBB_URL || 'http://127.0.0.1:4567').replace(/\/+$/, ''),
		// The PUBLIC origin, used for every URL that LEAVES the host: links
		// pasted into Discord, webhook avatar urls, and absolutising site-relative
		// upload paths.
		//
		// These are two different values and conflating them produced a real,
		// user-visible bug: a mirrored post reached Discord with
		// `http://127.0.0.1:4567/topic/24` as its "Buka di forum" link, which
		// points at the SERVER'S OWN localhost and is meaningless to the reader.
		// Every API call kept succeeding, so nothing looked broken from here.
		publicUrl: publicForumUrl(env),
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

/**
 * The PUBLIC origin of the forum, for URLs that leave the host.
 *
 * Exists because `NODEBB_URL` serves two incompatible purposes. It is the API
 * endpoint, where the loopback address is correct and cheap. It is ALSO the
 * origin stamped into links handed to Discord readers, where the loopback
 * address is meaningless.
 *
 * Precedence:
 *   1. FORUM_PUBLIC_URL - the explicit setting.
 *   2. NODEBB_URL, but ONLY when it is not a loopback address.
 *   3. The configured default.
 *
 * The loopback check is the important part. Falling back to a bare loopback
 * value would reintroduce the exact bug this function exists to prevent, and it
 * would be invisible: every API call still succeeds, so the bridge reports
 * itself healthy while every link it publishes is dead on arrival.
 *
 * A HOST:PORT without a scheme is also rejected, because NodeBB would then be
 * asked for `HOST:PORT/api/...` over plain HTTP and reject it.
 *
 * @param {object} env parsed process env
 * @returns {string} an absolute public origin, no trailing slash
 */
function publicForumUrl(env) {
	const explicit = String(env.FORUM_PUBLIC_URL || '').trim().replace(/\/+$/, '');
	if (explicit) {
		return explicit;
	}
	const fallback = 'https://forum.imrnes.team';
	const candidate = String(env.NODEBB_URL || '').trim();
	if (!candidate) {
		return fallback;
	}
	// Loopback in any of the forms a config can carry: 127.0.0.1, ::1, localhost,
	// and the 0.0.0.0 wildcard a bind address often uses.
	if (/^(https?:\/\/)?(127\.\d+\.\d+\.\d+|localhost|\[::1\]|0\.0\.0\.0|\[::\])(:\d+)?(\/|$)/i.test(candidate)) {
		return fallback;
	}
	// Without a scheme NodeBB cannot route the request; treat it as unusable
	// rather than shipping a url that only fails at request time.
	if (!/^https?:\/\//i.test(candidate)) {
		return fallback;
	}
	return candidate.replace(/\/+$/, '');
}

module.exports = {
	parseEnv,
	loadNodebbConfig,
	publicForumUrl,
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

