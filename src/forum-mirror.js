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

const { MARKER, mdEscape, webhookSafe, htmlToPlainText, forumPostMarkdown, setForumUrl, absolutiseImages } = require('./text');
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

/**
 * Collect every sticker on a Discord message into one list.
 *
 * Two shapes exist and both are live depending on the gateway version and
 * whether the sticker is a guild upload or a built-in:
 *   - `message.sticker_items`: an array of `{ id, name, format_type }`. This is
 *     the modern shape; the id here is the STICKER id (not an "item" id), which
 *     is what the CDN path is keyed on.
 *   - `message.sticker`: a single object, older payloads.
 *
 * Normalising here means the mirror only deals with one list shape, and a
 * message carrying both is not processed twice.
 *
 * @param {object} message discord.js Message
 * @returns {Array<{id: string, name: string, format: number}>}
 */
function normaliseStickerItems(message) {
	const out = [];
	const push = (st) => {
		if (!st || !st.id) {
			return;
		}
		// Guard against the same sticker arriving in more than one shape.
		if (out.some((existing) => existing.id === String(st.id))) {
			return;
		}
		// discord.js renames `format_type` to `format` when it builds a Sticker
		// instance, so read every spelling that exists rather than one.
		const format = Number(st.format ?? st.format_type ?? st.formatType) || 1;
		out.push({
			id: String(st.id),
			name: st.name ? String(st.name) : 'sticker',
			format,
		});
	};
	// THE shape discord.js actually delivers. It does NOT expose
	// `message.sticker_items`: Message._patch() assigns
	// `this.stickers = new Collection(...)` keyed by sticker id. Reading
	// `sticker_items` therefore always yielded undefined, every real sticker hit
	// the `if (!items.length) return []` early exit, and the post went out with
	// no image and no error. A Collection is iterable, so `.values()` works for
	// both a Collection and a plain array.
	const fromCollection = message.stickers;
	if (fromCollection) {
		if (typeof fromCollection.values === 'function' && typeof fromCollection.size === 'number') {
			fromCollection.values().forEach(push);
		} else if (Array.isArray(fromCollection)) {
			fromCollection.forEach(push);
		}
	}
	// The RAW REST shape (`{sticker_items:[{id,name,format_type}]}`), which is
	// what a direct API call or a probe hands over. Kept so both paths work.
	if (Array.isArray(message.sticker_items)) {
		message.sticker_items.forEach(push);
	}
	// Legacy single-sticker shape.
	push(message.sticker);
	return out;
}

/**
 * A filename that keeps the sticker recognisable AND carries an extension the
 * forum will treat as an image.
 *
 * Lottie stickers are JSON (`format_type` 3) and resolve to a PNG preview, so
 * the extension comes from what was actually downloaded, never from the format
 * enum. Names are slugged because a raw emoji or a CJK sticker name would make
 * an awkward upload filename.
 */
function stickerFilename(item, extension) {
	const ext = String(extension || 'png').replace(/^\./, '').toLowerCase();
	const slug = String(item.name || 'sticker')
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 40) || 'sticker';
	return `${slug}-${item.id}.${ext}`;
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

		// threadId -> Promise, for adoptDiscordThread(). Two messages can land in
		// the same tick (a fast typist, or two people posting at once); without a
		// single-flight guard each creates its OWN topic and they then fight over
		// `threadToTopic`, orphaning the first on the forum.
		this.adopting = new Map();
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

		// The cursors MUST come back too. Restoring only the thread map left
		// `topicCursor` empty, so after every restart pollOnce() treated the
		// WHOLE topic as new and re-mirrored its entire history into Discord -
		// observed live as the same pid (50, 52) mirrored twice per poll, roughly
		// 6 duplicate Discord messages a minute, while the on-disk cursor said 557.
		// It also explains the "forum is slow" reports: a flood of writes against
		// an already CPU-saturated box.
		//
		// `Number(...)` because JSON has no reason to keep them numeric, and a
		// string cursor compares wrong against the numeric pid it is checked with.
		const cursors = (state && state.topicCursors) || {};
		Object.entries(cursors).forEach(([tid, pid]) => {
			const n = Number(pid);
			if (Number.isFinite(n) && n > 0) {
				this.topicCursor.set(String(tid), n);
			}
		});
		if (this.topicCursor.size) {
			this.log.info('topic cursors restored', { count: this.topicCursor.size });
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

	/* ──────────────── discord inbound: new thread -> topic ────────────── */

	/**
	 * Make a Discord thread the mirror of a real forum topic.
	 *
	 * WHY this exists. `ensureThread` only goes forum -> Discord: it takes a
	 * topic and creates/adopts a thread for it. The reverse was missing, so a
	 * thread a USER created in the forum channel had no `threadToTopic` entry,
	 * `main.js` skipped the message entirely, and the discussion simply did not
	 * exist on the forum. Replies inside already-mapped threads and
	 * forum -> Discord kept working, which is why the symptom read as "only one
	 * direction is broken" rather than "new topics are dropped".
	 *
	 * Ordering matters and is not interchangeable:
	 *  1. reuse an existing mapping - a mapped thread is a REPLY, never a new
	 *     topic, or every reply would fork a fresh topic;
	 *  2. single-flight per thread, so concurrent messages share one create;
	 *  3. map the thread BEFORE persisting, and roll the mapping back if the
	 *     create fails - a phantom `tid` would 404 every later reply.
	 *
	 * Discord will not accept a REST message into a thread that does not exist,
	 * which is why the direction has to be "create topic, then map", never
	 * "post, then create".
	 *
	 * @param {string} threadId
	 * @param {string} title    Discord thread name; the `[t:N]` prefix, if any, is stripped
	 * @param {object} opts
	 * @param {object} opts.author  discord.js user shape ({ id, username })
	 * @returns {Promise<{tid: string, created: boolean}>}
	 */
	async adoptDiscordThread(threadId, title, { author } = {}) {
		const key = String(threadId);
		if (!key || this.cid === null) {
			return null;
		}

		// 1. Already mapped? Then this thread is a reply target, not a new topic.
		const known = this.threadToTopic.get(key);
		if (known) {
			return { tid: known, created: false };
		}

		// 2. Single-flight: a second concurrent caller joins the first create
		//    instead of racing it into a duplicate topic.
		const inflight = this.adopting.get(key);
		if (inflight) {
			return inflight;
		}

		const task = (async () => {
			// Re-check inside the guard: the first caller may have mapped it while
			// this one was waiting to be scheduled.
			const raced = this.threadToTopic.get(key);
			if (raced) {
				return { tid: raced, created: false };
			}

			const member = author && author.id ? await this.discord.fetchMember(author.id).catch(() => null) : null;
			const nickname = (member && (member.displayName || member.user.username))
				|| (author && (author.displayName || author.username))
				|| 'Discord user';
			const forumUid = await this.discordForumUid(member, nickname);
			const cleanTitle = this.topicTitleFromThread(title);

			let created;
			try {
				created = await this.nodebb.createTopic({
					cid: this.cid,
					title: cleanTitle,
					content: this.renderDiscordThreadStarter(nickname, forumUid),
					asUid: forumUid || undefined,
				});
			} catch (err) {
				this.log.warn('discord thread -> forum topic failed', {
					thread: key, title: cleanTitle, error: err.message,
				});
				throw err;
			}

			const tid = created && created.tid;
			if (!tid) {
				throw new Error('createTopic returned no tid');
			}

			this.topicToThread.set(String(tid), key);
			this.threadToTopic.set(key, String(tid));
			// The first post of a new topic is already in the forum, so the cursor
			// starts AT it - otherwise the next poll would mirror the starter back
			// into the Discord thread as if it were a fresh forum post.
			if (created.mainPid) {
				this.topicCursor.set(String(tid), Number(created.mainPid) || 0);
				this.seenForum.add(Number(created.mainPid) || 0);
			}
			await this.persistState().catch((err) => {
				this.log.warn('could not persist state after adopting thread', {
					tid: String(tid), err: err.message,
				});
			});

			this.log.info('discord thread -> forum topic', {
				thread: key, tid, as: forumUid || 'bridge', title: cleanTitle,
			});
			return { tid: String(tid), created: true };
		})();

		this.adopting.set(key, task);
		try {
			return await task;
		} finally {
			this.adopting.delete(key);
		}
	}

	/**
	 * Turn a Discord thread name into a forum topic title.
	 *
	 * Strips the `[t:N]` stamp `threadNameFor` writes, otherwise a re-adopted
	 * thread would create a topic literally titled "[t:42] ...".
	 */
	topicTitleFromThread(name) {
		const raw = String(name || '').replace(/\[t:\d+\]/g, '').replace(/\s+/g, ' ').trim();
		return (raw || 'Diskusi dari Discord').slice(0, 200);
	}

	/**
	 * Body of the first post of a topic created from a Discord thread.
	 *
	 * Deliberately a stub rather than the thread's starter message: that message
	 * already lives in the Discord thread, and re-posting it here would echo the
	 * opening line twice. The link makes the two sides navigable from either end.
	 */
	renderDiscordThreadStarter(nickname, forumUid) {
		const lines = [
			`**${mdEscape(nickname)}** memulai diskusi ini dari Discord.`,
		];
		if (forumUid) {
			lines.push('', `_via Discord - diposting sebagai akun forum_`);
		}
		lines.push('', MARKER);
		return lines.join('\n');
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
		// Stickers are NOT attachments - `message.attachments` is empty and the
		// sticker lives in `sticker_items`. They are resolved separately so both
		// kinds end up in the same rendered list.
		const stickers = await this.mirrorStickers(message, forumUid);
		const res = await this.nodebb.replyToTopic(tid, {
			content: this.renderForumPost({
				nickname, content: message.content, link: message.url,
				attachments: attachments.concat(stickers),
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
	 * Resolve, download and re-upload every STICKER on a Discord message.
	 *
	 * A sticker is NOT an attachment. `message.attachments` stays empty and the
	 * sticker arrives in `message.sticker_items` (modern) or `message.sticker`
	 * (legacy single-sticker shape), so a mirror that only walks attachments
	 * drops every sticker silently - the reply still posts, with no trace of it.
	 *
	 * The URL is rebuilt from the sticker id on the Discord CDN rather than read
	 * off the message, because the CDN path is what stays stable while the
	 * rendered `sticker.url` getter needs the format enum.
	 *
	 * LOTTIE (`format_type: 3`) is a JSON animation vector, not a raster image:
	 * an `<img>` of it renders as a broken thumb. The node-side preview PNG is
	 * requested instead, so the sticker is still VISIBLE on the forum even though
	 * it does not animate there. Silently dropping it would be worse.
	 *
	 * Failure policy matches attachments: one unreachable sticker is logged and
	 * skipped, and the message text is never lost because of it.
	 *
	 * @returns {Promise<Array<{url: string, name: string}>>} forum-side copies
	 */
	async mirrorStickers(message, forumUid) {
		const items = normaliseStickerItems(message);
		if (!items.length) {
			return [];
		}
		const out = [];
		for (const item of items) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const resolved = await this.discord.stickerItemUrl(item);
				if (!resolved || !resolved.url) {
					this.log.warn('sticker has no resolvable url, skipped', {
						discord: message.id, sticker: item.id,
					});
					continue;
				}
				// eslint-disable-next-line no-await-in-loop
				const buf = await this.nodebb.downloadBinary(resolved.url);
				// A .json extension would make NodeBB treat a Lottie sticker as a
				// FILE, so the preview download always lands as a raster image.
				const filename = stickerFilename(item, resolved.extension);
				// eslint-disable-next-line no-await-in-loop
				const uploaded = await this.nodebb.uploadAttachment(
					buf, filename,
					{ asUid: forumUid || undefined, contentType: resolved.contentType }
				);
				out.push({ url: uploaded.url, name: uploaded.name || filename, isImage: true });
				this.log.debug('sticker mirrored', {
					discord: message.id, sticker: item.id, format: resolved.extension,
				});
			} catch (err) {
				this.log.warn('sticker upload failed', {
					discord: message.id, sticker: item.id, err: err.message,
				});
			}
		}
		return out;
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
		// `absolutiseImages` runs on the ALREADY-CONVERTED text so it catches both
		// a composer upload (which came through as an <img> we turned into
		// markdown) and a post whose body was already markdown. Doing it inside
		// htmlToPlainText would only fix the first shape.
		return [
			`**${mdEscape(name)}** \`${mdEscape(rank)}\``,
			'',
			absolutiseImages(htmlToPlainText(html)),
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

module.exports = { ForumMirror, normaliseStickerItems, stickerFilename };
