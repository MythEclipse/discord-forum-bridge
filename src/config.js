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
	if (!fs.existsSync(file)) {
		return out;
	}
	fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw) => {
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

const config = Object.freeze({
	discord: {
		appId: required('DISCORD_APP_ID'),
		botToken: required('DISCORD_BOT_TOKEN'),
		publicKey: env.DISCORD_PUBLIC_KEY || '',
		clientSecret: env.DISCORD_CLIENT_SECRET || '',
		guildId: required('DISCORD_GUILD_ID'),
		channelId: required('DISCORD_CHANNEL_ID'),
		botUserId: env.DISCORD_BOT_USER_ID || '',
	},
	nodebb: {
		url: (env.NODEBB_URL || 'https://forum.imrnes.team').replace(/\/+$/, ''),
		apiToken: required('NODEBB_API_TOKEN'),
		bridgeUid: env.NODEBB_BRIDGE_UID || '',
	},
	forum: {
		categorySlug: env.FORUM_CATEGORY_SLUG || 'discord-bridge',
		topicPrefix: env.FORUM_TOPIC_PREFIX || 'DISCORD',
	},
	behaviour: {
		syncIntervalMs: num('SYNC_INTERVAL_SECONDS', 20) * 1000,
		raceSyncIntervalMs: num('RANK_SYNC_INTERVAL_SECONDS', 300) * 1000,
		marker: env.BRIDGE_MARKER || '<!-- discord-bridge -->',
	},
});

module.exports = { config, parseEnv };
