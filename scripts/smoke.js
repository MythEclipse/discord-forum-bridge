'use strict';

/**
 * Offline smoke test: exercises the ladder maths, HTML escaping, echo-loop
 * detection and identity mapping WITHOUT Discord or NodeBB credentials.
 * Run with: npm run check
 */

const assert = require('assert');
const { parseLadder, rankFor, normaliseHandle } = require('../src/identity');
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
	console.log('\nALL SMOKE TESTS PASSED');
})().catch((err) => {
	console.error('SMOKE FAILED', err);
	process.exit(1);
});
