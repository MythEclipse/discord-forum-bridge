'use strict';

/**
 * Offline tests for forum-mode mirroring.
 *
 * Everything runs against stubs, so no Discord connection and no forum writes.
 * The properties checked here are the ones that broke in production earlier:
 * thread/topic mapping persistence, marker-based echo suppression in both
 * directions, ladder input shape, and text conversion.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ForumMirror, normaliseStickerItems } = require('../src/forum-mirror');
const { IdentityStore } = require('../src/identity');
const { htmlToPlainText, htmlEscape, mdEscape, webhookSafe, forumPostMarkdown, MARKER, chunkMessage } = (() => {
	const t = require('../src/text');
	const d = require('../src/discord-transport');
	return { ...t, chunkMessage: d.chunkMessage };
})();

/* A regression test, not a style preference: mdLiteral() escaped `.` and `-`,
 * markdown-it kept that backslash inside the image alt attribute, and the
 * rendered markup came out as alt="hontoni1460995774103158949png" - the dots
 * disappeared, so a reader (and screen readers) got a meaningless filename.
 * The image itself rendered, which is exactly why this hid for so long. */
void (async function testImageAltKeepsFilenameVerbatim() {
	const body = forumPostMarkdown({
		nickname: 'za',
		content: '',
		attachments: [{ name: 'hontoni-1460995774103158949.png', url: 'https://forum.imrnes.team/assets/uploads/files/x.png' }],
	});
	assert(/^!\[hontoni-1460995774103158949\.png\]\(/m.test(body),
		'filename with dots and dashes must survive verbatim in the alt text');
	assert(!body.includes('\\-') && !body.includes('\\.'),
		'alt text must not carry markdown backslash escapes');
})();

// Must resolve to the SAME path src/state.js uses. The suite overrides it with
// BRIDGE_DATA_DIR (a temp dir, set by `npm run check:forum`) so a failing test
// can never leave its fixtures in the live bridge state.
const STATE_PATH = require('../src/state').STATE_PATH;
const savedState = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, 'utf8') : null;

function resetState() {
	try {
		fs.unlinkSync(STATE_PATH);
	} catch (e) { /* absent */ }
}

function restoreState() {
	resetState();
	if (savedState !== null) {
		fs.writeFileSync(STATE_PATH, savedState);
	}
}

function makeMirror(overrides = {}) {
	const calls = { threads: [], sent: [], replies: [], topics: [], uploads: [], downloads: [] };

	const topics = overrides.topics || [
		{ tid: 1, title: 'Welcome Shounen', uid: 1, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'aryma' } },
		{ tid: 2, title: 'Rules', uid: 2, timestamp: 1700000200, lastposttime: 1700000200, user: { username: 'cyrene' } },
	];

	const nodebb = {
		probe: async () => ({ authMode: 'master', actorUid: 2 }),
		getCategoryBySlug: async () => ({ categories: [{ cid: 2, name: 'General Discussion', slug: '2/general-discussion' }] }),

		// Same shape the real client returns: the v3 `{status, response}` envelope
		// is unwrapped, so callers see `{ topics: [...] }`. Pagination is honoured
		// so the backfill page loop terminates like the real endpoint.
		listCategoryTopics: async (_cid, { from = 0, to = 50 } = {}) => ({ topics: topics.slice(from, to) }),
		getTopicPosts: async (tid) => ({ posts: overrides.postsByTopic?.[tid] || [] }),
		getUser: async (uid) => overrides.users?.[uid] || { uid, username: `user${uid}`, postcount: 0 },
		// Resolves only names the test declares, so "unlinked member" is a real
		// negative case rather than an accidental uid-1 hit.
		getUserByUsername: async (u) => {
			const hit = overrides.forumUsersByName?.[u.toLowerCase()];
			if (!hit) {
				throw new Error(`no such forum user: ${u}`);
			}
			return hit;
		},
		getRankLadder: async () => ({ levels: [{ min: 0, name: '[Neophyte]' }, { min: 3, name: '[Apprentice]' }] }),
		replyToTopic: async (tid, { content, asUid }) => {
			calls.replies.push({ tid, content, asUid });
			return { pid: 900 + calls.replies.length };
		},
		// Creating a forum topic from a NEW Discord thread. `asUid` mirrors the
		// reply path so the topic is owned by the linked human, which is what
		// makes the ranks plugin badge the author correctly.
		createTopic: async ({ cid, title, content, asUid }) => {
			calls.topics.push({ cid, title, content, asUid });
			return { tid: 500 + calls.topics.length, title, content };
		},
		downloadBinary: async (url) => {
			calls.downloads.push(url);
			return Buffer.from('PNGDATA');
		},
		uploadAttachment: async (buffer, filename, { asUid, contentType } = {}) => {
			calls.uploads.push({
				filename, asUid, contentType, bytes: buffer && buffer.toString(),
			});
			return {
				url: `https://forum.imrnes.team/assets/uploads/files/1-${filename}`,
				name: filename,
			};
		},
	};

	const discord = {
		fetchChannel: async () => ({
			id: 'C1', name: 'forum-imrnes-relay', type: 15,
			isForum: () => true, isTextBased: () => true,
		}),
		createThread: async (parentId, { name, message }) => {
			const id = `TH${calls.threads.length + 1}`;
			calls.threads.push({ parentId, name, message, id });
			return { id, name };
		},
		// Reports whatever `existingThreads` the test declares, so the re-adopt
		// path can be exercised without a real Discord client.
		listThreads: async () => ({ threads: overrides.existingThreads || [], hasMore: false }),
		threadExists: async (id) => !(overrides.deadThreadId && id === overrides.deadThreadId),
		sendToThread: async (threadId, payload) => {
			// `deadThreadId` simulates a thread deleted in Discord: writes to it
			// fail with Discord's real 10003, anything else succeeds.
			if (overrides.deadThreadId && threadId === overrides.deadThreadId) {
				throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
			}
			if (overrides.sendError) {
				throw overrides.sendError;
			}
			calls.sent.push({ threadId, ...payload });
		},
		fetchMember: async (id) => (overrides.members?.[id] || { id, displayName: 'tester', user: { username: 'tester' } }),
		// Sticker CDN lookup. `stickerItems` is what discord.js attaches to a
		// message; each item has `id` (the item, not the sticker) and the mirror
		// resolves the real sticker url from it.
		stickerItemUrl: async (item) => (overrides.stickerUrls?.[item.id]
			?? (overrides.defaultStickerUrl ? { url: overrides.defaultStickerUrl, extension: 'png', contentType: 'image/png' } : null)),
	};

	const config = {
		discord: { channelId: 'C1', guildId: 'G1' },
		nodebb: { url: 'https://forum.imrnes.team', bridgeUid: '12' },
		forum: { categorySlug: 'general-discussion', backfill: '1' },
		behaviour: { marker: '<!-- imrnes-bridge -->', syncIntervalMs: 20000, raceSyncIntervalMs: 300000 },
	};

	const identity = new IdentityStore();
	identity.setLadder(overrides.ladder || [{ min: 0, name: '[Neophyte]' }, { min: 3, name: '[Apprentice]' }]);
	// Seed the identity store in memory only. setLink() would rewrite
	// data/links.json, so the store's map is populated directly to keep the test
	// hermetic.
	(overrides.links || []).forEach((link) => identity.byDiscordId.set(String(link.discordId), link));

	const logs = [];
	const log = {
		info: (m, f) => logs.push(['info', m, f]),
		warn: (m, f) => logs.push(['warn', m, f]),
		error: (m, f) => logs.push(['error', m, f]),
		debug: () => {},
	};

	const mirror = new ForumMirror({ nodebb, discord, config, identity, log });
	return { mirror, calls, logs, config, nodebb, discord };
}

(async () => {
	/* ── text conversion ─────────────────────────────────────────────── */
	assert.strictEqual(
		htmlToPlainText('<p dir="auto">&lt;p&gt;hi&lt;/p&gt;&lt;!-- imrnes-bridge --&gt;</p>'),
		'hi',
		'escaped body unwraps and the marker never leaks',
	);
	assert.ok(!htmlToPlainText('<p>secret</p><!-- imrnes-bridge -->').includes('imrnes-bridge'), 'marker stripped');
	assert.strictEqual(htmlToPlainText('<p>hi <strong>b</strong> <a href="https://x/y">l</a></p>'), 'hi **b** [l](https://x/y)', 'inline formatting');
	assert.strictEqual(htmlToPlainText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two', 'list');
	assert.strictEqual(htmlToPlainText('<blockquote>quoted</blockquote>'), '> quoted', 'blockquote');
	console.log('ok - html/markdown conversion, marker never leaks into text');

	/* ── Discord -> forum body must be MARKDOWN, not HTML ───────────────
	 * Regression guard. The forum runs nodebb-plugin-markdown with
	 * `html: false`, so anything sent as HTML is escaped by markdown-it and
	 * re-wrapped in `<p dir="auto">`, which rendered the bridge's blockquote
	 * and "Lihat di Discord" link as literal tag text on the topic page.
	 * These assertions fail if anyone reintroduces HTML bodies.
	 */
	const md = forumPostMarkdown({
		nickname: 'Za', rank: '[Apprentice]', content: 'halo dari discord',
		link: 'https://discord.com/channels/1/2/3',
	});
	assert.ok(!md.includes('&lt;'), 'forum body must not contain HTML entities');
	assert.ok(!/<[a-z/][^>]*>/i.test(md.replace(MARKER, '')), `no real HTML tags: ${md}`);
	assert.ok(!md.includes('imrnes-rank'), 'no duplicate badge markup; the theme injects it');
	assert.ok(md.includes('**Za**'), 'nickname is bold markdown');
	assert.ok(md.includes('`[Apprentice]`'), 'rank is inline code, brackets not escaped');
	assert.ok(md.includes('> halo dari discord'), 'message is quoted');
	assert.ok(md.includes('[Lihat di Discord](https://discord.com/channels/1/2/3)'), 'discord link is a markdown link');
	assert.ok(md.includes('<!-- imrnes-bridge -->'), 'echo marker present');
	// Discord markdown in the message must not become live formatting.
	const tricky = forumPostMarkdown({
		nickname: 'Arima', rank: '[Neophyte]', content: '**bold** <script>x</script>',
		link: 'https://x/y',
	});
	assert.ok(tricky.includes('\\*\\*bold\\*\\*'), 'discord bold stays literal');
	assert.ok(!tricky.includes('<script>'), 'no raw script tag can reach the post body');
	// Rank containing markdown metacharacters must not leak formatting.
	const nasty = forumPostMarkdown({ nickname: 'a*_b', rank: '[x]`y`', content: '', link: '' });
	assert.ok(nasty.includes('a\\*\\_b'), 'nickname metacharacters escaped');
	assert.ok(nasty.includes('`[x]\\`y\\``'), 'only ` and \\ escaped inside the rank code span');
	console.log('ok - forum body is markdown-safe (html regression guarded)');

	assert.strictEqual(htmlEscape('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;', 'html escape');
	assert.strictEqual(mdEscape('a*b_c~d|e'), 'a\\*b\\_c\\~d\\|e', 'markdown escape');
	assert.strictEqual(webhookSafe('Za@Corp!'), 'ZaCorp', 'webhook name sanitised');
	assert.deepStrictEqual(chunkMessage('short', 1900), ['short'], 'no split when short');
	const long = 'x'.repeat(4500);
	const chunks = chunkMessage(long, 1900);
	assert.ok(chunks.length >= 3, 'long message split');
	assert.ok(chunks.every((c) => c.length <= 1900), 'every chunk within the limit');
	assert.strictEqual(chunks.join('').length, 4500, 'no characters lost in the split');
	console.log('ok - escaping, webhook names, message chunking');

	/* ── startup + backfill ──────────────────────────────────────────── */
	resetState();
	const first = makeMirror();
	await first.mirror.start();
	assert.strictEqual(first.mirror.cid, 2, 'category resolved');
	assert.strictEqual(first.mirror.mode, 'forum', 'forum channel mode detected');
	const backfill = await first.mirror.backfill();
	assert.strictEqual(backfill.total, 2, 'both topics seen');
	assert.strictEqual(backfill.created, 2, 'a thread per topic');
	assert.ok(first.calls.threads.every((t) => /^\[t:\d+\]/.test(t.name)), 'thread name carries the tid');
	assert.ok(first.calls.threads.every((t) => t.message.includes('imrnes-bridge')), 'thread intro carries the marker');
	assert.strictEqual(first.mirror.topicToThread.size, 2, 'mapping recorded');
	assert.ok(fs.existsSync(STATE_PATH), 'state persisted');
	console.log('ok - backfill creates one thread per topic, tagged with tid');

	/* ── restart must NOT create duplicate threads ───────────────────── */
	const second = makeMirror();
	await second.mirror.start();
	const again = await second.mirror.backfill();
	assert.strictEqual(again.created, 0, 'restart created no new threads');
	assert.strictEqual(second.calls.threads.length, 0, 'no createThread calls at all');
	console.log('ok - restart reuses the persisted tid->thread map');

	/* ── lost state is recovered from the thread NAME ───────────────── */
	// Regression: a lost state.json used to make backfill() create a SECOND thread
	// for the same topic. Users kept typing in the old one (identical name) and
	// the bridge ignored them, so Discord -> forum silently stopped working.
	resetState();
	const readopted = makeMirror({
		existingThreads: [
			{ id: 'OLD_T1', name: '[t:1] Selamat Datang Shounen - Welcome Shounen' },
			{ id: 'OLD_T2', name: '[t:2] Rules' },
		],
	});
	await readopted.mirror.start();
	await readopted.mirror.backfill();
	assert.strictEqual(readopted.calls.threads.length, 0, 'no duplicate thread is created');
	assert.strictEqual(readopted.mirror.topicToThread.get('1'), 'OLD_T1', 'topic 1 re-adopts the existing thread');
	assert.strictEqual(readopted.mirror.threadToTopic.get('OLD_T1'), '1', 'the reverse map points back, so replies route');
	assert.strictEqual(readopted.mirror.threadToTopic.get('OLD_T2'), '2', 'topic 2 re-adopted too');
	console.log('ok - lost state re-adopts threads by their [t:N] name instead of duplicating');

	// and a genuinely unknown topic must still get a new thread
	resetState();
	const mixed = makeMirror({
		existingThreads: [{ id: 'OLD_T1', name: '[t:1] Selamat Datang Shounen - Welcome Shounen' }],
	});
	await mixed.mirror.start();
	await mixed.mirror.backfill();
	assert.strictEqual(mixed.calls.threads.length, 1, 'only the unmapped topic gets a new thread');
	assert.strictEqual(mixed.mirror.topicToThread.get('1'), 'OLD_T1', 'topic 1 still re-adopted');
	console.log('ok - a topic with no existing thread still creates one');

	/* ── forum -> discord ────────────────────────────────────────────── */
	resetState();
	const up = makeMirror({
		topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
		users: { 3: { uid: 3, username: 'potatochips', postcount: 25, picture: '/uploads/a.png' } },
		postsByTopic: { 7: [
			{ pid: 11, uid: 3, content: '<p>halo semua</p>' },
			{ pid: 12, uid: 3, content: '<p>ini punya marker</p><!-- imrnes-bridge -->' },
		] },
	});
	await up.mirror.start();
	const mirrored = await up.mirror.pollOnce();
	assert.strictEqual(mirrored, 1, 'only the unmarked post is mirrored');
	assert.strictEqual(up.calls.sent.length, 1, 'exactly one Discord message');
	const msg = up.calls.sent[0];
	assert.ok(msg.content.includes('potatochips'), 'author name present');
	assert.ok(msg.content.includes('[Apprentice]'), 'rank from post count 25 -> Apprentice');
	assert.ok(msg.content.includes('halo semua'), 'body converted');
	assert.ok(msg.content.includes('/post/11'), 'links back to the forum');
	assert.ok(msg.content.includes('imrnes-bridge'), 'marker added to the outbound message');
	assert.strictEqual(msg.webhookName, 'potatochips', 'webhook carries the author name');
	assert.strictEqual(msg.webhookAvatar, 'https://forum.imrnes.team/uploads/a.png', 'webhook carries the avatar');
	assert.ok(!msg.content.includes('&lt;'), 'no double-escaped html leaking through');
	console.log('ok - forum -> discord: rank, author, avatar, link, marker, no escaping artefacts');

	// second poll must be a no-op
	const againPoll = await up.mirror.pollOnce();
	assert.strictEqual(againPoll, 0, 'already-mirrored post is not re-sent');
	assert.strictEqual(up.calls.sent.length, 1, 'still exactly one message');
	console.log('ok - polling is idempotent');

	/* ── discord -> forum ────────────────────────────────────────────── */
	const down = makeMirror({
		topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
		members: { U1: { id: 'U1', displayName: 'tester', user: { username: 'tester' } } },
		links: [{ discordId: 'U1', username: 'tester' }],
		forumUsersByName: { tester: { uid: 42, username: 'tester', postcount: 25 } },
	});
	await down.mirror.start();
	await down.mirror.backfill();
	const post = await down.mirror.onDiscordMessage({
		id: 'DM1', channelId: 'TH1', content: 'halo dari discord',
		url: 'https://discord.com/channels/G/C/DM1',
		author: { id: 'U1', bot: false, username: 'tester' },
		member: null,
	});
	assert.ok(post, 'a post was created');
	assert.strictEqual(down.calls.replies.length, 1, 'exactly one forum reply');
	assert.strictEqual(down.calls.replies[0].tid, '7', 'posted to the mapped topic');
	assert.ok(down.calls.replies[0].content.includes('halo dari discord'), 'content forwarded');
	assert.ok(down.calls.replies[0].content.includes('imrnes-bridge'), 'marker embedded in the forum post');
	// Discord -> forum must NOT carry a rank in the body. The forum draws its
	// own styled badge next to the username, and a body rank would be an
	// unstyled duplicate attributed to the posting account.
	assert.ok(!down.calls.replies[0].content.includes('[Apprentice]'), 'no rank in the Discord->forum body');
	assert.ok(!down.calls.replies[0].content.includes('[Neophyte]'), 'no rank in the Discord->forum body');
	assert.ok(!/<[a-z/][^>]*>/i.test(down.calls.replies[0].content.replace(MARKER, '')), 'no raw HTML in the forum body');
	console.log('ok - discord -> forum: routed to the right topic, marker embedded, no rank in body');

	/* ── author attribution: post as the HUMAN, not the bridge ────────────
	 * The whole point of dropping the body rank is that the forum then awards
	 * the right badge, which requires the post to be authored by the human's
	 * own forum account. Without a link the bridge must still post as itself.
	 */
	assert.strictEqual(down.calls.replies[0].asUid, 42, 'impersonates the linked forum uid, not the bridge');
	console.log('ok - discord -> forum: posted as the linked human account');

	const unlinked = makeMirror({
		topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
		members: {}, // nobody linked
	});
	await unlinked.mirror.start();
	await unlinked.mirror.backfill();
	await unlinked.mirror.onDiscordMessage({
		id: 'DM9', channelId: 'TH1', content: 'tanpa link',
		url: 'https://discord.com/channels/G/C/DM9',
		author: { id: 'U9', bot: false, username: 'stranger' },
		member: null,
	});
	assert.strictEqual(unlinked.calls.replies[0].asUid, undefined, 'unlinked member posts as the bridge');
	console.log('ok - discord -> forum: unlinked member falls back to the bridge account');

	// bot messages and duplicates are ignored
	const none = await down.mirror.onDiscordMessage({
		id: 'DM2', channelId: 'TH1', content: 'x', author: { id: 'U1', bot: true, username: 'bot' },
	});
	assert.strictEqual(none, null, 'bot author ignored');
	const dup = await down.mirror.onDiscordMessage({
		id: 'DM1', channelId: 'TH1', content: 'halo dari discord', author: { id: 'U1', bot: false, username: 'tester' },
	});
	assert.strictEqual(dup, null, 'duplicate message id ignored');
	assert.strictEqual(down.calls.replies.length, 1, 'still exactly one reply after the two skips');
	console.log('ok - discord -> forum: bot authors and duplicate ids skipped');


	/* ── attachments: discord -> forum ──────────────────────────────── */
	{
		const withFiles = await down.mirror.onDiscordMessage({
			id: 'DM_ATT', channelId: 'TH1', content: 'foto nih',
			author: { id: 'U1', bot: false, username: 'tester' },
			attachments: [
				{ url: 'https://cdn.discordapp.com/a/px.png', name: 'px.png', type: 'image/png' },
				{ url: 'https://cdn.discordapp.com/a/clip.mp4', name: 'clip.mp4', type: 'video/mp4' },
			],
		});
		assert.ok(withFiles, 'a message with attachments still creates a post');
		assert.strictEqual(down.calls.downloads.length, 2, 'both attachments are fetched');
		assert.strictEqual(down.calls.uploads.length, 2, 'both are re-uploaded to the forum');
		assert.strictEqual(down.calls.uploads[0].filename, 'px.png', 'original name preserved');
		assert.strictEqual(down.calls.uploads[0].asUid, 42, 'upload is attributed to the linked human');
		assert.strictEqual(down.calls.uploads[0].contentType, 'image/png', 'mime type forwarded');
		assert.strictEqual(down.calls.uploads[0].bytes, 'PNGDATA', 'bytes forwarded verbatim');
		const body = down.calls.replies[down.calls.replies.length - 1].content;
		// NOTE: the alt text goes through mdLiteral, which backslash-escapes `.`
		// and friends so a hostile file name cannot break out of the label. The URL
		// is NOT escaped - only `( )` are percent-encoded - so assert on the URL.
		assert.ok(
			/!\[[^\]]*px\\?\.png[^\]]*\]\(https:\/\/forum\.imrnes\.team\/assets\/uploads\/files\/1-px\.png\)/.test(body),
			`images render inline as markdown, got:\n${body}`
		);
		// A video must NOT be a markdown image (that renders a broken thumb) and
		// must NOT be a bare link either: it gets a real <video controls> player.
		// This changed on 2026-10-17 - the old assertion demanded a plain link,
		// which was the behaviour that made mirrored videos unusable.
		assert.ok(
			/<video controls[^>]*src="https:\/\/forum\.imrnes\.team\/assets\/uploads\/files\/1-clip\.mp4"/.test(body),
			`video renders as an HTML5 player, got:\n${body}`
		);
		assert.ok(!body.includes('![clip.mp4]'), 'a video is never emitted as a markdown image');
		// the Discord CDN url must never leak into the forum post
		assert.ok(!body.includes('cdn.discordapp.com'), 'no Discord CDN url in the forum body');
		console.log('ok - attachments: downloaded, uploaded as the human, referenced by forum url');
	}

	/* ── a failing attachment must not lose the message text ───────── */
	{
		down.mirror.nodebb.uploadAttachment = async () => {
			throw new Error('boom');
		};
		const still = await down.mirror.onDiscordMessage({
			id: 'DM_ATT_FAIL', channelId: 'TH1', content: 'teks tetap harus masuk',
			author: { id: 'U1', bot: false, username: 'tester' },
			attachments: [{ url: 'https://cdn.discordapp.com/a/bad.png', name: 'bad.png', type: 'image/png' }],
		});
		assert.ok(still, 'the reply is still created when the upload fails');
		const body = down.calls.replies[down.calls.replies.length - 1].content;
		assert.ok(body.includes('teks tetap harus masuk'), 'text survives an upload failure');
		assert.ok(!body.includes('bad.png'), 'a failed upload leaves no broken reference');
		console.log('ok - a failed attachment upload does not drop the message');
	}

	/* ── unmapped thread ─────────────────────────────────────────────── */
	const repliesBefore = down.calls.replies.length;
	const orphan = await down.mirror.onDiscordMessage({
		id: 'DM3', channelId: 'TH_UNKNOWN', content: 'hello?', author: { id: 'U1', bot: false, username: 'tester' },
	});
	assert.strictEqual(orphan, null, 'a thread with no tid mapping is ignored');
	assert.strictEqual(down.calls.replies.length, repliesBefore, 'nothing posted for an unmapped thread');
	console.log('ok - unmapped thread does not leak into the forum');


	/* ── a deleted Discord thread must self-heal ────────────────────── */
	// Regression: the forum thread was deleted in Discord while state.json kept
	// its id. ensureThread() trusted the cache, every send got 404 Unknown
	// Channel, and forum -> Discord died silently while Discord -> Forum kept
	// working (it only needs the topic cursor).
	{
		resetState();
		const dead = makeMirror({
			topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
			users: { 3: { uid: 3, username: 'potatochips', postcount: 25 } },
			postsByTopic: { 7: [{ pid: 11, uid: 3, content: '<p>halo</p>' }] },
			// the cached thread is gone: the first send to it 404s
			deadThreadId: 'DEAD',
		});
		// Seed state.json with the DEAD thread so backfill() adopts it from the
		// cache instead of creating a fresh one - that is exactly the state a
		// real deletion leaves behind.
		fs.writeFileSync(STATE_PATH, JSON.stringify({
			threads: { 7: 'DEAD' },
			topicCursors: {},
			cid: 2,
		}));
		const warns = [];
		dead.mirror.log.warn = (...a) => warns.push(JSON.stringify(a[1] || a[0]));
		dead.mirror.log.info = () => {};
		await dead.mirror.start();
		const before = dead.calls.threads.length;
		assert.strictEqual(before, 0, 'nothing created yet: the cached id is trusted first');
		const ok = await dead.mirror.pollOnce();
		if (ok !== 1) { console.log('DEBUG warns:', warns.join('\n')); }
		assert.strictEqual(ok, 1, 'the post is delivered after the dead thread is replaced');
		assert.strictEqual(dead.calls.threads.length, before + 1, 'exactly one replacement thread is created');
		const fresh = dead.calls.threads[dead.calls.threads.length - 1];
		assert.ok(/^\[t:7\]/.test(fresh.name), 'the replacement carries the tid prefix');
		assert.strictEqual(dead.mirror.topicToThread.get('7'), fresh.id, 'state now points at the live thread');
		console.log('ok - a deleted discord thread is re-created instead of failing forever');
	}

	/* ── a PERMISSION error must NOT spawn a new thread per post ─────── */
	{
		resetState();
		const forbidden = makeMirror({
			topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
			users: { 3: { uid: 3, username: 'potatochips', postcount: 25 } },
			postsByTopic: { 7: [
				{ pid: 11, uid: 3, content: '<p>halo</p>' },
				{ pid: 12, uid: 3, content: '<p>dua</p>' },
			] },
			sendError: Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }),
		});
		await forbidden.mirror.start();
		await forbidden.mirror.backfill();
		const created = forbidden.calls.threads.length;
		await forbidden.mirror.pollOnce();
		await forbidden.mirror.pollOnce();
		assert.strictEqual(forbidden.calls.threads.length, created, 'a 403 never creates a new thread');
		console.log('ok - a permission error does not spawn threads');
	}


	/* ── a deleted post must not wedge the rest of the topic ────────── */
	// Regression: NodeBB returns soft-deleted posts as a literal
	// "[[topic:post-is-deleted]]" placeholder. The bridge tried to mirror it,
	// the send path treated it as undeliverable, the cursor stayed put - and
	// because pollOnce only looks at posts NEWER than the cursor, every
	// subsequent post in that topic became invisible forever. One deleted post
	// silently killed forum -> Discord for the whole topic.
	{
		resetState();
		const wedged = makeMirror({
			topics: [{ tid: 7, title: 'Diskusi IMRNES', uid: 3, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'potatochips' } }],
			users: { 3: { uid: 3, username: 'potatochips', postcount: 25 } },
			postsByTopic: { 7: [
				{ pid: 11, uid: 3, content: '<p>sebelum</p>' },
				{ pid: 12, uid: 3, content: '[[topic:post-is-deleted]]' },
				{ pid: 13, uid: 3, content: '<p>sesudah</p>' },
			] },
		});
		await wedged.mirror.start();
		await wedged.mirror.backfill();
		await wedged.mirror.pollOnce();
		const bodies = wedged.calls.sent.map((s) => s.content);
		assert.strictEqual(wedged.calls.sent.length, 2, 'both real posts are delivered');
		assert.ok(bodies.some((b) => b.includes('sebelum')), 'the post before the gap arrives');
		assert.ok(bodies.some((b) => b.includes('sesudah')), 'the post AFTER the deleted one also arrives');
		assert.ok(
			!bodies.some((b) => b.includes('post-is-deleted')),
			'the placeholder itself is never rendered'
		);
		console.log('ok - a deleted post does not strand the posts after it');
	}


	/* ── forum images must survive the Discord mirror ────────────────── */
	// Two real bugs, both silent:
	//  1. `<i[^>]*>` has no word boundary, so it consumed a whole
	//     `<img src="..." class="..." alt="..." />` and left a bare `*`.
	//  2. even a matching rule only emitted the bare URL, so the GIF arrived
	//     as unclickable text instead of an inline image.
	{
		const { htmlToPlainText, setForumUrl } = require('../src/text');
		// NodeBB stores image `src` relative; Discord needs it absolute.
		setForumUrl('https://forum.imrnes.team');
		// EXACTLY how NodeBB stores a composer upload: a site-RELATIVE src, with
		// `src` first and `class`/`alt` after it. Both halves of that used to break
		// the mirror - the relative url AND the attribute order.
		const nodebbImg = '<p dir="auto">uji gif: '
			+ '<img src="/assets/uploads/files/1-t.gif" '
			+ 'class="wp-image" alt="t.gif" /> halo</p>';
		const out = htmlToPlainText(nodebbImg);
		assert.ok(
			/!\[[^\]]*\]\(https:\/\/forum\.imrnes\.team\/assets\/uploads\/files\/1-t\.gif\)/.test(out),
			`a forum image becomes a markdown image, got:\n${out}`
		);
		assert.ok(!/\*/.test(out.replace(/![^\]]*\]/g, '')), 'no stray emphasis marker is left behind');
		assert.ok(out.includes('uji gif:'), 'the surrounding text survives');
		assert.ok(out.includes('halo'), 'the text after the image survives');

		// emphasis must still work - the word-boundary fix must not break <i>/<em>
		assert.strictEqual(
			htmlToPlainText('<p><em>italic</em> dan <b>bold</b></p>'),
			'*italic* dan **bold**',
			'emphasis still renders'
		);
		// and self-closing / unquoted-ish shapes must not throw
		// a relative src must be absolutised, an absolute one left alone
		assert.ok(
			/!\[[^\]]*\]\(https:\/\/cdn\.example\/x\.png\)/.test(
				htmlToPlainText('<p><img src="https://cdn.example/x.png" alt="abs"></p>')
			),
			'an already-absolute src is not double-prefixed'
		);

		// A post whose body is ALREADY markdown (written through the API, or
		// typed by a user) never becomes an <img>, so absolutising inside
		// htmlToPlainText cannot help it. `absolutiseImages` runs on the final
		// text for that case.
		const { absolutiseImages } = require('../src/text');
		assert.strictEqual(
			absolutiseImages('gif: ![mygif](/assets/uploads/files/1-final.gif)'),
			'gif: ![mygif](https://forum.imrnes.team/assets/uploads/files/1-final.gif)',
			'a markdown image with a relative destination is absolutised'
		);
		assert.strictEqual(
			absolutiseImages('![p](//cdn.example/x.png)'),
			'![p](//cdn.example/x.png)',
			'a protocol-relative destination is left alone'
		);
		assert.strictEqual(
			absolutiseImages('![y](https://cdn.example/b.png)'),
			'![y](https://cdn.example/b.png)',
			'an absolute destination is not double-prefixed'
		);
		assert.strictEqual(htmlToPlainText('<p><img alt="no src"></p>'), '', 'an img with no src is dropped');
		console.log('ok - forum images (incl. GIF) render inline in the Discord mirror');
	}


	/* ── a NEW Discord thread must create a forum topic ────────────────
	 * The gap this covers: `main.js` only forwarded a message when the thread
	 * already had a `threadToTopic` mapping. A brand-new thread posted directly
	 * in the Discord forum channel had no mapping, so it was silently dropped -
	 * the topic did not exist on the forum at all. Reply-in-existing-thread and
	 * forum->Discord kept working, which is why it looked like "only one
	 * direction is broken".
	 */
	{
		const { mirror, calls, logs } = makeMirror({
			topics: [],                       // empty forum: nothing mapped yet
			existingThreads: [{ id: 'TH_NEW', name: 'Diskusi baru dari Discord' }],
			members: { D9: { id: 'D9', displayName: 'za', user: { username: 'za' } } },
			links: [{ discordId: 'D9', username: 'za' }],
			forumUsersByName: { za: { uid: 4, username: 'za', postcount: 5 } },
		});
		// The thread the user just made in the forum channel. start() resolves
		// the category cid, which adoptDiscordThread() needs before it can post.
		await mirror.start();

		const made = await mirror.adoptDiscordThread('TH_NEW', 'Diskusi baru dari Discord', {
			author: { id: 'D9', username: 'za' },
		});
		assert.ok(made && made.tid, 'adopting a new thread yields a forum tid');
		assert.strictEqual(calls.topics.length, 1, 'exactly one topic created');
		assert.strictEqual(calls.topics[0].cid, 2, 'created in the bridged category');
		assert.ok(String(calls.topics[0].title).length > 0, 'topic has a title');
		assert.strictEqual(calls.topics[0].asUid, 4, 'topic owned by the linked human, not the bridge');
		assert.strictEqual(mirror.threadToTopic.get('TH_NEW'), String(made.tid), 'thread now maps back to the topic');
		assert.strictEqual(mirror.topicToThread.get(String(made.tid)), 'TH_NEW', 'and the reverse mapping exists too');
		console.log('ok - a new discord thread creates a forum topic and maps both ways');
	}

	/* ── adopting must be idempotent and thread-safe ───────────────────
	 * Two messages can arrive in the same tick (a fast typist, or two people
	 * posting at once). Without a single-flight guard each would create its own
	 * topic and the two would fight over `threadToTopic`, leaving the first
	 * orphaned on the forum.
	 */
	{
		const { mirror, calls } = makeMirror({ topics: [], existingThreads: [] });
		await mirror.start();
		const [a, b] = await Promise.all([
			mirror.adoptDiscordThread('TH_RACE', 'Balapan', { author: { id: 'D1', username: 'u' } }),
			mirror.adoptDiscordThread('TH_RACE', 'Balapan', { author: { id: 'D1', username: 'u' } }),
		]);
		assert.strictEqual(calls.topics.length, 1, `concurrent adoption creates one topic (got ${calls.topics.length})`);
		assert.strictEqual(String(a.tid), String(b.tid), 'both callers get the same tid');
		console.log('ok - concurrent adoption of one thread creates exactly one topic');
	}

	/* ── a mapped thread must NOT create a second topic ─────────────────
	 * The regression guard for the new code path: a reply in an already-mapped
	 * thread is a reply, not a new topic.
	 */
	{
		const { mirror, calls } = makeMirror({
			topics: [], existingThreads: [{ id: 'TH_1', name: '[t:1] Welcome' }],
		});
		await mirror.start();
		mirror.topicToThread.set('1', 'TH_1');
		mirror.threadToTopic.set('TH_1', '1');
		const res = await mirror.adoptDiscordThread('TH_1', '[t:1] Welcome', { author: { id: 'D1', username: 'u' } });
		assert.strictEqual(calls.topics.length, 0, 'an already-mapped thread creates no topic');
		assert.strictEqual(res && res.tid, '1', 'and resolves to the existing tid');
		console.log('ok - an already-mapped thread is reused, not duplicated');
	}

	/* ── a failed topic creation must not leave a phantom mapping ──────
	 * If NodeBB rejects the topic, `threadToTopic` must stay clean. Otherwise
	 * the thread is permanently "mapped" to a tid that does not exist and every
	 * later reply in it 404s.
	 */
	{
		const { mirror, calls, nodebb } = makeMirror({ topics: [], existingThreads: [] });
		await mirror.start();
		nodebb.createTopic = async () => { throw new Error('cid not allowed'); };
		await assert.rejects(
			() => mirror.adoptDiscordThread('TH_BAD', 'Gagal', { author: { id: 'D1', username: 'u' } }),
			/cid not allowed/,
			'adoptDiscordThread propagates the underlying failure'
		);
		assert.ok(!mirror.threadToTopic.has('TH_BAD'), 'no phantom mapping survives a failure');
		assert.strictEqual(calls.topics.length, 0, 'nothing recorded');
		console.log('ok - a failed topic creation leaves no phantom mapping');
	}

	/* ── stickers must render as images on the forum ───────────────────
	 * A Discord sticker is NOT an attachment: `message.attachments` stays empty
	 * and the sticker arrives in `message.sticker_items`. Mirroring only
	 * attachments therefore drops every sticker silently, and the reply lands on
	 * the forum with no trace of it.
	 *
	 * Two shapes must both work:
	 *   - sticker_items (modern API), each item carrying the real sticker id;
	 *   - a single `message.sticker` (older shape) with `id`/`name`/`url`.
	 */
	{
		const { mirror, calls, discord } = makeMirror({
			topics: [], existingThreads: [{ id: 'TH_1', name: '[t:1] Welcome' }],
			sites: {},
		});
		await mirror.start();
		mirror.topicToThread.set('1', 'TH_1');
		mirror.threadToTopic.set('TH_1', '1');
		// The CDN answers a real PNG sticker; uploadAttachment records the call.
		discord.stickerItemUrl = async (item) => ({
			url: `https://cdn.discordapp.com/stickers/${item.id}.png`,
			extension: 'png', contentType: 'image/png',
		});

		const message = {
			id: 'MSG_STICK',
			channelId: 'TH_1',
			url: 'https://discord.com/channels/g/c/1/1',
			content: 'halo',
			author: { id: 'D9', username: 'za', bot: false },
			attachments: new Map(),
			sticker_items: [{ id: 'STICK1', name: 'hontoni', format_type: 1 }],
		};
		await mirror.onDiscordMessage(message);

		assert.strictEqual(calls.downloads.length, 1, `sticker downloaded once (got ${calls.downloads.length})`);
		assert.ok(/stickers\/STICK1\.png/.test(calls.downloads[0]), `sticker cdn url used: ${calls.downloads[0]}`);
		assert.strictEqual(calls.uploads.length, 1, `sticker re-uploaded to the forum (got ${calls.uploads.length})`);
		assert.ok(/\.png$/.test(calls.uploads[0].filename), `uploaded with an image extension: ${calls.uploads[0].filename}`);
		const body = calls.replies[0].content;
		assert.ok(/!\[[^\]]*\]\(https:\/\/forum\.imrnes\.team\/assets\/uploads\/files\//.test(body),
			`sticker is an inline markdown image, not a bare link: ${body}`);
		assert.ok(/hontoni|sticker/i.test(body), `the sticker carries a readable label: ${body}`);
		console.log('ok - a discord sticker is re-uploaded and rendered inline on the forum');
	}

	/* ── the legacy single-sticker shape ────────────────────────────────── */
	{
		const { mirror, calls, discord } = makeMirror({ topics: [], existingThreads: [] });
		await mirror.start();
		mirror.topicToThread.set('1', 'TH_1');
		mirror.threadToTopic.set('TH_1', '1');
		discord.stickerItemUrl = async () => ({
			url: 'https://cdn.discordapp.com/stickers/LEGACY.png',
			extension: 'png', contentType: 'image/png',
		});

		await mirror.onDiscordMessage({
			id: 'MSG_STICK2', channelId: 'TH_1', url: 'u', content: 'x',
			author: { id: 'D9', username: 'za', bot: false },
			attachments: new Map(),
			sticker: { id: 'LEGACY', name: 'selamat datang', url: 'https://cdn.discordapp.com/stickers/LEGACY.png' },
		});
		assert.strictEqual(calls.uploads.length, 1, 'the single-sticker shape is mirrored too');
		assert.ok(calls.uploads[0].filename.includes('selamat'), `label comes from the sticker name: ${calls.uploads[0].filename}`);
		console.log('ok - the single message.sticker shape is mirrored');
	}

	/* ── stickers must not repeat content or break a sticker-only reply ──
	 * A sticker-only message has EMPTY content. The reply must still post, and
	 * the sticker must not be spliced into the body text twice.
	 */
	{
		const { mirror, calls, discord } = makeMirror({ topics: [], existingThreads: [] });
		await mirror.start();
		mirror.topicToThread.set('1', 'TH_1');
		mirror.threadToTopic.set('TH_1', '1');
		discord.stickerItemUrl = async (item) => ({
			url: `https://cdn.discordapp.com/stickers/${item.id}.png`,
			extension: 'png', contentType: 'image/png',
		});

		await mirror.onDiscordMessage({
			id: 'MSG_STICK3', channelId: 'TH_1', url: 'u', content: '',
			author: { id: 'D9', username: 'za', bot: false },
			attachments: new Map(),
			sticker_items: [{ id: 'S_A', name: 'a' }, { id: 'S_B', name: 'b' }],
		});
		assert.strictEqual(calls.replies.length, 1, 'a sticker-only message still posts');
		const body = calls.replies[0].content;
		assert.strictEqual((body.match(/assets\/uploads\/files\//g) || []).length, 2,
			`both stickers appear exactly once: ${body}`);
		console.log('ok - a sticker-only reply posts, with each sticker rendered once');
	}

	/* ── a dead sticker must not lose the message text ────────────────────
	 * Same rule as attachments: one failing upload must not drop the reply.
	 */
	{
		const { mirror, calls, discord } = makeMirror({ topics: [], existingThreads: [] });
		await mirror.start();
		mirror.topicToThread.set('1', 'TH_1');
		mirror.threadToTopic.set('TH_1', '1');
		discord.stickerItemUrl = async () => ({
			url: 'https://cdn.discordapp.com/stickers/GONE.png',
			extension: 'png', contentType: 'image/png',
		});
		mirror.nodebb.downloadBinary = async () => { throw new Error('404 sticker'); };
		mirror.nodebb.uploadAttachment = async () => { throw new Error('no upload'); };

		await mirror.onDiscordMessage({
			id: 'MSG_STICK4', channelId: 'TH_1', url: 'u', content: 'teks penting',
			author: { id: 'D9', username: 'za', bot: false },
			attachments: new Map(),
			sticker_items: [{ id: 'GONE', name: 'rusak' }],
		});
		assert.strictEqual(calls.replies.length, 1, 'the text still posts when the sticker fails');
		assert.ok(calls.replies[0].content.includes('teks penting'), 'and the text is intact');
		console.log('ok - a failed sticker upload does not lose the message text');
	}

	/* ── the logger must expose every level the bridge calls ─────────── */
	// Regression: `this.log.debug(...)` was used for per-post skips, but the
	// logger only had info/warn/error. The resulting TypeError was caught by the
	// caller and logged as "post mirror failed", so a routine skip looked exactly
	// like a broken bridge.
	{
		const log = require('../src/log');
		['debug', 'info', 'warn', 'error'].forEach((level) => {
			assert.strictEqual(
				typeof log[level], 'function', `log.${level} exists and is callable`
			);
			assert.doesNotThrow(() => log[level]('test line', { probe: true }), `log.${level} does not throw`);
		});
		console.log('ok - the logger exposes debug/info/warn/error');
	}

	/* ── ranking boundaries ──────────────────────────────────────────── */
	const idn = new IdentityStore();
	idn.setLadder([{ min: 0, name: '[Neophyte]' }, { min: 3, name: '[Apprentice]' }, { min: 10, name: '[Pathfinder]' }]);
	assert.strictEqual(idn.rankTitleFor(0), '[Neophyte]');
	assert.strictEqual(idn.rankTitleFor(2), '[Neophyte]', 'below the next threshold');
	assert.strictEqual(idn.rankTitleFor(3), '[Apprentice]', 'exactly on the threshold');
	assert.strictEqual(idn.rankTitleFor(999), '[Pathfinder]', 'beyond the ladder');
	console.log('ok - rank boundaries with an array ladder');

	/* ── webhook failure must be remembered ──────────────────────────────
	 * Creating a webhook in a channel without MANAGE_WEBHOOKS always fails with
	 * `Unknown Channel`. Without a negative cache entry the bridge retried the
	 * doomed request on EVERY mirrored post, emitting one WARN per message.
	 */
	const { DiscordTransport } = require('../src/discord-transport');
	const fakeCfg = {
		discord: { botToken: 'x', appId: 'y' },
	};
	const transport = new DiscordTransport(fakeCfg);
	let createAttempts = 0;
	transport.rest.get = async () => { throw new Error('Unknown Channel'); };
	transport.rest.post = async (route) => {
		if (String(route).includes('/webhooks')) {
			createAttempts += 1;
			throw new Error('Unknown Channel');
		}
		return {};
	};
	transport.onLog = () => {};
	for (let i = 0; i < 5; i += 1) {
		assert.strictEqual(await transport.ensureWebhook('C1', 'n'), null, 'falls back to a plain bot message');
	}
	assert.strictEqual(createAttempts, 1, `webhook creation attempted once, not per message (got ${createAttempts})`);
	console.log('ok - webhook failure is cached, not retried per message');

	/* A regression test, not a style preference. mdLiteral() escaped `.` and `-`,
	 * markdown-it kept that backslash inside the image alt attribute, and the
	 * rendered markup came out as alt="hontoni1460995774103158949png" - the dots
	 * disappeared. The image itself still rendered, which is exactly why this
	 * stayed hidden: the post looked fine, only the filename was corrupted. */
	const altBody = forumPostMarkdown({
		nickname: 'za',
		content: '',
		attachments: [{
			name: 'hontoni-1460995774103158949.png',
			url: 'https://forum.imrnes.team/assets/uploads/files/x.png',
		}],
	});
	assert.ok(
		altBody.includes('![hontoni-1460995774103158949.png]('),
		`filename with dots and dashes must survive verbatim in the alt text: ${altBody}`,
	);
	assert.ok(
		!altBody.includes('\\-') && !altBody.includes('\\.'),
		`alt text must not carry markdown backslash escapes: ${altBody}`,
	);
	console.log('ok - image alt text keeps the filename verbatim');

	/* A regression test for a restart flood. restoreState() used to restore the
	 * tid->thread map but NOT `topicCursors`, so after every restart pollOnce()
	 * saw an empty cursor map and treated each topic's ENTIRE history as new:
	 * the same pid was mirrored into Discord again on every poll (~6 duplicate
	 * messages a minute, live). The thread map looked perfect while the cursors
	 * silently did not exist.
	 *
	 * Written as a REAL fixture on the suite's own temp state path rather than a
	 * monkey-patch: `forum-mirror` destructures `readState` at require() time, so
	 * reassigning the export afterwards has no effect on it. */
	const { STATE_PATH: suiteStatePath } = require('../src/state');
	const cursorFixture = JSON.stringify({
		threads: { 7: 'TH7' },
		topicCursors: { 7: 4242 },
	});
	const realSuiteState = fs.existsSync(suiteStatePath) ? fs.readFileSync(suiteStatePath, 'utf8') : null;
	fs.writeFileSync(suiteStatePath, cursorFixture, 'utf8');
	try {
		const restoreMirror = makeMirror().mirror;
		await restoreMirror.restoreState();
		assert.strictEqual(
			restoreMirror.topicCursor.get('7'), 4242,
			'restoreState() must bring topicCursors back, not just the thread map',
		);
		assert.strictEqual(
			restoreMirror.topicToThread.get('7'), 'TH7',
			'thread map must still restore',
		);
	} finally {
		if (realSuiteState === null) fs.unlinkSync(suiteStatePath);
		else fs.writeFileSync(suiteStatePath, realSuiteState, 'utf8');
	}
	console.log('ok - restoreState brings the topic cursors back');

	/* THE bug that hid in plain sight. This test was written against a hand-built
	 * object `{ sticker_items: [{id, name, format_type}] }`, which is the RAW
	 * REST shape. discord.js never hands you that: it builds `message.stickers`
	 * as a Collection of Sticker instances whose format field is `format`, and
	 * `message.sticker_items` does not exist at all. So every real Discord message
	 * took the `!items.length` early return and the sticker vanished - while the
	 * test kept passing against a shape that only the probe ever produced.
	 *
	 * Assert against the discord.js shape, not the REST shape. */
	const { Collection: DjsCollection } = require('../node_modules/discord.js');
	const asDjsSticker = (id, name, format) => ({
		id, name, format,
		toJSON: () => ({ id, name, format_type: format }),
	});
	const djsMessage = {
		stickers: new DjsCollection([
			['1460995774103158949', asDjsSticker('1460995774103158949', 'hontoni', 1)],
		]),
	};
	assert.strictEqual(
		normaliseStickerItems(djsMessage).length, 1,
		'stickers must be read from the discord.js .stickers Collection',
	);
	assert.strictEqual(
		normaliseStickerItems(djsMessage)[0].format, 1,
		'a discord.js Sticker exposes its format as .format, not .format_type',
	);
	assert.strictEqual(
		normaliseStickerItems(djsMessage)[0].name, 'hontoni',
		'sticker name survives',
	);
	// The raw REST shape must keep working: the probe and any direct REST path
	// still hand us plain objects.
	assert.strictEqual(
		normaliseStickerItems({ sticker_items: [{ id: '1', name: 'n', format_type: 3 }] })[0].format, 3,
		'the raw REST shape must still be accepted',
	);
	console.log('ok - stickers are read from the discord.js .stickers Collection');

	// ── poll cost: an unchanged topic must cost ZERO fetches ──
	// Measured 2026-10-16 on imrnes: the old code refetched every topic on every
	// 20s cycle (~2070 requests/poll, ~372k/hour) because getTopicPosts walked
	// the whole history even when nothing had been posted. Two guards now exist:
	// skip on unchanged `lastposttime`, and a backwards cursor-bounded walk.
	const costed = makeMirror({
		topics: [
			{ tid: 1, title: 'Steady', uid: 1, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'aryma' } },
		],
		postsByTopic: { 1: [{ pid: 10, tid: 1, content: 'hello' }] },
	});
	let fetches = 0;
	const realGet = costed.nodebb.getTopicPosts;
	costed.nodebb.getTopicPosts = async (...args) => { fetches += 1; return realGet(...args); };

	await costed.mirror.start();
	// Establish a cursor for tid 1 so the skip is allowed to engage.
	costed.mirror.topicCursor.set('1', 10);
	await costed.mirror.pollOnce();
	assert.strictEqual(fetches, 1, 'first pass fetches the topic once and seeds the cache');
	await costed.mirror.pollOnce();
	await costed.mirror.pollOnce();
	assert.strictEqual(fetches, 1, 'an unchanged topic costs ZERO fetches on later polls');
	console.log('ok - an unchanged topic is skipped instead of refetched');

	// A topic with NO cursor must always be fetched, or its cursor could never
	// be established and its history would never mirror at all.
	const fresh = makeMirror({
		topics: [
			{ tid: 2, title: 'Never seen', uid: 1, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'aryma' } },
		],
		postsByTopic: { 2: [{ pid: 20, tid: 2, content: 'first post' }] },
	});
	await fresh.mirror.start();
	await fresh.mirror.pollOnce();
	assert.ok(
		fresh.mirror.topicCursor.has('2'),
		'a topic without a cursor is always fetched so its cursor can be seeded',
	);
	console.log('ok - a topic with no cursor is never skipped');

	// When lastposttime moves, the topic MUST be refetched, otherwise new posts
	// would be silently dropped - the exact failure mode the cursor logic is
	// supposed to prevent.
	const moving = makeMirror({
		topics: [
			{ tid: 3, title: 'Moves', uid: 1, timestamp: 1700000000, lastposttime: 1700000100, user: { username: 'aryma' } },
		],
		postsByTopic: { 3: [{ pid: 30, tid: 3, content: 'one' }] },
	});
	await moving.mirror.start();
	moving.mirror.topicCursor.set('3', 30);
	await moving.mirror.pollOnce();
	const before = moving.calls.sent.length;
	// Simulate a new forum post: the listing's lastposttime advances.
	moving.mirror.nodebb.listCategoryTopics = async () => ({
		topics: [{ tid: 3, title: 'Moves', uid: 1, timestamp: 1700000000, lastposttime: 1799999999, postcount: 2, user: { username: 'aryma' } }],
	});
	moving.mirror.nodebb.getTopicPosts = async () => ({ posts: [{ pid: 31, tid: 3, content: 'two' }] });
	await moving.mirror.pollOnce();
	assert.strictEqual(
		moving.calls.sent.length, before + 1,
		'an advanced lastposttime forces a refetch and the new post is mirrored',
	);
	console.log('ok - an advanced lastposttime forces a refetch');

	restoreState();
	console.log('\nALL FORUM-MODE TESTS PASSED');
})().catch((err) => {
	console.error('FORUM-MODE TESTS FAILED', err);
	process.exit(1);
});
