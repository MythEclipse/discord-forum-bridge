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
const { readState, writeState } = require('./state');

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
				// setLadder throws on unusable input, so a malformed payload surfaces
				// here instead of silently leaving the previous ladder in place.
				this.identity.setLadder(res.levels);
				log.info('rank ladder refreshed', `${this.identity.ladder.length} levels from forum`);
				return;
			}
			log.warn('forum returned an empty ladder, keeping the previous one');
		} catch (err) {
			log.warn('rank ladder fetch failed, keeping the previous ladder', err.message);
		}
	}

	/**
	 * Find the existing mirror topic, or create it.
	 *
	 * `topicId` alone is NOT enough: it is in-memory only, so every restart would
	 * create a SECOND mirror topic and the forum would fill with duplicates. The
	 * persisted `data/state.json` is the source of truth for the tid, and if that
	 * is missing or stale we search the category for a topic carrying our marker.
	 */
	async ensureTopic() {
		if (this.topicId) {
			return this.topicId;
		}
		const title = `${this.config.forum.topicPrefix} ${this.config.discord.channelId}`;
		const marker = `<!-- channel:${this.config.discord.channelId} -->`;

		// 1) persisted state from a previous run
		const saved = await this.loadState();
		if (saved && saved.topicId) {
			const existing = await this.topicExists(saved.topicId);
			if (existing) {
				this.topicId = saved.topicId;
				this.topicTitle = saved.topicTitle || null;
				log.info('resumed mirror topic from state', { tid: this.topicId });
				return this.topicId;
			}
			log.warn('state pointed at a topic that no longer exists', { tid: saved.topicId });
		}

		// 2) search the category for an existing mirror topic
		if (this.config.forum.categorySlug) {
			try {
				const cid = await this.resolveCategoryId();
				if (cid !== null) {
					const found = await this.findTopicByMarker(cid, marker);
					if (found) {
						this.topicId = found;
						this.topicTitle = found;
						await this.saveState({ topicId: this.topicId, topicTitle: this.topicTitle });
						log.info('adopted existing mirror topic by marker', { tid: this.topicId });
						return this.topicId;
					}
				}
			} catch (err) {
				log.warn('mirror topic search failed', err.message);
			}
		}
		const intro = [
			`<p>Mirror dari Discord channel <code>${escapeHtml(this.config.discord.channelId)}</code>.</p>`,
			`<p>Pesan di channel ini otomatis menjadi balasan di topik ini, dan balasan di sini `
			+ `otomatis terkirim ke Discord.</p>`,
			`${marker}`,
			this.config.behaviour.marker,
		].join('\n');

		const cid = await this.resolveCategoryId();

		// No slug match and no fallback: the write will fail loudly rather than
		// silently posting to an arbitrary category.

		const created = await this.nodebb.createTopic({
			cid: cid,
			title: title,
			content: intro,
		});
		this.topicId = created.tid;
		this.topicTitle = created.slug || title;
		await this.saveState({ topicId: this.topicId, topicTitle: this.topicTitle });
		log.info('created forum topic', { tid: this.topicId, cid });
		return this.topicId;
	}

	loadState() {
		return readState();
	}

	saveState(patch) {
		return writeState(patch);
	}

	async resolveCategoryId() {
		try {
			const cat = await this.nodebb.getCategoryBySlug(this.config.forum.categorySlug);
			const cats = (cat && cat.categories) || [];
			return cats.length ? cats[0].cid : null;
		} catch (err) {
			log.warn('category lookup failed', err.message);
			return null;
		}
	}

	/**
	 * Locate an existing mirror topic by its marker comment.
	 *
	 * Two details that are easy to get wrong:
	 *  - the category topic list paginates and both `start` and `stop` are
	 *    required, so walk it in pages rather than asking once;
	 *  - marker detection MUST use the v3 single-post route. v1's topic payload
	 *    HTML-escapes the body, turning `<!-- channel:x -->` into
	 *    `&lt;!-- channel:x --&gt;`, so a comment search over v1 never matches.
	 */
	async findTopicByMarker(cid, marker) {
		const PAGE = 50;
		const MAX_PAGES = 10;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const res = await this.nodebb.getCategoryTopics(cid, { from: page * PAGE, to: page * PAGE + PAGE });
			const topics = (res && res.topics) || [];
			if (!topics.length) {
				return null;
			}
			for (const topic of topics) {
				if (!String(topic.title || '').includes(this.config.discord.channelId)) {
					continue;
				}
				if (await this.topicCarriesMarker(topic.tid, marker)) {
					return topic.tid;
				}
			}
			if (topics.length < PAGE) {
				return null;
			}
		}
		log.warn('mirror topic search hit the page limit; giving up to avoid a duplicate');
		return null;
	}

	async topicCarriesMarker(tid, marker) {
		try {
			const topic = await this.nodebb.getTopic(tid);
			const mainPid = topic && topic.mainPid;
			if (!mainPid) {
				return false;
			}
			const post = await this.nodebb.getPost(mainPid);
			return Boolean(post && String(post.content || '').includes(marker));
		} catch (err) {
			log.warn('marker check failed', { tid, error: err.message });
			return false;
		}
	}

	async topicExists(tid) {
		try {
			await this.nodebb.getTopic(tid);
			return true;
		} catch (err) {
			return false;
		}
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
		const link = `${this.config.nodebb.publicUrl}/post/${post.pid}`;
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
