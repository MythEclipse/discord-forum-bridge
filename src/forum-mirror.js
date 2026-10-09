'use strict';

/**
 * Forum-mode mirror: NodeBB category <-> Discord forum channel.
 *
 * ── Mapping ────────────────────────────────────────────────────────────────
 * One NodeBB topic becomes one Discord THREAD inside the target channel, and
 * every reply in that thread becomes a post on the forum. The Discord channel
 * TYPE decides how the topic lands:
 *
 *   - type 15 ("Forum" / "Forum Media"): topic -> thread. Needs CREATE_THREADS
 *     and MANAGE_THREADS on top of the normal message permissions.
 *   - type 0 ("Guild Text"): topic -> text channel. Simpler, but it clutters
 *     the guild sidebar and cannot nest.
 *
 * Types that cannot be a target: 2 voice, 4 category, 13 stage voice,
 * 14 directory, 16/17/18 media, 11/12 threads (you cannot post a brand-new
 * top-level message to an existing thread over REST).
 *
 * ── tid -> thread id is remembered twice, deliberately ─────────────────────
 *   1. `data/state.json`, so a restart does not spawn duplicate threads;
 *   2. inside the thread NAME as `[t:<tid>]`, so the mapping can be rebuilt
 *      from Discord alone if state is ever lost.
 * An in-memory Map alone is not enough - it is wiped on every restart.
 *
 * ── Echo protection ────────────────────────────────────────────────────────
 * forum->Discord messages embed MARKER; Discord->forum posts embed the same
 * marker. Anything containing it is skipped on the way back, and the bridge uid
 * / bot id are a second line of defence.
 */

const { MARKER, htmlEscape, mdEscape, webhookSafe, htmlToPlainText } = require('./text');
const { readState, writeState } = require('./state');

const TOPIC_PAGE_SIZE = 50;

// Channel types that host threads and therefore accept one thread per topic.
const FORUM_TYPES = new Set([15 /* GuildForum */, 16 /* GuildMedia */]);

class ForumMirror {
	constructor({ nodebb, discord, config, identity, log }) {
		this.nodebb = nodebb;
		this.discord = discord;
		this.config = config;
		this.identity = identity;
		this.log = log;

		this.cid = null;
		this.mode = null;
		this.botUserId = null;
		this.running = false;

		this.topicToThread = new Map();
		this.threadToTopic = new Map();

		// pid -> already mirrored, so a restart never replays a category.
		this.seenForum = new Set();
		this.seenDiscord = new Set();

		// tid -> newest pid mirrored, so polling is cheap and resumable.
		this.topicCursor = new Map();
	}

	setBotUserId(id) {
		this.botUserId = id;
	}

	/* ────────────────────────────── startup ────────────────────────────── */

	async start() {
		const channelId = this.config.discord.channelId;

		const channel = await this.discord.fetchChannel(channelId);
		if (!channel) {
			throw new Error(`discord channel ${channelId} not found`);
		}
		// discord.js 14.27 has no `isForum()` helper (it landed in v15), so compare
		// against the ChannelType enum instead. Checking `isTextBased()` alone is
		// NOT enough: a GuildForum is text-based, which is why an earlier version
		// of this code fell through to `text` mode and would have tried to create
		// a channel inside a forum.
		this.mode = FORUM_TYPES.has(channel.type) ? 'forum' : null;
		if (!this.mode && channel.isTextBased && channel.isTextBased()) {
			this.mode = 'text';
		}
		if (!this.mode) {
			throw new Error(`channel ${channelId} has unsupported type ${channel.type}`);
		}
		this.log.info('discord channel resolved', {
			name: channel.name, type: channel.type, mode: this.mode,
		});

		const res = await this.nodebb.getCategoryBySlug(this.config.forum.categorySlug);
		const cats = (res && res.categories) || [];
		if (!cats.length) {
			throw new Error(`forum category slug "${this.config.forum.categorySlug}" matches nothing`);
		}
		this.cid = cats[0].cid;
		this.log.info('forum category resolved', { cid: this.cid });

		await this.restoreState();
		this.running = true;
	}

	async stop() {
		this.running = false;
	}

	/* ─────────────────────── state: tid <-> thread ─────────────────────── */

	async restoreState() {
		const state = await readState();
		const threads = (state && state.threads) || {};
		Object.entries(threads).forEach(([tid, threadId]) => {
			this.topicToThread.set(String(tid), String(threadId));
			this.threadToTopic.set(String(threadId), String(tid));
		});
		if (this.topicToThread.size) {
			this.log.info('tid->thread map restored', { count: this.topicToThread.size });
		}
	}

	async persistState() {
		const threads = {};
		this.topicToThread.forEach((v, k) => { threads[k] = v; });
		const cursors = {};
		this.topicCursor.forEach((v, k) => { cursors[k] = v; });
		await writeState({ threads, topicCursors: cursors, cid: this.cid });
	}

	/* ───────────────────────── thread mapping ──────────────────────────── */

	async ensureThread(topic) {
		const tid = String(topic.tid);
		const known = this.topicToThread.get(tid);
		if (known) {
			return known;
		}
		const name = this.threadNameFor(topic);
		const created = await this.discord.createThread(this.config.discord.channelId, {
			name,
			message: this.threadIntro(topic),
		});
		this.topicToThread.set(tid, created.id);
		this.threadToTopic.set(created.id, tid);
		await this.persistState();
		this.log.info('created discord thread', { tid, thread: created.id });
		return created.id;
	}

	/**
	 * Thread name carries the tid so a lost state.json can be rebuilt from
	 * Discord alone. Kept short because forum-style thread names feel cramped
	 * past ~70 chars.
	 */
	threadNameFor(topic) {
		const stamp = `[t:${topic.tid}]`;
		const raw = String(topic.title || '').replace(/\[t:\d+\]/g, '').trim();
		const room = 100 - stamp.length - 1;
		const title = raw.slice(0, Math.max(room, 10)).trim();
		return `${stamp} ${title || 'Untitled topic'}`.trim();
	}

	threadIntro(topic) {
		const link = `${this.config.nodebb.url}/topic/${topic.tid}`;
		const when = Number(topic.timestamp) ? new Date(Number(topic.timestamp) * 1000).toISOString() : 'unknown date';
		return [
			`**${mdEscape(String(topic.title || 'Untitled').replace(/\[t:\d+\]/g, '').trim())}**`,
			`_${topic.username ? mdEscape(topic.username) : 'unknown'} - ${when}_`,
			`[Buka di forum.imrnes.team](${link})`,
			MARKER,
		].join('\n');
	}

	/* ───────────────────── backfill: every topic -> a thread ───────────── */

	async backfill() {
		let created = 0;
		let total = 0;
		for (let page = 0; page < 20; page += 1) {
			// The client unwraps the v3 envelope, so this is `{ topics: [...] }`.
			const res = await this.nodebb.listCategoryTopics(this.cid, {
				from: page * TOPIC_PAGE_SIZE, to: page * TOPIC_PAGE_SIZE + TOPIC_PAGE_SIZE,
			});
			const topics = (res && res.topics) || [];
			if (!topics.length) {
				break;
			}
			for (const topic of topics) {
				total += 1;
				const before = this.topicToThread.size;
				try {
					await this.ensureThread(topic);
					if (this.topicToThread.size > before) {
						created += 1;
					}
				} catch (err) {
					this.log.warn('thread backfill failed', { tid: topic.tid, error: err.message });
				}
			}
			if (topics.length < TOPIC_PAGE_SIZE) {
				break;
			}
		}
		this.log.info('backfill complete', { topics: total, threadsCreated: created });
		return { total, created };
	}

	/* ───────────────────── discord inbound: reply -> post ──────────────── */

	async onDiscordMessage(message) {
		if (!message || (message.author && message.author.bot)) {
			return null;
		}
		if (this.botUserId && message.author.id === this.botUserId) {
			return null;
		}
		if (this.seenDiscord.has(message.id)) {
			return null;
		}

		const tid = await this.topicIdForDiscordMessage(message);
		if (!tid) {
			this.log.debug('discord message in an unmapped thread, ignored', { channel: message.channelId });
			return null;
		}

		const member = await this.discord.fetchMember(message.author.id);
		const nickname = member ? (member.displayName || member.user.username) : message.author.username;
		const postcount = await this.discordForumPostcount(member, nickname);
		const rank = this.identity.rankTitleFor(postcount);

		const res = await this.nodebb.replyToTopic(tid, {
			content: this.renderForumPost({
				nickname, rank, content: message.content, link: message.url,
			}),
		});
		this.seenDiscord.add(message.id);
		this.log.info('discord -> forum', { tid, pid: res && res.pid, discord: message.id });
		return res;
	}

	async topicIdForDiscordMessage(message) {
		if (message.channelId && this.threadToTopic.has(message.channelId)) {
			return this.threadToTopic.get(message.channelId);
		}
		const name = String((message.channel && message.channel.name) || '');
		const match = name.match(/\[t:(\d+)\]/);
		return match ? match[1] : null;
	}

	/**
	 * Resolve a member's forum post count so the rank shown in Discord is the
	 * forum rank, not a Discord-side approximation.
	 */
	async discordForumPostcount(member, nickname) {
		if (!member) {
			return 0;
		}
		const link = this.identity.findByDiscordId(member.id)
			|| (nickname ? this.identity.findByUsername(nickname) : null);
		if (!link || !link.username) {
			return 0;
		}
		try {
			const forumUser = await this.nodebb.getUserByUsername(link.username);
			return Number(forumUser && forumUser.postcount) || 0;
		} catch (err) {
			return 0;
		}
	}

	/* ───────────────────── forum inbound: post -> thread reply ─────────── */

	async onForumPost(post, topic) {
		if (!post || !topic) {
			return null;
		}
		if (String(post.content || '').includes(MARKER)) {
			return null;
		}
		if (post.pid && this.seenForum.has(post.pid)) {
			return null;
		}
		if (String(post.uid) === String(this.config.nodebb.bridgeUid)) {
			return null;
		}

		const author = await this.nodebb.getUser(post.uid);
		const rank = this.identity.rankTitleFor(Number(author && author.postcount) || 0);
		const name = (author && (author.displayname || author.username)) || 'Forum user';

		const threadId = await this.ensureThread(topic);

		await this.discord.sendToThread(threadId, {
			content: this.renderDiscordPost({
				name, rank, html: post.content, link: `${this.config.nodebb.url}/post/${post.pid}`,
			}),
			webhookName: webhookSafe(name),
			webhookAvatar: author && author.picture ? `${this.config.nodebb.url}${author.picture}` : null,
		});

		if (post.pid) {
			this.seenForum.add(post.pid);
		}
		this.topicCursor.set(String(topic.tid), Number(post.pid) || 0);
		this.log.info('forum -> discord', { tid: topic.tid, pid: post.pid, thread: threadId });
		return true;
	}

	/* ───────────────────────────── rendering ───────────────────────────── */

	renderDiscordPost({ name, rank, html, link }) {
		return [
			`**${mdEscape(name)}** \`${mdEscape(rank)}\``,
			'',
			htmlToPlainText(html),
			'',
			link,
			MARKER,
		].join('\n');
	}

	renderForumPost({ nickname, rank, content, link }) {
		return [
			`<p><strong>${htmlEscape(nickname)}</strong> <span class="imrnes-rank">${htmlEscape(rank)}</span></p>`,
			`<blockquote>${htmlEscape(String(content || '')).replace(/\n/g, '<br />')}</blockquote>`,
			`<p><a href="${htmlEscape(link)}">Lihat di Discord</a></p>`,
			MARKER,
		].join('\n');
	}

	/* ───────────────────────────── poll loop ───────────────────────────── */

	/**
	 * Mirror every new post in the bridged category. Returns the number of posts
	 * mirrored, so the caller can log a heartbeat.
	 */
	async pollOnce() {
		if (!this.running || this.cid === null) {
			return 0;
		}
		// Surface where a failure came from; "Unknown Channel" alone is useless
		// when the mirror does several channel lookups per cycle.
		const trace = (err) => {
			const e = new Error(`${err.message} (at ${err.nexus || 'unknown'})`);
			e.stackTrace = err.stackTrace || err.stack;
			return e;
		};
		const res = await this.nodebb.listCategoryTopics(this.cid, {
			from: 0, to: TOPIC_PAGE_SIZE,
		});
		const ordered = ((res && res.topics) || []).slice()
			.sort((a, b) => (Number(a.lastposttime) || 0) - (Number(b.lastposttime) || 0));

		let mirrored = 0;
		for (const topic of ordered) {
			const tid = String(topic.tid);
			const cursor = Number(this.topicCursor.get(tid)) || 0;
			let posts;
			try {
				posts = await this.nodebb.getTopicPosts(tid);
			} catch (err) {
				this.log.warn('topic poll failed', { tid, error: trace(err).message });
				continue;
			}
			for (const post of posts.posts || []) {
				const pid = Number(post.pid) || 0;
				if (!pid || pid <= cursor || this.seenForum.has(pid)) {
					continue;
				}
				// eslint-disable-next-line no-await-in-loop
				let ok = false;
				try {
					// eslint-disable-next-line no-await-in-loop
					ok = await this.onForumPost(post, topic);
				} catch (err) {
					this.log.warn('post mirror failed', { tid, pid: post.pid, error: trace(err).message });
				}
				if (ok) {
					mirrored += 1;
				}
			}
		}
		if (mirrored) {
			await this.persistState();
		}
		return mirrored;
	}
}

module.exports = { ForumMirror };
