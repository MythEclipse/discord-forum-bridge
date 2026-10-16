'use strict';

const fs = require('fs');
const path = require('path');

// Locate the NodeBB app root: the directory that holds src/routes/helpers.js.
// Everything else in this plugin is resolved from there.
//
// The app root is DISCOVERED, never assumed. The previous version listed
// '/usr/src/app' as a primary candidate and treated
// path.resolve(__dirname, '../../../..') as a fallback. Both are wrong outside
// the official Docker image:
//
//   * /usr/src/app is the Docker path. It no longer exists now that this host
//     runs NodeBB natively at /opt/nodebb/app.
//   * the ../../../.. walk assumes the plugin sits at <app>/node_modules/<id>.
//     Here it is a symlink into /opt/nodebb/plugins/, so __dirname is the
//     symlink TARGET and the walk lands on "/" instead of the app root.
//
// With no candidate matching, it returned '/usr/src/app' regardless, and the
// require that followed threw `Cannot find module
// '/usr/src/app/src/routes/helpers'` while NodeBB was loading the plugin.
// NodeBB logged "Unable to load library" and carried on, so the route was never
// mounted and POST /api/v3/bridge-upload answered 404 with the same body as
// any unknown route. Guessing was the bug; the symptom was a silent 404.
//
// This lives in its own module so it can be tested. Requiring library.js pulls
// in NodeBB core, which calls process.exit(0) when src/routes/helpers is
// loaded outside a booted app — so library.js itself cannot be require()d from
// a test at all.

// The marker file is what makes a directory an app root. Nothing else in the
// tree is a reliable anchor.
const MARKER = path.join('src', 'routes', 'helpers.js');

function isAppRoot(dir) {
	if (!dir || !fs.existsSync(path.join(dir, MARKER))) {
		return false;
	}
	return fs.statSync(path.join(dir, MARKER)).isFile();
}

// nconf is NodeBB's own config. It is a global inside the app and absent here,
// so probe for it rather than requiring it: requiring nconf outside the app
// root pulls in the very core that calls process.exit(0).
function readNconfBaseDir() {
	try {
		if (typeof nconf === 'function') {
			return nconf('baseDir') || null;
		}
	} catch (err) {
		return null;
	}
	return null;
}

function walkUp(start, depth = 8) {
	const found = [];
	if (!start) {
		return found;
	}
	let dir = path.resolve(start);
	for (let i = 0; i < depth; i += 1) {
		found.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return found;
}

function resolveAppRoot(options = {}) {
	// Order matters. The explicit env var wins, then nconf (authoritative once
	// the app is up and set before plugins load), then the cwd (NodeBB is always
	// started from its app root), and only then the upward walks — which is
	// what covers a plain checkout in CI.
	const candidates = [
		options.env ? options.env.NODEBB_APP_ROOT : process.env.NODEBB_APP_ROOT,
		readNconfBaseDir(),
		options.cwd ? options.cwd : process.cwd(),
		...walkUp(options.pluginDir ? options.pluginDir : __dirname),
		...(options.cwd ? walkUp(options.cwd) : []),
	];

	const tried = [];
	for (const root of candidates.filter(Boolean)) {
		if (tried.includes(root)) {
			continue;
		}
		tried.push(root);
		if (isAppRoot(root)) {
			return root;
		}
	}

	// A wrong app root does not throw on its own: it makes the caller's
	// createRequire fail with "Cannot find module", which NodeBB swallows into
	// "Unable to load library" and the route silently 404s. Fail here instead,
	// naming what was tried, so the real cause is the thing in the log.
	throw new Error(
		'nodebb-plugin-bridge-upload: could not locate the NodeBB app root. ' +
			'Set NODEBB_APP_ROOT to the directory containing src/routes/helpers.js, ' +
			'or start NodeBB from its app root. Tried: ' +
			tried.join(', ')
	);
}

module.exports = { resolveAppRoot, isAppRoot, MARKER };