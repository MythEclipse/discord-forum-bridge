'use strict';

/**
 * Two-way bridge core, transport-agnostic.
 *
 * Discord -> Forum:  each new channel message becomes a reply in a forum topic
 *                    created lazily on the first message of the run.
 * Forum -> Discord:  each new reply in a bridged topic is posted to the channel,
 *                    attributed to the author with their forum rank as the
 *                    Discord display name.
 *
 * Echo prevention: every bridged forum post embeds the marker comment, and any
 * forum post containing the marker is skipped on the way back. Discord messages
 * authored by the bridge bot are skipped in the other direction.
 */

const { IdentityStore } = require('./identity');
const log = require('./log');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
	return String(text || '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

class Bridge {
	constructor({ discord, nodebb, config }) {
		this.discord = discord;
		this.nodebb = nodebb;
		this.config = config;
		this.identity = new IdentityStore();
		this.topicId = null;          // forum tid mirroring the channel
		this.topicTitle = null;
		this.seenDiscord = new Set(); // message ids already pushed to the forum
		this.seenForum = new Set();   // pids already pushed to Discord
		this.botUserId = config.discord.botUserId || null;
	}

	setBotUserId(id) {
		this.botUserId = id;
		this.config.discord.botUserId = id;
	}

	async loadRankLadder() {
		// The forum's rank plugin owns the ladder; read it so ACP edits propagate.
		// GET /api/imrnes-ranks/levels is a public read-only route the plugin
		// registers on load - no token needed.
		try {
			const res = await this.nodebb.getRankLadder();
			if (res && Array.isArray(res.levels) && res.levels.length) {
				this.identity.setLadder(res.levels);
				log.info('rank ladder refreshed', `${this.identity.ladder.length} levels from forum`);
				return;
			}
			log.warn('forum returned an empty ladder, keeping previous/defaults');
		} catch (err) {
			log.warn('rank ladder fetch failed, using defaults', err.message);
		}
	}

	async ensureTopic() {
		if (this.topicId) {
			return this.topicId;
		}
		const title = `${this.config.forum.topicPrefix} ${this.config.discord.channelId}`;
		const marker = `<!-- channel:${this.config.discord.channelId} -->`;
		const intro = [
			`<p>Mirror dari Discord channel <code>${escapeHtml(this.config.discord.channelId)}</code>.</p>`,
			`<p>Pesan di channel ini otomatis menjadi balasan di topik ini, dan balasan di sini `
			+ `otomatis terkirim ke Discord.</p>`,
			`${marker}`,
			this.config.behaviour.marker,
		].join('\n');

		let cid = null;
		try {
			const cat = await this.nodebb.getCategoryBySlug(this.config.forum.categorySlug);
			if (cat && Array.isArray(cat.categories) && cat.categories.length) {
				cid = cat.categories[0].cid;
			}
		} catch (err) {
			log.warn('category lookup failed, falling back to default category', err.message);
		}

		// No slug match and no fallback: the write will fail loudly rather than
		// silently posting to an arbitrary category.

		const created = await this.nodebb.createTopic({
			cid: cid,
			title: title,
			content: intro,
		});
		this.topicId = created.tid;
		this.topicTitle = created.slug || title;
		log.info('created forum topic', { tid: this.topicId, cid });
		return this.topicId;
	}

	discordMessageToHtml(message, member) {
		const link = `https://discord.com/channels/${this.config.discord.guildId}/${this.config.discord.channelId}/${message.id}`;
		const nickname = (member && (member.displayName || member.nickname)) || (member && member.user && member.user.username) || 'unknown';
		const postcount = (member && member.forumPostcount) || 0;
		const rank = this.identity.rankTitleFor(postcount);
		const linked = this.identity.findByDiscordId(member.id) || (member && member.user ? this.identity.findByUsername(member.user.username) : null);

		const lines = [
			`<p><strong>${escapeHtml(nickname)}</strong> `
			+ `<span class="imrnes-rank">${escapeHtml(rank)}</span></p>`,
			`<blockquote>${escapeHtml(message.content).replace(/\n/g, '<br />')}</blockquote>`,
			`<p><a href="${link}">Lihat di Discord</a></p>`,
			`<p><small>Discord: <code>${escapeHtml(nickname)}</code>`
			+ `${linked && linked.username ? ` &middot; forum: <code>${escapeHtml(linked.username)}</code>` : ''}</small></p>`,
			this.config.behaviour.marker,
		].filter(Boolean);
		return lines.join('\n');
	}

	async onDiscordMessage(message, member) {
		if (!message || message.author && message.author.bot) {
			return null;
		}
		if (this.botUserId && message.author.id === this.botUserId) {
			return null;
		}
		if (this.seenDiscord.has(message.id)) {
			return null;
		}
		const tid = await this.ensureTopic();
		const content = this.discordMessageToHtml(message, member);
		const res = await this.nodebb.replyToTopic(tid, { content });
		this.seenDiscord.add(message.id);
		log.info('discord -> forum', { discordId: message.id, pid: res && res.pid });
		return res;
	}

	forumPostToDiscordText(post, author) {
		const stripped = String(post.content || '')
			.replace(/<!--[^>]*-->/g, '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<[^>]+>/g, '')
			.trim();
		return stripped || '(post kosong)';
	}

	async onForumReply(post, author) {
		if (!post || String(post.content || '').includes(this.config.behaviour.marker)) {
			return null;
		}
		if (post.pid && this.seenForum.has(post.pid)) {
			return null;
		}
		if (post.uid === this.config.nodebb.bridgeUid) {
			return null;
		}
		const rank = this.identity.rankTitleFor(author ? author.postcount : 0);
		const name = (author && (author.displayname || author.username)) || 'Forum user';
		const link = `${this.config.nodebb.url}/post/${post.pid}`;
		await this.discord.send({
			channelId: this.config.discord.channelId,
			content: `**${name}** [${rank.replace(/[\[\]]/g, '')}]\n${this.forumPostToDiscordText(post, author)}\n${link}`,
			authorName: name,
			rankTitle: rank,
		});
		if (post.pid) {
			this.seenForum.add(post.pid);
		}
		log.info('forum -> discord', { pid: post.pid, uid: post.uid });
		return true;
	}
}

module.exports = { Bridge, escapeHtml };
