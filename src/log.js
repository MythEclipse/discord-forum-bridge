'use strict';

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

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
	info: (msg, meta) => emit('info', msg, meta),
	warn: (msg, meta) => emit('warn', msg, meta),
	error: (msg, meta) => emit('error', msg, meta),
};
