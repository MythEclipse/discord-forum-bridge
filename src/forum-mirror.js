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

const { MARKER, mdEscape, webhookSafe, htmlToPlainText, forumPostMarkdown, setForumUrl } = require('./text');
const { readState, writeState } = require('./state');

const TOPIC_PAGE_SIZE = 50;

// Channel types that host threads and therefore accept one thread per topic.
const FORUM_TYPES = new Set([15 /* GuildForum */, 16 /* GuildMedia */]);


/**
 * Is this failure "the channel no longer exists"?
 *
 * Discord's own code for that is 10003 (Unknown Channel), returned as HTTP 404.
 * The status alone is not enough to act on: 404 also means "no such endpoint"
 * and 403 means "exists but you cannot write". Re-creating a thread on any of
 * those would spawn a new thread per failed post, so match on the code too.
 *
 * @param {Error|null} err discord.js REST error
 * @returns {boolean}
 */
function isMissingChannel(err) {
	if (!err) {
		return false;
	}
	const code = err.code;
	const text = String(err.message || '');
	if (code === 10003) {
		return true;
	}
	if (code === 50013 || err.status === 403 || err.status === 401) {
		// Permission problems are NOT a dead channel: the thread is still there.
		return false;
	}
	// Some transports only surface the message.
	return /unknown channel|unknown channel/i.test(text);
}

/**
 * NodeBB returns a literal translation key for a soft-deleted post.
 *
 * Matching the raw string is the only signal available: the post object has a
 * real uid and pid, so nothing about it looks malformed, and it is rendered as
 * a normal post otherwise - which is how it ended up in the Discord thread as
 * the literal text "[[topic:post-is-deleted]]".
 */
function isDeletedPlaceholder(content) {
	const text = String(content || '');
	return text.includes('[[topic:post-is-deleted]]') || /^\[\[topic:post-is-\w+\]\]$/.test(text.trim());
}

class ForumMirror {
	constructor({ nodebb, discord, config, identity, log }) {
		// NodeBB stores uploaded-image `src` as a site-relative path, and Discord
		// cannot resolve one, so htmlToPlainText() needs the absolute origin.
		setForumUrl(config.nodebb.url);
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
		// thread ids proven to exist on Discord, so ensureThread() does not
		// re-GET the same live thread for every single post
		this.threadAlive = new Set();
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

	/**
	 * Resolve the Discord thread for a forum topic, REBUILDING the mapping from
	 * Discord itself before ever creating a new thread.
	 *
	 * `state.json` is the fast path, but it is also the only source of truth if
	 * nothing else is consulted - and it lives outside the repo, so a container
	 * rebuild, a wiped volume, or a hand-restart silently loses it. The previous
	 * behaviour was "no mapping -> create a thread", which is precisely wrong for
	 * a forum-style channel: a second thread for the same topic appears, the
	 * users keep typing in the OLD one (its name is identical), and the bridge
	 * ignores them because `threadToTopic` only knows the new id. Symptom:
	 * "posting in Discord does nothing", forum -> Discord still works.
	 *
	 * The thread NAME is the durable backlink: `threadNameFor()` always prefixes
	 * `[t:<tid>]`, so a lost state.json can be rebuilt from Discord alone with no
	 * DB change. `findThreadByTid` looks that up and re-adopts the existing
	 * thread; a genuinely new topic still gets a new thread.
	 */
	/**
	 * Does this thread still exist on Discord?
	 *
	 * `findThreadByTid` matches on the `[t:N]` name prefix, which survives in
	 * the channel list even for a thread that has been deleted or archived away,
	 * so the name match alone is not proof. A single GET settles it, and the
	 * answer is cached per id so a busy poll does not re-check the same live
	 * thread on every post.
	 */
	async threadExists(threadId) {
		if (!threadId) {
			return false;
		}
		if (this.threadAlive.has(String(threadId))) {
			return true;
		}
		const alive = await this.discord.threadExists(threadId)
			.catch(() => false);
		if (alive) {
			this.threadAlive.add(String(threadId));
		}
		return alive;
	}

	/**
	 * Drop a tid -> thread mapping so the next `ensureThread` re-resolves it.
	 *
	 * The thread object itself is NOT deleted from Discord: a stale entry can
	 * also mean the cached id was never valid, and deleting a live thread would
	 * destroy a conversation. `persistState` is best-effort - if the write fails
	 * the in-memory maps are still correct, and the next successful send
	 * rewrites the file.
	 */
	async forgetThread(tid) {
		const key = String(tid);
		const threadId = this.topicToThread.get(key);
		if (threadId) {
			this.threadToTopic.delete(String(threadId));
			this.threadAlive.delete(String(threadId));
		}
		this.topicToThread.delete(key);
		// Best-effort, and deliberately NOT awaited-critical: the in-memory maps
		// are already correct, and `ensureThread` persists again as soon as it
		// resolves the replacement. A failed write must never abort the self-heal
		// that is trying to restore delivery.
		await this.persistState().catch((err) => {
			this.log.warn('could not persist state after forgetting thread', {
				tid: key, err: err.message,
			});
		});
		return threadId || null;
	}

	async ensureThread(topic) {
		const tid = String(topic.tid);
		const known = this.topicToThread.get(tid);
		if (known) {
			return known;
		}
		const adopted = await this.findThreadByTid(tid);
		if (adopted && await this.threadExists(adopted.id)) {
			this.topicToThread.set(tid, adopted.id);
			this.threadToTopic.set(adopted.id, tid);
			await this.persistState();
			this.log.info('re-adopted existing discord thread', { tid, thread: adopted.id });
			return adopted.id;
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
	 * Find an existing thread for `tid` by scanning the forum channel's threads
	 * for the `[t:<tid>]` prefix `threadNameFor()` writes.
	 *
	 * Cached per tid because `backfill()` calls `ensureThread()` for every topic
	 * in the category and Discord's thread listing is paginated. Archived threads
	 * are skipped unless `includeArchived`, since writing into an archived thread
	 * fails and re-using one would look like a silent dead channel to the user.
	 */
	async findThreadByTid(tid, { includeArchived = false } = {}) {
		const stamp = `[t:${tid}]`;
		const seen = new Set();
		let before = undefined;
		// Discord returns archived threads only when `includeArchived` is set, and
		// the listing is capped, so page until exhausted or the stamp is found.
		for (let page = 0; page < 20; page += 1) {
			// eslint-disable-next-line no-await-in-loop
			const batch = await this.discord.listThreads(this.config.discord.channelId, {
				before, includeArchived,
			});
			const items = (batch && batch.threads) || [];
			if (!items.length) {
				return null;
			}
			for (const th of items) {
				if (!th || seen.has(th.id)) {
					continue;
				}
				seen.add(th.id);
				if (String(th.name || '').startsWith(stamp)) {
					return th;
				}
			}
			before = items[items.length - 1].id;
			// Discord caps `/threads/search` at 25 per page.
			if (items.length < 25) {
				return null;
			}
		}
		return null;
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

		// Resolve the author's forum account so the reply is attributed to THEM.
		// This is what makes the ranks plugin award their own badge: a post made
		// by the bridge account would show the bridge's rank, and any rank we
		// wrote into the body would be a second, unstyled label for the wrong
		// person. Falls back to the bridge account when there is no link.
		const forumUid = await this.discordForumUid(member, nickname);
		const forumUser = forumUid ? await this.nodebb.getUser(forumUid).catch(() => null) : null;
		const postcount = Number(forumUser && forumUser.postcount) || 0;
		const rank = this.identity.rankTitleFor(postcount);

		// Deliberately no `rank` in the body: the forum draws its own badge next
		// to the username, and a body rank would be a duplicate for the wrong
		// account. The rank IS still used above for the outbound Discord mirror
		// and for the log line.
		//
		// Attachments are fetched and re-uploaded to the forum BEFORE the reply is
		// created, so the body can reference the final forum URL. A file that
		// fails to upload must not lose the text, so failures are logged and the
		// message still posts.
		const attachments = await this.mirrorAttachments(message, forumUid);
		const res = await this.nodebb.replyToTopic(tid, {
			content: this.renderForumPost({
				nickname, content: message.content, link: message.url, attachments,
			}),
			asUid: forumUid || undefined,
		});
		this.seenDiscord.add(message.id);
		this.log.info('discord -> forum', {
			tid, pid: res && res.pid, discord: message.id, as: forumUid || 'bridge', rank,
			attachments: attachments.length,
		});
		return res;
	}

	/**
	 * Download every attachment of a Discord message and re-upload it to the
	 * forum, returning `{ url, name }` entries pointing at the FORUM copies.
	 *
	 * Upload attribution matters: with a master token the upload runs as
	 * `asUid`, so the file lands in that user's uploads folder and respects the
	 * same `upload:post:image` privilege the reply itself does. Without it the
	 * bridge account would silently become the owner of everyone's files.
	 */
	async mirrorAttachments(message, forumUid) {
		// discord.js hands over a Collection (iterable, with `.size`), not an
		// array, so normalise before slicing - otherwise `list.slice` is undefined.
		const list = message.attachments
			? Array.from(message.attachments.values ? message.attachments.values() : message.attachments)
			: [];
		if (!list.length) {
			return [];
		}
		const limit = Number(this.config.discord.maxAttachments || 5);
		const out = [];
		for (const att of list.slice(0, limit)) {
			const url = (att && att.url) || null;
			if (!url) {
				continue;
			}
			try {
				// eslint-disable-next-line no-await-in-loop
				const buf = await this.nodebb.downloadBinary(url);
				// eslint-disable-next-line no-await-in-loop
				const uploaded = await this.nodebb.uploadAttachment(
					buf, (att.name || 'attachment'), { asUid: forumUid || undefined, contentType: att.type }
				);
				out.push({ url: uploaded.url, name: uploaded.name });
			} catch (err) {
				this.log.warn('attachment upload failed', {
					discord: message.id, file: att.name, err: err.message,
				});
			}
		}
		return out;
	}

	/**
	 * Map a Discord member to a forum uid via the identity store. Returns null
	 * when the member is not linked, and the caller then posts as the bridge.
	 */
	async discordForumUid(member, nickname) {
		if (!member) {
			return null;
		}
		const link = this.identity.findByDiscordId(member.id)
			|| (nickname ? this.identity.findByUsername(nickname) : null);
		if (!link || !link.username) {
			return null;
		}
		try {
			const forumUser = await this.nodebb.getUserByUsername(link.username);
			return (forumUser && forumUser.uid) || null;
		} catch (err) {
			return null;
		}
	}

	async topicIdForDiscordMessage(message) {
		if (message.channelId && this.threadToTopic.has(message.channelId)) {
			return this.threadToTopic.get(message.channelId);
		}
		const name = String((message.channel && message.channel.name) || '');
		const match = name.match(/\[t:(\d+)\]/);
		return match ? match[1] : null;
	}

	/* ───────────────────── forum inbound: post -> thread reply ─────────── */

	async onForumPost(post, topic) {
		if (!post || !topic) {
			return null;
		}
		// A soft-deleted post is returned by the API as a literal
		// `[[topic:post-is-deleted]]` placeholder. It can never be rendered, and
		// - critically - it must NOT hold the cursor: see advancePast().
		if (isDeletedPlaceholder(post.content)) {
			this.log.debug('skipping a deleted post placeholder', { tid: topic.tid, pid: post.pid });
			this.advancePast(topic.tid, post.pid);
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

		let sent = false;
		let sendErr = null;
		try {
			await this.discord.sendToThread(threadId, {
				content: this.renderDiscordPost({
					name, rank, html: post.content, link: `${this.config.nodebb.url}/post/${post.pid}`,
				}),
				webhookName: webhookSafe(name),
				webhookAvatar: author && author.picture ? `${this.config.nodebb.url}${author.picture}` : null,
			});
			sent = true;
		} catch (err) {
			sendErr = err;
		}

		// Self-heal a dead thread mapping.
		//
		// Discord deletes an archived forum thread eventually, and a user can
		// delete one at any time. `state.json` keeps the id regardless, so the
		// failure is silent and one-directional: `ensureThread` trusts the cached
		// id, `sendToThread` gets 404 "Unknown Channel", and every subsequent
		// forum -> Discord post for that topic fails the same way while
		// Discord -> Forum keeps working (it only needs the cursor). Reported as
		// "the bridge is broken in one direction".
		//
		// Drop the stale mapping and re-resolve once. Only a "channel is gone"
		// status triggers the retry - a 429 or a webhook permission problem must
		// NOT cause a new thread per post.
		if (!sent && isMissingChannel(sendErr)) {
			this.log.warn('mapped discord thread is gone, re-resolving', {
				tid: topic.tid, thread: threadId, err: sendErr.message,
			});
			this.forgetThread(topic.tid);
			const fresh = await this.ensureThread(topic);
			try {
				await this.discord.sendToThread(fresh, {
					content: this.renderDiscordPost({
						name, rank, html: post.content, link: `${this.config.nodebb.url}/post/${post.pid}`,
					}),
					webhookName: webhookSafe(name),
					webhookAvatar: author && author.picture ? `${this.config.nodebb.url}${author.picture}` : null,
				});
				this.log.info('re-created discord thread and delivered', { tid: topic.tid, thread: fresh });
				if (post.pid) {
					this.seenForum.add(post.pid);
				}
				this.topicCursor.set(String(topic.tid), Number(post.pid) || 0);
				return true;
			} catch (retryErr) {
				this.log.warn('post mirror failed after thread re-create', {
					tid: topic.tid, pid: post.pid, error: retryErr.message,
				});
				this.advancePast(topic.tid, post.pid);
				return false;
			}
		}
		if (!sent) {
			this.log.warn('post mirror failed', {
				tid: topic.tid, pid: post.pid, error: sendErr && sendErr.message,
			});
			// Do not let one undeliverable post block the rest of the topic. A
			// transient failure (429, webhook perms) will be retried on the next
			// poll only if the cursor stays behind; advancing here means the post
			// is dropped instead of stalling everything after it. Delivery is
			// best-effort by design - the forum remains the source of truth.
			this.advancePast(topic.tid, post.pid);
			return false;
		}

		if (post.pid) {
			this.seenForum.add(post.pid);
		}
		this.topicCursor.set(String(topic.tid), Number(post.pid) || 0);
		this.log.info('forum -> discord', { tid: topic.tid, pid: post.pid, thread: threadId });
		return true;
	}

	/**
	 * Move the cursor past `pid` without mirroring anything.
	 *
	 * The cursor is a high-water mark, so it MUST advance for every post the
	 * bridge has considered - including ones it can never deliver. Otherwise the
	 * first permanently undeliverable post wedges the topic: `pollOnce` only
	 * considers posts newer than the cursor, so everything after it is invisible
	 * forever. That is what a single `[[topic:post-is-deleted]]` placeholder did
	 * - it silently stranded every later post in the topic.
	 */
	advancePast(tid, pid) {
		const n = Number(pid) || 0;
		if (!n) {
			return;
		}
		const key = String(tid);
		if (n > (Number(this.topicCursor.get(key)) || 0)) {
			this.topicCursor.set(key, n);
		}
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

	renderForumPost({ nickname, rank, content, link, attachments }) {
		return forumPostMarkdown({ nickname, rank, content, link, attachments });
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
