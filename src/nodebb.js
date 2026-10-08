'use strict';

/**
 * NodeBB write API v3 client (minimal).
 *
 * Only the endpoints the bridge needs are implemented. Every call carries the
 * dedicated user token, never the admin master token.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class NodebbError extends Error {
	constructor(status, body, url) {
		super(`NodeBB ${status} ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
		this.name = 'NodebbError';
		this.status = status;
		this.body = body;
	}
}

function request(method, url, { token, body, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const lib = target.protocol === 'http:' ? http : https;
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = lib.request({
			method: method,
			hostname: target.hostname,
			port: target.port || (target.protocol === 'http:' ? 80 : 443),
			path: `${target.pathname}${target.search}`,
			headers: Object.assign({
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			}, payload ? {
				'Content-Type': 'application/json',
				'Content-Length': payload.length,
			} : {}, headers),
		}, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let parsed = text;
				try {
					parsed = text ? JSON.parse(text) : null;
				} catch (err) { /* keep raw text */ }
				if (res.statusCode >= 400) {
					return reject(new NodebbError(res.statusCode, parsed, url));
				}
				resolve(parsed);
			});
		});
		req.on('error', reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

function createClient({ url, apiToken }) {
	const base = `${url}/api/v3`;
	const call = (method, endpoint, body) => request(method, `${base}${endpoint}`, { token: apiToken, body });

	return {
		raw: (method, endpoint, body) => call(method, endpoint, body),

		// GET /api/v3/config
		getConfig: () => call('GET', '/config'),

		// GET /api/v3/categories?slug=<slug>
		getCategoryBySlug: (slug) => call('GET', `/categories?slug=${encodeURIComponent(slug)}`),

		// GET /api/v3/topics/<tid>
		getTopic: (tid) => call('GET', `/topics/${encodeURIComponent(tid)}`),

		// GET /api/v3/topics/<tid>/posts
		getTopicPosts: (tid, { from = 0, to = 99 } = {}) =>
			call('GET', `/topics/${encodeURIComponent(tid)}/posts?start=${from}&stop=${to}`),

		// POST /api/v3/topics  { cid, title, content, uid }
		createTopic: ({ cid, title, content, uid }) =>
			call('POST', '/topics', { cid, title, content, uid, tags: [] }),

		// POST /api/v3/topics/<tid>/posts { content, uid }
		replyToTopic: (tid, { content, uid }) =>
			call('POST', `/topics/${encodeURIComponent(tid)}/posts`, { content, uid }),

		// GET /api/v3/users/username/<username>  -> resolved user object
		getUserByUsername: (username) =>
			call('GET', `/users/username/${encodeURIComponent(username)}`),
	};
}

module.exports = { createClient, NodebbError };
