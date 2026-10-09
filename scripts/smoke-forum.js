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

const { ForumMirror } = require('../src/forum-mirror');
const { IdentityStore } = require('../src/identity');
const { htmlToPlainText, htmlEscape, mdEscape, webhookSafe, forumPostMarkdown, MARKER, chunkMessage } = (() => {
	const t = require('../src/text');
	const d = require('../src/discord-transport');
	return { ...t, chunkMessage: d.chunkMessage };
})();

const STATE_PATH = path.join(__dirname, '..', 'data', 'state.json');
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
		sendToThread: async (threadId, payload) => { calls.sent.push({ threadId, ...payload }); },
		fetchMember: async (id) => (overrides.members?.[id] || { id, displayName: 'tester', user: { username: 'tester' } }),
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
		assert.ok(
			body.includes('(https://forum.imrnes.team/assets/uploads/files/1-clip.mp4)'),
			'non-image attachments become a link, not a broken image thumb'
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

	restoreState();
	console.log('\nALL FORUM-MODE TESTS PASSED');
})().catch((err) => {
	console.error('FORUM-MODE TESTS FAILED', err);
	process.exit(1);
});
