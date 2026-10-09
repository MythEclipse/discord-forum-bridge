'use strict';

/**
 * NodeBB API v3 client (minimal).
 *
 * TOKEN SEMANTICS - read before changing anything. NodeBB has two token
 * flavours and the bridge is given the MASTER one:
 *
 *   - **master token** (`settings:core.api` "Cyrene manager" style): full
 *     access, but every call must carry `?_uid=<uid>` on the query string.
 *     Without it NodeBB answers 400 "A master token was received without a
 *     corresponding `_uid`", and `/api/config` 500s with
 *     `[[error:api.master-token-no-uid]]`.
 *   - **user token** (per-user API token): no `_uid` needed, but limited to that
 *     user's own privileges.
 *
 * `NODEBB_AUTH_MODE` in .env decides which one is in use, so a mismatch fails
 * loudly at boot instead of 400ing on every request.
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

function withUid(endpoint, uid) {
	if (uid === undefined || uid === null || uid === '') {
		return endpoint;
	}
	return `${endpoint}${endpoint.includes('?') ? '&' : '?'}_uid=${encodeURIComponent(uid)}`;
}

function createClient({ url, apiToken, uid, bridgeUid, authMode: mode = 'user' }) {
	const base = `${url}/api/v3`;
	let authMode = mode === 'master' ? 'master' : 'user';
	// Accept either key name: config.js names it `bridgeUid`, callers may pass `uid`.
	let actorUid = uid === undefined || uid === null || uid === '' ? (bridgeUid || '') : uid;

	// master tokens require _uid; a missing one is a hard config error
	if (authMode === 'master' && (actorUid === '' || actorUid === undefined)) {
		throw new Error('NODEBB_AUTH_MODE=master requires NODEBB_BRIDGE_UID to be set');
	}

	// v3 wraps every response as `{ status, response }`. Callers want the payload,
	// so unwrap here - otherwise `res.categories` is always undefined and a
	// missing-key bug looks like an API failure.
	function call(method, endpoint, body) {
		const full = authMode === 'master' ? withUid(endpoint, actorUid) : endpoint;
		return request(method, `${base}${full}`, { token: apiToken, body })
			.then((res) => (res && typeof res === 'object' && 'response' in res ? res.response : res));
	}

	return {
		get authMode() {
			return authMode;
		},

		get actorUid() {
			return actorUid;
		},

		// Fails loudly if the token flavour and _uid handling disagree.
		async probe() {
			await call('GET', '/categories');
			return { authMode, actorUid };
		},

		raw: (method, endpoint, body) => call(method, endpoint, body),

		// GET <url>/api/imrnes-ranks/levels - public, unauthenticated, cached by
		// the forum. Registered by the rank plugin, so it 404s if the plugin is
		// missing; callers must fall back to the built-in ladder.
		getRankLadder: () => request('GET', `${url}/api/imrnes-ranks/levels`, {}),

		// GET /api/v3/config
		getConfig: () => call('GET', '/config'),

		// Resolve a category by slug.
		//
		// The v3 `?slug=` query parameter is IGNORED by NodeBB - it always returns
		// every category - so filter client-side. Stored slugs are `cid/name`
		// (e.g. `2/general-discussion`), so match the trailing segment too.
		async getCategoryBySlug(slug) {
			const wanted = String(slug || '').trim().toLowerCase();
			const res = await call('GET', '/categories');
			const categories = (res && res.categories) || [];
			if (!wanted) {
				return { categories };
			}
			const matched = categories.filter((c) => {
				const full = String(c.slug || '').toLowerCase();
				const tail = full.split('/').pop();
				return full === wanted || tail === wanted;
			});
			return { categories: matched };
		},

		// GET /api/v3/categories/<cid>/topics?start=&stop=
		//
		// Both start AND stop are required: omitting stop returns zero topics,
		// which looks exactly like "this category is empty".
		// GET /api/v3/topics/<tid>
		getTopic: (tid) => call('GET', `/topics/${encodeURIComponent(tid)}`),

		/**
		 * Posts of a topic, as RAW stored HTML.
		 *
		 * There is NO v3 endpoint for this - `src/routes/write/topics.js` registers
		 * only `/:tid`, `/:tid/thumbs`, `/:tid/events`, `/:tid/crossposts`, and
		 * `write/posts.js` only exposes a single `/:pid`. So the list has to come
		 * from v1 (`GET /api/topic/<tid>`) - but v1 WRAPS the body in
		 * `<p dir="auto">...</p>` and HTML-ESCAPES it:
		 *
		 *     stored:  <p>hello</p><!-- discord-bridge -->
		 *     v1 says: <p dir="auto">&lt;p&gt;hello&lt;/p&gt;&lt;!-- ... --&gt;</p>
		 *
		 * Two consequences, both of which broke the bridge:
		 *   1. an HTML-comment marker check can never match over v1;
		 *   2. stripping tags to make Discord text leaves `&lt;p&gt;hello`.
		 *
		 * So: read the pid list from v1 (it is trustworthy - only the body is
		 * mangled), then re-fetch each post through v3 `GET /api/v3/posts/<pid>`,
		 * which returns the stored value untouched. Small N (a bridge topic is a
		 * handful of posts) so the extra requests are cheap.
		 */
		async getTopicPosts(tid) {
			const endpoint = `/api/topic/${encodeURIComponent(tid)}`;
			const full = authMode === 'master' ? withUid(endpoint, actorUid) : endpoint;
			const listing = await request('GET', `${url}${full}`, { token: apiToken });
			const pids = (listing && listing.posts ? listing.posts : []).map((p) => p.pid);
			if (!pids.length) {
				return { posts: [] };
			}
			const posts = await Promise.all(pids.map(async (pid) => {
				try {
					const post = await call('GET', `/posts/${encodeURIComponent(pid)}`);
					return Object.assign({ pid }, post);
				} catch (err) {
					// a single unreadable post must not break the whole poll
					return null;
				}
			}));
			return { posts: posts.filter(Boolean) };
		},

		// POST /api/v3/topics  { cid, title, content, uid }
		createTopic: ({ cid, title, content }) => {
			const payload = { cid, title, content, tags: [] };
			if (authMode === 'master') {
				payload._uid = actorUid;
			}
			return call('POST', '/topics', payload);
		},

		// POST /api/v3/topics/<tid> { content, _uid }
		//
		// NOT `/topics/<tid>/posts` - that path does not exist and answers 404
		// "Invalid API call". src/routes/write/topics.js registers the reply as
		// `post /:tid` on the topics router, so the reply URL is the topic URL.
		replyToTopic: (tid, { content }) => {
			const payload = { content };
			if (authMode === 'master') {
				payload._uid = actorUid;
			}
			return call('POST', `/topics/${encodeURIComponent(tid)}`, payload);
		},

		// GET /api/v3/posts/<pid>  -> RAW html, comments intact.
		//
		// Prefer this over v1's topic payload for marker detection: v1 renders the
		// post for display and HTML-escapes it, so `<!-- channel:x -->` arrives as
		// `&lt;!-- channel:x --&gt;` and any comment-based marker search silently
		// fails. v3 returns the stored value untouched.
		getPost: (pid) => call('GET', `/posts/${encodeURIComponent(pid)}`),

		/**
		 * Topics in a category.
		 *
		 * `lastposttime` is MILLISECONDS in the v3 write API (not seconds, unlike
		 * some v1 fields), and `user` carries the author's username for the
		 * thread intro. Both start and stop are required.
		 */
		listCategoryTopics: (cid, { from = 0, to = 50 } = {}) =>
			call('GET', `/categories/${encodeURIComponent(cid)}/topics?start=${from}&stop=${to}`),

		// GET /api/v3/users/<uid>
		getUser: (uid) => call('GET', `/users/${encodeURIComponent(uid)}`),

		// GET /api/v3/users/username/<username>  -> resolved user object
		getUserByUsername: (username) =>
			call('GET', `/users/username/${encodeURIComponent(username)}`),
	};
}

module.exports = { createClient, NodebbError, withUid };
