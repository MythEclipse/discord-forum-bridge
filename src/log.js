'use strict';

const LEVELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

// `debug` is a no-op unless DEBUG is set. It exists because callers use it for
// per-post skips: a level that does not exist on the logger turns a harmless
// "nothing to do here" into a thrown TypeError, which the caller then reports as
// a mirror failure - the skip looks like a broken bridge.
const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG || ''));

function ts() {
	return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, msg, meta) {
	const line = `[${ts()}] ${LEVELS[level]} ${msg}`;
	if (meta !== undefined) {
		console.log(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
	} else {
		console.log(line);
	}
}

module.exports = {
	debug: (msg, meta) => {
		if (DEBUG_ENABLED) {
			emit('debug', msg, meta);
		}
	},
	info: (msg, meta) => emit('info', msg, meta),
	warn: (msg, meta) => emit('warn', msg, meta),
	error: (msg, meta) => emit('error', msg, meta),
};
