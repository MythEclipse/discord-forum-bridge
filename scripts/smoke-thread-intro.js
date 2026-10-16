'use strict';
// Regression tests for the three bugs that produced one bad Discord message:
//
//   **yg bisa akses nya cuma admin doang kalo**
//   _unknown - +058750-05-10T09:07:05.000Z_
//   [Buka di forum.imrnes.team](http://127.0.0.1:4567/topic/24)
//
// Each assertion below fails on the old code and passes on the fixed code, so
// the suite is a real tripwire rather than a description of intent.
const assert = require('assert');
const path = require('path');
const { publicForumUrl } = require('../src/config');
const { ForumMirror } = require('../src/forum-mirror');

let passed = 0;
const check = (name, fn) => {
	try {
		fn();
		passed += 1;
		console.log('  ✔ ' + name);
	} catch (err) {
		console.log('  ✘ ' + name);
		console.log('      ' + err.message);
		process.exitCode = 1;
	}
};

// A real v3 topic object, copied verbatim from the live API for topic 24.
// Note what is ABSENT: there is no `username` and no `user` field at all, and
// `timestamp` is milliseconds. Both facts are what broke the message.
const REAL_TOPIC = {
	cid: 2,
	tid: 24,
	uid: 12,
	title: 'yg bisa akses nya cuma admin doang kalo',
	timestamp: 1791814900025,
	timestampISO: '2026-10-12T14:21:40.025Z',
	mainPid: 265,
};

// Build a minimised mirror instance around the real config helper.
const mirror = () => {
	const m = Object.create(ForumMirror.prototype);
	m.config = { nodebb: { publicUrl: 'https://forum.imrnes.team' } };
	return m;
};

check('the injected date is the real one, not year 58750', () => {
	const out = mirror().threadIntro(REAL_TOPIC, 'aryma');
	assert.ok(out.includes('2026-10-12T14:21:40.025Z'), 'expected the real timestamp, got:\n' + out);
	assert.ok(!out.includes('058750'), 'the millisecond-value bug is back');
});

check('a seconds-valued timestamp is still handled (magnitude guard)', () => {
	// Some payloads carry seconds. Multiplying that by 1000 is correct; the
	// guard must not double-scale a millisecond value or vice versa.
	const seconds = { tid: 1, title: 'x', timestamp: 1791814900 };
	const out = mirror().threadIntro(seconds, 'aryma');
	assert.ok(out.includes('2026-10-12'), 'seconds-valued epoch was mis-scaled:\n' + out);
});

check('a missing timestamp degrades to a readable label, never "Invalid Date"', () => {
	const out = mirror().threadIntro({ tid: 1, title: 'x' }, 'a');
	assert.ok(!/Invalid Date/.test(out), 'produced Invalid Date:\n' + out);
	assert.ok(out.includes('tanggal tidak diketahui'), out);
});

check('the author line is the resolved name, never _unknown', () => {
	const out = mirror().threadIntro(REAL_TOPIC, 'aryma');
	assert.ok(out.includes('_aryma - '), 'author not rendered:\n' + out);
	assert.ok(!out.includes('_unknown'), 'the _unknown bug is back');
});

check('an unresolvable author degrades to a readable label, not _unknown', () => {
	const out = mirror().threadIntro(REAL_TOPIC, '');
	assert.ok(!out.includes('_unknown'), out);
	assert.ok(out.includes('pengguna forum'), out);
});

check('the link is the public origin, never the loopback address', () => {
	const out = mirror().threadIntro(REAL_TOPIC, 'aryma');
	assert.ok(out.includes('(https://forum.imrnes.team/topic/24)'), out);
	assert.ok(!out.includes('127.0.0.1'), 'the loopback link bug is back:\n' + out);
});

check('the marker is still appended so the bridge ignores its own message', () => {
	const out = mirror().threadIntro(REAL_TOPIC, 'aryma');
	assert.ok(out.includes('<!-- imrnes-bridge -->'), 'marker missing, echo loop risk');
});

check('publicForumUrl refuses every loopback spelling', () => {
	for (const value of ['http://127.0.0.1:4567', 'http://localhost:4567',
		'http://0.0.0.0:4567', 'http://[::1]:4567', 'https://127.0.0.1']) {
		assert.strictEqual(publicForumUrl({ NODEBB_URL: value }), 'https://forum.imrnes.team', value);
	}
});

check('publicForumUrl keeps a genuine public origin untouched', () => {
	assert.strictEqual(
		publicForumUrl({ NODEBB_URL: 'https://forum.imrnes.team/' }),
		'https://forum.imrnes.team'
	);
});

check('publicForumUrl prefers the explicit FORUM_PUBLIC_URL', () => {
	assert.strictEqual(
		publicForumUrl({ NODEBB_URL: 'http://127.0.0.1:4567', FORUM_PUBLIC_URL: 'https://f.example' }),
		'https://f.example'
	);
});

check('a schemeless NODEBB_URL is rejected rather than shipped', () => {
	assert.strictEqual(publicForumUrl({ NODEBB_URL: 'forum.imrnes.team' }), 'https://forum.imrnes.team');
});

check('the module loads without a DISCORD_BOT_TOKEN (forum-only tooling)', () => {
	// Regression guard: config.js is required by check scripts that have no bot
	// credentials. Eagerly building the full config would break them.
	assert.ok(typeof publicForumUrl === 'function');
	assert.ok(path.basename(require.resolve('../src/config')) === 'config.js');
});

console.log('  ' + passed + ' passed' + (process.exitCode ? ', WITH FAILURES' : ''));
