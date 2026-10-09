'use strict';

/**
 * Durable bridge state: which forum topic mirrors the Discord channel.
 *
 * WHY THIS EXISTS
 * `Bridge.topicId` is an in-memory field. A restart (deploy, crash, `systemctl
 * restart`) wipes it, and a naive `ensureTopic()` then creates a SECOND mirror
 * topic — the forum slowly fills with duplicates, each one polling a different
 * tid. Persisting the tid to disk makes the mirror idempotent across restarts.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated JSON file that fails to parse on the next boot.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let writeCounter = 0;

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

async function readState() {
	try {
		const raw = await fsp.readFile(STATE_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (err) {
		if (err.code !== 'ENOENT') {
			// Corrupt state must not be fatal: the caller falls back to searching.
			require('../src/log').warn('state file unreadable, ignoring', err.message);
		}
		return null;
	}
}

async function writeState(patch) {
	const current = (await readState()) || {};
	const next = Object.assign({}, current, patch, { updatedAt: new Date().toISOString() });
	await fsp.mkdir(DATA_DIR, { recursive: true });
	// The temp name must be unique per WRITE, not per process: the poll loop
	// and a self-healing ensureThread() can both persist inside the same tick,
	// and with only `${process.pid}` they race for the same temp file - the
	// loser then fails `rename` with ENOENT. Counter + random suffix makes the
	// atomic write actually atomic under concurrency.
	const tmp = `${STATE_PATH}.${process.pid}.${++writeCounter}.${crypto.randomBytes(4).toString('hex')}.tmp`;
	await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tmp, STATE_PATH);
	return next;
}

module.exports = { readState, writeState, STATE_PATH, DATA_DIR };
