'use strict';

/**
 * Live integration probe: everything except Discord.
 *
 * Requires NODEBB_API_TOKEN (+ NODEBB_BRIDGE_UID when NODEBB_AUTH_MODE=master)
 * but NOT DISCORD_BOT_TOKEN, so the forum half can be verified before the bot
 * credentials exist. Read-only: it never creates or deletes content.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { loadNodebbConfig } = require('../src/config');
const { createClient } = require('../src/nodebb');
const { IdentityStore } = require('../src/identity');

let failures = 0;

function check(label, ok, detail) {
	const mark = ok ? 'PASS' : 'FAIL';
	if (!ok) {
		failures += 1;
	}
	console.log(`${mark}  ${label}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
	const nodebb = createClient(loadNodebbConfig());

	const probe = await nodebb.probe();
	check('api token authenticates', true, `authMode=${probe.authMode} _uid=${probe.actorUid}`);

	const ladder = await nodebb.getRankLadder();
	check('ladder endpoint is live', Array.isArray(ladder.levels) && ladder.levels.length > 0,
		`${ladder.levels.length} levels`);
	check('ladder is sorted ascending', ladder.levels.every((l, i, a) => i === 0 || l.min >= a[i - 1].min),
		ladder.levels.slice(0, 3).map((l) => `${l.min}:${l.name}`).join(' '));

	const identity = new IdentityStore();
	identity.setLadder(ladder.levels.map((l) => `${l.min} | ${l.name}`).join('\n'));
	const first = ladder.levels[0];
	const last = ladder.levels[ladder.levels.length - 1];
	check('postcount 0 resolves to the first level', identity.rankTitleFor(0) === first.name,
		identity.rankTitleFor(0));
	check('a high postcount resolves to the last level', identity.rankTitleFor(last.min) === last.name,
		`${last.min} -> ${identity.rankTitleFor(last.min)}`);
	const between = ladder.levels[1];
	const probe1 = between.min - 1;
	check('a postcount below level 2 stays at level 1', identity.rankTitleFor(probe1) === first.name,
		`${probe1} -> ${identity.rankTitleFor(probe1)}`);

	// category lookup used by ensureTopic()
	try {
		const cat = await nodebb.getCategoryBySlug(process.env.FORUM_CATEGORY_SLUG || 'general-discussion');
		const cats = (cat && cat.categories) || [];
		check('configured category slug resolves', cats.length > 0,
			cats.length ? `cid=${cats[0].cid}` : `no category for slug "${process.env.FORUM_CATEGORY_SLUG || 'general-discussion'}"`);
	} catch (err) {
		check('configured category slug resolves', false, err.message);
	}

	console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('probe crashed:', err.message);
	process.exit(1);
});
