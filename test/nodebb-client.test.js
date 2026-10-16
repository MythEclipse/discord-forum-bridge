// Tests for the NodeBB client, covering the request shapes the bridge relies on.
//
// These need no forum and no network: check-nodebb-client.js boots a local stub
// server on 127.0.0.1 and points the client at it, so the assertions are about
// the client's own behaviour — multipart field names, auth modes, error
// translation — rather than about a live NodeBB.
//
// Run: node test/nodebb-client.test.js

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const repoRoot = path.join(__dirname, '..');

// The real suite already exists and boots its own stub server. Running it here
// keeps one implementation of these assertions: if it passes, the client is
// behaving, and there is nothing to add in this file.
const suite = path.join(repoRoot, 'scripts', 'check-nodebb-client.js');

assert.ok(fs.existsSync(suite), `missing ${suite}`);

let passed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
		passed += 1;
	} catch (err) {
		console.log(`not ok - ${name}`);
		console.log(`  ${err.message}`);
		failures.push(name);
	}
}

test('the vendored bridge-upload plugin is not the one deployed', () => {
	// plugin-bridge-upload/ in this repo is a reference copy, kept so the
	// bridge's assumptions about the route are readable next to the code that
	// makes them. The forum installs the real plugin from
	// asepharyana/nodebb-plugin-bridge-upload, symlinked into the app.
	//
	// This copy drifted: it still resolved the app root to the Docker path
	// '/usr/src/app' and had no app-root.js at all, meaning a reader following
	// this repo would copy code that no longer works on a native install.
	const vendored = path.join(repoRoot, 'plugin-bridge-upload');
	const marker = path.join(vendored, 'app-root.js');
	assert.ok(
		fs.existsSync(marker),
		'the vendored copy is out of date — resync it from asepharyana/nodebb-plugin-bridge-upload ' +
			'or delete it and point at the repository instead'
	);
});

test('the bridge does not hardcode a Docker NodeBB path', () => {
	const offenders = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith('.js')) {
				let code = fs.readFileSync(full, 'utf8');
				code = code
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/^\s*\/\/.*$/gm, '')
					.replace(/(?:^|[^\\])`(?:[^`\\]|\\.)*`/g, '``');
				if (code.includes(['/usr', '/src', '/app'].join(''))) {
					offenders.push(path.relative(repoRoot, full));
				}
			}
		}
	};
	walk(path.join(repoRoot, 'src'));
	walk(path.join(repoRoot, 'scripts'));
	assert.deepStrictEqual(
		offenders,
		[],
		`the NodeBB Docker app path is hardcoded in: ${offenders.join(', ')}`
	);
});

test('the forum origin is configurable, not only a literal default', () => {
	// NOT process.env: config.js parses a .env file with its own reader, and
	// process environment values are folded in on top of it. The point of the
	// check is that the origin is a setting, not a literal baked into the code.
	const config = fs.readFileSync(path.join(repoRoot, 'src', 'config.js'), 'utf8');
	assert.match(
		config,
		/env\.NODEBB_URL\s*\|/,
		'NODEBB_URL must stay overridable so a staging forum does not need a code edit'
	);
});

(async () => {
	// Run the existing suite as a child so its own non-zero exit on failure is
	// observable here, instead of being swallowed by this process.
	const child = spawn(process.execPath, [suite], {
		cwd: repoRoot,
		env: { ...process.env, BRIDGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ci-')) },
		stdio: 'inherit',
	});
	const code = await new Promise((resolve) => child.on('exit', resolve));
	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (code !== 0 || failures.length) {
		console.log(`the stubbed client suite exited ${code}`);
		process.exit(1);
	}
})();