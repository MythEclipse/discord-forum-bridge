'use strict';
// Guard test: the state-writing scripts must REFUSE to run without
// BRIDGE_DATA_DIR.
//
// WHY THIS EXISTS - a real outage, not a hypothetical:
//
// On 2026-10-17 smoke-forum.js was run directly (`node scripts/smoke-forum.js`)
// instead of through `npm run check:forum`, which is what sets BRIDGE_DATA_DIR.
// src/state.js then resolved STATE_PATH to the PRODUCTION data/state.json. The
// run FAILED an assertion partway through, so smoke-forum.js's own
// restoreState() cleanup never executed, and the pytest-style fixture it had
// written stayed on disk:
//
//     { threads: { "7": "DEAD" }, topicCursors: {}, cid: 2 }
//
// The live bridge then restored from that file, so every topic looked brand new
// and the next poll re-mirrored history into Discord:
//
//     poll cycle {"topics":20,"fetched":20,"skipped":0,"mirrored":35}
//
// 35 duplicate messages, and the cursor count fell from 18 to 5. The fix is a
// guard INSIDE each script (a wrapper-only guard is exactly what failed here),
// and these assertions are what keep those guards in place.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

const ROOT = path.join(__dirname, '..');
const STATE_WRITERS = ['scripts/smoke-forum.js', 'scripts/probe-restart.js'];

// Run a script with BRIDGE_DATA_DIR deliberately removed from the env.
function runUnguarded(relPath) {
	const env = Object.assign({}, process.env);
	delete env.BRIDGE_DATA_DIR;
	try {
		const out = execFileSync(process.execPath, [path.join(ROOT, relPath)], {
			env, cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 30000,
		});
		return { code: 0, out };
	} catch (err) {
		return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

check('at least one state-writing script is covered (guard is not vacuous)', () => {
	assert.ok(STATE_WRITERS.length > 0);
	for (const rel of STATE_WRITERS) {
		assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
	}
});

for (const rel of STATE_WRITERS) {
	check(`${rel} refuses to run without BRIDGE_DATA_DIR`, () => {
		const res = runUnguarded(rel);
		assert.strictEqual(res.code, 2, `expected exit 2, got ${res.code}.\n` + res.out.slice(0, 400));
		assert.ok(/REFUSING TO RUN/.test(res.out), 'no refusal message:\n' + res.out.slice(0, 400));
		assert.ok(/BRIDGE_DATA_DIR/.test(res.out), 'refusal must name the missing var');
	});

	check(`${rel} names live state as the danger`, () => {
		const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		assert.ok(/LIVE/i.test(src), 'the refusal text should say it would touch LIVE state');
	});
}

check('the guard sits BEFORE any state module is imported', () => {
	// Ordering matters: `require('../src/state')` reads BRIDGE_DATA_DIR at import
	// time to compute STATE_PATH, so a guard placed after the import would already
	// have bound the production path.
	//
	// Comments are stripped first. A naive indexOf would match the guard's OWN
	// explanatory comment, which mentions `require('../src/state')` in prose and
	// sits above the guard - a false "guard comes too late" failure (this bit me).
	for (const rel of STATE_WRITERS) {
		const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		const lines = src.split('\n');
		const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
		const guardLine = lines.findIndex((l) => !isComment(l) && l.includes('BRIDGE_DATA_DIR is not set'));
		const importLine = lines.findIndex((l) => !isComment(l) && /require\('\.\.\/src\/state'\)/.test(l));
		assert.ok(guardLine > -1, `${rel} has no executable guard`);
		if (importLine > -1) {
			assert.ok(guardLine < importLine,
				`${rel}: guard is on line ${guardLine + 1} but the state import is on line ${importLine + 1}`);
		}
	}
});

check('none of the guarded scripts are wired into a check that lacks the env', () => {
	// If a package.json script runs one of these WITHOUT BRIDGE_DATA_DIR, the
	// guard turns a silent data-loss bug into a loud CI failure - which is the
	// intent, but it would break the suite. So assert the wiring is correct.
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
		for (const rel of STATE_WRITERS) {
			if (!cmd.includes(rel.replace('scripts/', ''))) continue;
			if (name === 'start') continue;
			assert.ok(
				cmd.includes('BRIDGE_DATA_DIR'),
				`package.json script "${name}" runs ${rel} without BRIDGE_DATA_DIR:\n  ${cmd}`
			);
		}
	}
});

console.log('  ' + passed + ' passed' + (process.exitCode ? ', WITH FAILURES' : ''));
