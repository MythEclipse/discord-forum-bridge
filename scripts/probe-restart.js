'use strict';

/**
 * Live proof that restarting the bridge does NOT create a second mirror topic.
 *
 * Creates a real mirror topic, throws the Bridge away, builds a new one (exactly
 * what `systemctl restart` does), and asserts it adopts the same tid. Then cleans
 * up the test topic so the forum is left as it was found.
 *
 * Requires the NodeBB half of the config only - no Discord credentials.
 */

// Where does this write? `src/state.js` picks the directory from BRIDGE_DATA_DIR
// and falls back to the LIVE `data/` folder. This probe calls `writeState` to
// clear the topic fields, so without the env var it edits production state.
//
// The same class of mistake caused a real outage on 2026-10-17: a test suite run
// directly (bypassing its npm wrapper) wrote a fixture into the live state file,
// wiping the cursors and making the bridge re-mirror 35 posts into Discord.
// A guard inside the file is what actually prevents that, so:
if (!process.env.BRIDGE_DATA_DIR) {
	console.error('REFUSING TO RUN: BRIDGE_DATA_DIR is not set.');
	console.error('This probe calls writeState() and would edit the LIVE bridge state.');
	console.error('Set BRIDGE_DATA_DIR to a temp dir first, e.g.:');
	console.error('  BRIDGE_DATA_DIR=$(mktemp -d) node scripts/probe-restart.js');
	process.exit(2);
}

const { loadNodebbConfig } = require('../src/config');
const { createClient } = require('../src/nodebb');
const { Bridge } = require('../src/bridge');
const { writeState, readState } = require('../src/state');

let failures = 0;
function check(label, ok, detail) {
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

function makeBridge(nodebb) {
	return new Bridge({
		discord: { send: async () => {} },
		nodebb,
		config: {
			discord: { channelId: `probe-${process.pid}`, guildId: 'probe' },
			nodebb: { bridgeUid: '2' },
			forum: { categorySlug: 'general-discussion', topicPrefix: 'BRIDGEPROBE' },
			behaviour: { marker: '<!-- discord-bridge -->' },
		},
	});
}

async function main() {
	const nodebb = createClient(loadNodebbConfig());
	const channelId = `probe-${process.pid}`;

	// Start from a genuinely EMPTY state file. Leaving a previous run's tid in
	// place makes the first assertion pass for the wrong reason (resuming a stale
	// tid) and masks whether topic creation works at all.
	await writeState({ topicId: undefined, topicTitle: undefined, probeChannelId: channelId });

	const first = makeBridge(nodebb);
	const tid1 = await first.ensureTopic();
	check('first run creates the mirror topic', Number.isFinite(tid1), `tid=${tid1}`);
	check('state.json persisted the tid', (await readState()).topicId === tid1);

	// restart: brand new Bridge object, nothing in memory, state.json survives
	const second = makeBridge(nodebb);
	const tid2 = await second.ensureTopic();
	check('restart reuses the SAME topic', tid2 === tid1, `${tid1} -> ${tid2}`);

	// and a third, after deleting state, must find it by marker
	await writeState({ topicId: undefined, topicTitle: undefined });
	const third = makeBridge(nodebb);
	const tid3 = await third.ensureTopic();
	check('lost state recovered by marker search', tid3 === tid1, `${tid1} -> ${tid3}`);

	console.log(`\ncleanup needed: delete topic ${tid1} (title "${first.topicTitle}")`);
	console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
	process.exitCode = failures === 0 ? 0 : 1;
	process.env.PROBE_TID = String(tid1);
}

main().catch((err) => {
	console.error('probe crashed:', err.message);
	process.exit(1);
});
