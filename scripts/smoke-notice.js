'use strict';
// Regression tests for the notification the bridge used to post when a Discord
// thread was adopted onto the forum. The reported message was:
//
//   :white_check_mark: Diskusi ini sekarang ada di forum: https://forum.imrnes.team/topic/34
//   ken memulai diskusi ini dari Discord.     <- embed.title
//   ken memulai diskusi ini dari Discord.     <- embed.description
//
// The second and third lines are ONE unfurl of the forum link: NodeBB serves the
// topic's first post as both og:title and og:description, so the sentence renders
// twice inside a single card. A fix that only silences the message would leave that
// duplicate intact, so these assertions cover the flag too.
//
// Each assertion fails on the pre-fix code and passes on the fixed code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { noticePlan, INTRO_FLAGS, SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS } = require('../src/notice');

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

const flagBits = (n) => Number(n).toString(2).padStart(16, '0');

// ── the numeric flags themselves ─────────────────────────────────────────────
check('SUPPRESS_EMBEDS is bit 2 (value 4)', () => {
	assert.strictEqual(SUPPRESS_EMBEDS, 4, 'got ' + SUPPRESS_EMBEDS);
});

check('SUPPRESS_NOTIFICATIONS is bit 12 (value 4096)', () => {
	assert.strictEqual(SUPPRESS_NOTIFICATIONS, 4096, 'got ' + SUPPRESS_NOTIFICATIONS);
});

// ── the default: no notification at all ──────────────────────────────────────
check('the default mode posts nothing', () => {
	const plan = noticePlan('off');
	assert.strictEqual(plan.send, false, 'default must not post');
	assert.strictEqual(plan.flags, 0);
});

check('an undefined mode falls back to not posting', () => {
	assert.strictEqual(noticePlan(undefined).send, false);
	assert.strictEqual(noticePlan('').send, false);
});

check('a typo cannot resurrect the notification', () => {
	for (const bad of ['ofl', 'false', 'no', '0', 'OFFF', 'silentt']) {
		const plan = noticePlan(bad);
		assert.strictEqual(plan.send, false, `mode ${JSON.stringify(bad)} should not post`);
	}
});

check('mode comparison is case- and whitespace-insensitive', () => {
	assert.strictEqual(noticePlan('  SILENT ').send, true);
	assert.strictEqual(noticePlan('On').send, true);
	assert.strictEqual(noticePlan('  on  ').mode, 'on');
});

// ── the two posted modes still suppress the unfurl ───────────────────────────
check('silent mode suppresses BOTH embeds and notifications', () => {
	const plan = noticePlan('silent');
	assert.strictEqual(plan.send, true);
	assert.ok(plan.flags & SUPPRESS_EMBEDS, 'embeds must be suppressed in silent mode');
	assert.ok(plan.flags & SUPPRESS_NOTIFICATIONS, 'notifications must be suppressed in silent mode');
});

check('on mode still suppresses the self-referential unfurl', () => {
	const plan = noticePlan('on');
	assert.strictEqual(plan.send, true);
	assert.ok(plan.flags & SUPPRESS_EMBEDS, 'the duplicate og:title/description card must not come back');
	assert.ok(!(plan.flags & SUPPRESS_NOTIFICATIONS), 'on mode must remain a normal message');
});

check('no mode ever returns a notifications-only flag set', () => {
	for (const mode of ['off', 'silent', 'on', 'x', '']) {
		const { flags } = noticePlan(mode);
		if (flags & SUPPRESS_NOTIFICATIONS) {
			assert.ok(flags & SUPPRESS_EMBEDS, `mode ${mode} would silence the ping but keep the duplicate card`);
		}
	}
});

// ── the thread intro carries the same guard ──────────────────────────────────
check('the thread intro always suppresses its unfurl', () => {
	assert.ok(INTRO_FLAGS & SUPPRESS_EMBEDS, 'the intro restates its own topic; its unfurl is pure noise');
});

check('the thread intro is NOT silenced (it is the thread body)', () => {
	assert.ok(!(INTRO_FLAGS & SUPPRESS_NOTIFICATIONS), 'silencing the starter would hide the new thread');
});

// ── the fix is actually wired into the code paths ────────────────────────────
// A correct policy module that nothing imports would pass every test above and
// still ship the bug, so these assertions read the call sites.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

check('main.js routes the notice through noticePlan', () => {
	const src = read('src/main.js');
	assert.ok(/require\('\.\/notice'\)/.test(src), 'main.js does not import the policy');
	assert.ok(/noticePlan\(/.test(src), 'main.js does not call noticePlan');
	assert.ok(/plan\.send/.test(src), 'main.js ignores plan.send');
	assert.ok(/flags: plan\.flags/.test(src), 'main.js does not pass the flags');
});

check('the notice text is no longer sent unconditionally', () => {
	const src = read('src/main.js');
	// The old shape: channel.send(`...`) with no object and no flags.
	assert.ok(!/channel\.send\(\s*`[^`]*sekarang ada di forum/.test(src),
		'the unconditional single-string send is back');
});

check('the thread starter passes flags to createThread', () => {
	const src = read('src/forum-mirror.js');
	assert.ok(/flags: INTRO_FLAGS/.test(src), 'the intro does not pass INTRO_FLAGS');
	assert.ok(/require\('\.\/notice'\)/.test(src), 'forum-mirror.js does not import the notice module');
});

check('discord-transport forwards flags into the starter payload', () => {
	const src = read('src/discord-transport.js');
	assert.ok(/createThread\(parentId, \{ name, message, flags \}\)/.test(src),
		'createThread does not accept flags');
	assert.ok(/starter\.flags = flags/.test(src), 'createThread drops the flags');
});

check('config exposes the knob with a safe default', () => {
	const src = read('src/config.js');
	assert.ok(/notice: env\.BRIDGE_NOTICE \|\| 'off'/.test(src),
		'BRIDGE_NOTICE must default to off');
});

// Suppression is NOT selective: a live test on a message whose previews were
// `image,rich` removed BOTH, and Discord renders a markdown `![](url)` as an embed
// of type 'image'. Applying it to mirrored posts would therefore delete every
// mirrored picture from Discord while leaving the text - silently, with no error.
check('suppression is never wired into the mirrored-post path', () => {
	const mirror = read('src/forum-mirror.js');
	// renderDiscordPost() builds mirrored forum->Discord posts. Neither it nor its
	// sendToThread call may carry a flag.
	const at = mirror.indexOf('renderDiscordPost({ name, rank, html, link })');
	assert.ok(at > 0, 'renderDiscordPost not found - the assertion below is meaningless');
	const body = mirror.slice(at, at + 400);
	assert.ok(!/flags/.test(body), 'renderDiscordPost must not suppress embeds: that kills its images');

	const send = mirror.indexOf('await this.discord.sendToThread(threadId, {');
	assert.ok(send > 0, 'the forum->discord send site was not found');
	const sendBody = mirror.slice(send, send + 500);
	assert.ok(!/flags/.test(sendBody), 'the mirror send must not pass flags');

	// The ONLY flags in that module belong to the thread starter.
	const allFlags = [...mirror.matchAll(/flags:\s*(\w+)/g)].map((m) => m[1]);
	assert.deepStrictEqual([...new Set(allFlags)], ['INTRO_FLAGS'],
		'forum-mirror.js passes flags somewhere other than the thread starter: ' + allFlags.join(', '));
});

check('the transport does not suppress embeds by default', () => {
	const src = read('src/discord-transport.js');
	// sendToThread must keep accepting no flags argument at all.
	const at = src.indexOf('async sendToThread(');
	const sig = src.slice(at, at + 120);
	assert.ok(!/flags/.test(sig), 'sendToThread gained a flags parameter: ' + sig.split('\n')[0]);
});

console.log('');
if (process.exitCode) {
	console.log(`  ${passed} passed, some failed`);
} else {
	console.log(`  ${passed} passed`);
}
