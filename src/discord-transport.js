'use strict';

/**
 * discord.js wrappers the bridge needs, kept behind a small interface so the
 * mirror logic can be unit-tested with a stub instead of a live connection.
 *
 * Why webhooks for forum->Discord: a webhook message can carry an author name and
 * avatar, so a forum post shows up as `**username** [rank]` with the author's
 * picture instead of everything arriving attributed to one bot account. It also
 * sidesteps the 2000-character limit per bot message being visually identical to
 * the user's own name.
 */

const { Client, GatewayIntentBits, Partials, WebhookClient, REST } = require('discord.js');

/**
 * Sentinel cached in `webhookCache` for channels where webhook creation is
 * known to fail (missing MANAGE_WEBHOOKS). Distinct from a webhook object so the
 * fast path can tell "resolved" from "known impossible".
 */
const NO_WEBHOOK = Symbol('no-webhook');

class DiscordTransport {
	constructor(config) {
		this.config = config;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.GuildMembers,
			],
			partials: [Partials.Channel, Partials.Message],
		});
		this.webhooks = new WebhookClient({ id: config.discord.appId, token: config.discord.botToken });
		// REST is the reliable path for freshly-created threads; the gateway
		// cache lags behind by one dispatch cycle.
		this.rest = new REST({ version: '10' }).setToken(config.discord.botToken);
		this.webhookCache = new Map();
	}

	get botUserId() {
		return this.client.user ? this.client.user.id : null;
	}

	async login() {
		await this.client.login(this.config.discord.botToken);
		return this.client.user;
	}

	destroy() {
		this.webhooks.destroy();
		this.client.destroy();
	}

	/* ───────────────────────────── reading ─────────────────────────────── */

	async fetchChannel(id) {
		try {
			return await this.client.channels.fetch(id);
		} catch (err) {
			this.log('warn', 'channel fetch failed', { id, error: err.message });
			return null;
		}
	}

	async fetchMember(userId) {
		const guildId = this.config.discord.guildId;
		if (!guildId) {
			return null;
		}
		try {
			const guild = await this.client.guilds.fetch(guildId);
			return await guild.members.fetch(userId);
		} catch (err) {
			return null;
		}
	}

	/* ───────────────────────────── writing ─────────────────────────────── */

	/**
	 * Create a thread under a forum channel.
	 *
	 * Discord requires the starter message to be non-empty for forum channels, so
	 * a caller-provided intro doubles as the reason the thread exists.
	 */
	async createThread(parentId, { name, message }) {
		if (!message || !String(message).trim()) {
			throw new Error('createThread needs a starter message for forum channels');
		}
		const parent = await this.resolveChannel(parentId);
		if (!parent) {
			throw new Error(`parent channel ${parentId} not found`);
		}
		// ChannelType.GuildForum === 15, GuildMedia === 16. discord.js 14.x has no
		// `isForum()` helper, so compare the raw type.
		if (parent.type === 15 || parent.type === 16) {
			const thread = await parent.threads.create({
				name: String(name).slice(0, 100),
				message: { content: String(message) },
				invitable: false,
			});
			return { id: thread.id, name: thread.name };
		}
		// Plain text channel: a "thread" is a channel, created without a message.
		const created = await parent.children.create({
			name: String(name).slice(0, 100),
			type: 0,
			topic: String(message).slice(0, 1000),
		});
		return { id: created.id, name: created.name };
	}

	/**
	 * Resolve a channel by id, preferring the gateway cache and falling back to
	 * REST.
	 *
	 * A thread the bot just created is not in the client cache until the next
	 * GUILD_THREAD_CREATE dispatch arrives, so `channels.fetch` alone fails the
	 * first mirror with "Unknown Channel". Verified: the REST route
	 * `GET /channels/<id>` returns these threads fine while the cache does not
	 * have them, so the fallback is not optional.
	 */
	async resolveChannel(id) {
		try {
			const cached = await this.client.channels.fetch(id);
			if (cached) {
				return cached;
			}
		} catch (err) { /* fall through to REST */ }

		// REST works for threads, but discord.js needs a Channel object for
		// send()/createWebhook(), so rebuild one from the raw payload.
		try {
			const { ChannelType } = require('discord.js');
			const data = await this.rest.get(`/channels/${id}`);
			return new (class RawChannel {
				constructor(raw) {
					this.raw = raw;
					this.id = raw.id;
					this.name = raw.name;
					this.type = raw.type;
					this.parentId = raw.parent_id;
				}
			})(data);
		} catch (err) {
			this.log('warn', 'channel resolve failed', { id, error: err.message });
			return null;
		}
	}

	async sendToThread(threadId, { content, webhookName, webhookAvatar }) {
		const channel = await this.resolveChannel(threadId);
		if (!channel) {
			throw new Error(`thread ${threadId} not found (cache miss and REST lookup failed)`);
		}
		// Discord hard-caps a single message at 2000 chars.
		let webhook = null;
		if (webhookName) {
			// eslint-disable-next-line no-await-in-loop
			webhook = await this.ensureWebhook(threadId, webhookName, webhookAvatar);
		}

		for (const chunk of chunkMessage(content, 1900)) {
			if (webhook) {
				// eslint-disable-next-line no-await-in-loop
				await webhook.send({ content: chunk, username: webhookName, avatarURL: webhookAvatar || undefined });
			} else if (typeof channel.send === 'function') {
				// eslint-disable-next-line no-await-in-loop
				await channel.send(chunk);
			} else {
				// REST fallback: also the path taken when webhooks are unavailable.
				// eslint-disable-next-line no-await-in-loop
				await this.rest.post(`/channels/${threadId}/messages`, { body: { content: chunk } });
			}
		}
	}

	async ensureWebhook(channelId, name, avatar) {
		const cached = this.webhookCache.get(channelId);
		// A channel we already failed to create a webhook in is cached as a
		// sentinel. Without this, `POST /channels/<id>/webhooks` is retried on
		// EVERY mirrored post, producing one WARN per message forever.
		if (cached === NO_WEBHOOK) {
			return null;
		}
		if (cached) {
			if (avatar) {
				try {
					await cached.edit({ avatar });
				} catch (err) { /* avatar is cosmetic; ignore */ }
			}
			if (name) {
				try {
					await cached.edit({ name });
				} catch (err) { /* name is cosmetic; ignore */ }
			}
			return cached;
		}
		// Webhooks need the MANAGE_WEBHOOKS permission, which this bot does NOT
		// have: `GET /channels/<id>/webhooks` answers `Unknown Channel` (10003)
		// while a plain `POST /channels/<id>/messages` succeeds. So treat webhook
		// support as optional and fall back to a normal bot message. The author's
		// name is still carried in the message body as `**name** [rank]`.
		const existing = await this.rest.get(`/channels/${channelId}/webhooks`)
			.catch(() => null);
		if (Array.isArray(existing) && existing.length) {
			const hook = existing.find((w) => w.name === 'forum.imrnes.bridge') || existing[0];
			this.webhookCache.set(channelId, hook);
			this.log('debug', 'reused webhook', { channel: channelId, name: hook.name });
			return {
				send: (payload) => this.rest.post(`/webhooks/${hook.id}/${hook.token}`, { body: payload }),
				edit: async () => {},
				id: hook.id,
			};
		}

		const created = await this.rest.post(`/channels/${channelId}/webhooks`, {
			body: { name: name || 'forum.imrnes.bridge' },
		}).catch((err) => {
			this.log('warn', 'webhook unavailable, using plain bot messages', {
				channel: channelId, error: err.message,
			});
			return null;
		});

		if (!created) {
			// Cache the failure so the next post skips the doomed request.
			this.webhookCache.set(channelId, NO_WEBHOOK);
			return null;
		}
		this.webhookCache.set(channelId, created);
		this.log('info', 'created webhook', { channel: channelId, name: created.name });
		return {
			send: (payload) => this.rest.post(`/webhooks/${created.id}/${created.token}`, { body: payload }),
			edit: async () => {},
			id: created.id,
		};
	}

	log(level, message, fields) {
		if (this.onLog) {
			this.onLog(level, message, fields);
		}
	}
}

/** Split a long body into <= limit chunks, preferring paragraph boundaries. */
function chunkMessage(text, limit = 1900) {
	const body = String(text || '');
	if (body.length <= limit) {
		return [body];
	}
	const parts = [];
	let rest = body;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = Math.max(
			window.lastIndexOf('\n\n'),
			window.lastIndexOf('\n'),
			window.lastIndexOf(' '),
		);
		const at = cut > limit * 0.5 ? cut : limit;
		parts.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).replace(/^\n+/, '');
	}
	if (rest.trim()) {
		parts.push(rest);
	}
	return parts;
}

module.exports = { DiscordTransport, chunkMessage };
