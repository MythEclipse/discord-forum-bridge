'use strict';

/**
 * Offline smoke test: exercises the ladder maths, HTML escaping, echo-loop
 * detection and identity mapping WITHOUT Discord or NodeBB credentials.
 * Run with: npm run check
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseLadder, rankFor, normaliseHandle, IdentityStore } = require('../src/identity');
const { escapeHtml, Bridge } = require('../src/bridge');

const ladder = parseLadder([
	'0 | [Neophyte]',
	'5 | [Apprentice]',
	'20 | [Pathfinder]',
	'4150 | [TITAN]',
	'11050 | [IMMORTAL]',
].join('\n'));

assert.ok(ladder, 'ladder parsed');
assert.strictEqual(ladder.length, 5);
assert.strictEqual(rankFor(ladder, 0), '[Neophyte]');
assert.strictEqual(rankFor(ladder, 4), '[Neophyte]');
assert.strictEqual(rankFor(ladder, 5), '[Apprentice]');
assert.strictEqual(rankFor(ladder, 4999), '[TITAN]', 'highest met threshold wins');
assert.strictEqual(rankFor(ladder, 19), '[Apprentice]');
assert.strictEqual(rankFor(ladder, 20), '[Pathfinder]');
assert.strictEqual(rankFor(ladder, 4150), '[TITAN]');
assert.strictEqual(rankFor(ladder, 999999), '[IMMORTAL]');
console.log('ok - rank ladder boundaries');

// invalid lines dropped, first row forced to 0
const messy = parseLadder([
	'not-a-number | [Broken]',
	'20 | [Alpha]',
	'20 | [Duplicate]',
	'garbage',
	'7 | [Beta]',
].join('\n'));
assert.ok(messy);
assert.strictEqual(messy[0].min, 7, 'sorted ascending');
assert.strictEqual(messy.length, 3, 'invalid + duplicate dropped');
console.log('ok - invalid lines dropped, duplicates merged');

assert.strictEqual(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
console.log('ok - html escaping');

assert.strictEqual(normaliseHandle(' @ArYma '), 'aryma');
console.log('ok - handle normalisation');

// echo prevention: a forum post carrying the marker must be skipped
const sent = [];
const nodebbCalls = [];
const fakeNodebb = {
	getCategoryBySlug: async () => ({ categories: [{ cid: 4 }] }),
	getConfig: async () => ({ categories: [{ cid: 4 }] }),
	createTopic: async (p) => { nodebbCalls.push(['createTopic', p.title]); return { tid: 7, slug: 'discord' }; },
	replyToTopic: async (tid, p) => { nodebbCalls.push(['replyToTopic', tid, p.content]); return { pid: 100 }; },
	raw: async () => null,
};

const bridge = new Bridge({
	discord: { send: async (m) => { sent.push(m); } },
	nodebb: fakeNodebb,
	config: {
		discord: { channelId: 'C', guildId: 'G' },
		nodebb: { bridgeUid: '99' },
		forum: {},
		behaviour: { marker: '<!-- discord-bridge -->' },
	},
});
bridge.setBotUserId('BOT');

(async () => {
	await bridge.onForumReply({ pid: 1, uid: '5', content: '<p>hi</p><!-- discord-bridge -->' }, { postcount: 3 });
	assert.strictEqual(sent.length, 0, 'marker post skipped');
	await bridge.onForumReply({ pid: 2, uid: '5', content: '<p>real</p>' }, { postcount: 3 });
	assert.strictEqual(sent.length, 1, 'normal post forwarded');
	await bridge.onForumReply({ pid: 2, uid: '5', content: '<p>real</p>' }, { postcount: 3 });
	assert.strictEqual(sent.length, 1, 'duplicate pid not re-sent');
	await bridge.onForumReply({ pid: 3, uid: '99', content: '<p>bot</p>' }, { postcount: 0 });
	assert.strictEqual(sent.length, 1, 'bridge uid skipped');
	await bridge.onDiscordMessage({ id: 'D1', content: 'hey', author: { id: 'U1', bot: false } }, { id: 'U1', nickname: 'ArYma', forumPostcount: 5000 });
	await bridge.onDiscordMessage({ id: 'D1', content: 'hey', author: { id: 'U1', bot: false } }, { id: 'U1', nickname: 'ArYma', forumPostcount: 5000 });
	assert.strictEqual(bridge.seenDiscord.size, 1, 'duplicate discord id ignored');
	console.log('ok - echo prevention both directions');

	const tid = await bridge.ensureTopic();
	assert.strictEqual(tid, 7, 'topic created once and reused');
	const created = nodebbCalls.filter((c) => c[0] === 'createTopic');
	assert.strictEqual(created.length, 1, 'topic created exactly once');
	const reply = nodebbCalls.find((c) => c[0] === 'replyToTopic');
	assert.ok(reply && reply[1] === 7, 'discord message posted to bridged topic');
	assert.ok(reply[2].includes('<!-- discord-bridge -->'), 'marker present in forum post');
	assert.ok(reply[2].includes('https://discord.com/channels/G/C/D1'), 'back-link to discord');
	console.log('ok - topic created once, messages routed with marker + backlink');

	const html = bridge.discordMessageToHtml({ id: 'D9', content: 'hi <b>' }, { nickname: 'x', forumPostcount: 5050 });
	assert.ok(html.includes('<!-- discord-bridge -->'), 'marker embedded');
	assert.ok(html.includes('&lt;b&gt;'), 'content escaped');
	assert.ok(html.includes('[SAGE]'), 'rank from ladder');
	console.log('ok - discord message -> html');

	// ---------------------------------------------------------------------
	// Restart safety. The single-instance tests above cannot catch this: they
	// reuse one Bridge, so `topicId` is always warm. Simulate a restart by
	// constructing a SECOND Bridge over the same fake forum with NO in-memory
	// topicId — exactly what a systemd restart produces.
	// ---------------------------------------------------------------------
	console.log('\n-- restart safety --');
	const statePath = path.join(__dirname, '..', 'data', 'state.json');
	const savedState = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
	try { fs.unlinkSync(statePath); } catch (e) { /* absent */ }

	function freshBridge() {
		const calls = [];
		const fake = Object.assign({}, fakeNodebb, {
			createTopic: async (p) => { calls.push(['createTopic', p.cid]); return { tid: 100 + calls.length, slug: p.title }; },
			getCategoryTopics: async () => ({ topics: [] }),
			getTopic: async () => ({ tid: 1, mainPid: 1 }),
			getPost: async () => ({ content: '<p>x</p>' }),
			getTopicPosts: async () => ({ posts: [{ pid: 1, content: '<p>x</p>' }] }),
		});
		const b = new Bridge({
			discord: { send: async () => {} },
			nodebb: fake,
			config: {
				discord: { channelId: 'C', guildId: 'G' },
				nodebb: { bridgeUid: '99' },
				forum: { categorySlug: 'general-discussion', topicPrefix: 'DISCORD' },
				behaviour: { marker: '<!-- discord-bridge -->' },
			},
		});
		return { b, calls };
	}

	const run1 = freshBridge();
	await run1.b.ensureTopic();
	const firstTid = run1.b.topicId;
	assert.ok(fs.existsSync(statePath), 'state.json written on topic creation');
	const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
	assert.strictEqual(persisted.topicId, firstTid, 'persisted tid matches the live tid');

	// restart: brand new Bridge, warm nothing, but state.json survives
	const run2 = freshBridge();
	await run2.b.ensureTopic();
	assert.strictEqual(run2.b.topicId, firstTid, 'restart resumed the SAME topic');
	assert.strictEqual(run2.calls.filter((c) => c[0] === 'createTopic').length, 0,
		'restart did NOT create a second topic');
	console.log('ok - restart resumes the persisted topic instead of duplicating it');

	// if state.json is lost, the marker search must adopt the existing topic
	fs.unlinkSync(statePath);
	const run3 = freshBridge();
	run3.b.nodebb.getCategoryTopics = async () => ({
		topics: [{ tid: firstTid, title: 'DISCORD C', slug: 'DISCORD C' }],
	});
	run3.b.nodebb.getPost = async () => ({ content: `<p>mirror</p><!-- channel:C -->` });
	await run3.b.ensureTopic();
	assert.strictEqual(run3.b.topicId, firstTid, 'adopted the existing topic by marker');
	assert.strictEqual(run3.calls.filter((c) => c[0] === 'createTopic').length, 0,
		'no duplicate created when state was lost');
	console.log('ok - lost state is recovered by marker search, not by duplicating');

	if (savedState === null) { try { fs.unlinkSync(statePath); } catch (e) { /* absent */ } }
	else { fs.writeFileSync(statePath, savedState); }

	// ladder input shape: the forum returns an ARRAY, defaults are TEXT
	const arrStore = new IdentityStore();
	arrStore.setLadder([{ min: 0, name: '[Neophyte]' }, { min: 3, name: '[Apprentice]' }, { min: 10, name: '[Pathfinder]' }]);
	assert.deepStrictEqual(arrStore.ladder.map((l) => l.min), [0, 3, 10], 'array ladder accepted as-is');
	assert.strictEqual(arrStore.rankTitleFor(5), '[Apprentice]', 'live array threshold honoured');
	assert.throws(() => arrStore.setLadder([]), 'empty ladder rejected loudly');
	const txtStore = new IdentityStore();
	txtStore.setLadder('0 | [A]\n7 | [B]');
	assert.deepStrictEqual(txtStore.ladder.map((l) => l.min), [0, 7], 'text ladder still works');
	console.log('ok - ladder accepts array and text, rejects garbage');

	console.log('\nALL SMOKE TESTS PASSED');
})().catch((err) => {
	console.error('SMOKE FAILED', err);
	process.exit(1);
});
