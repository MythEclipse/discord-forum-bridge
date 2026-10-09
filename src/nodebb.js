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
const crypto = require('crypto');
const { URL } = require('url');

class NodebbError extends Error {
	constructor(status, body, url) {
		super(`NodeBB ${status} ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
		this.name = 'NodebbError';
		this.status = status;
		this.body = body;
	}
}

function request(method, url, { token, body, contentType, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const lib = target.protocol === 'http:' ? http : https;
		// A Buffer body is already encoded (multipart uploads); anything else is
		// JSON. `payload.length` is only valid on a Buffer, which is why this must
		// not go through JSON.stringify unconditionally.
		const payload = body === undefined || body === null
			? null
			: (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
		const type = contentType || 'application/json';
		const req = lib.request({
			method: method,
			hostname: target.hostname,
			port: target.port || (target.protocol === 'http:' ? 80 : 443),
			path: `${target.pathname}${target.search}`,
			headers: Object.assign({
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			}, payload ? {
				'Content-Type': type,
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

		/**
		 * Fetch an absolute URL as raw bytes.
		 *
		 * Discord CDN attachment links are unauthenticated and expire, so the
		 * bytes must be pulled while the message is being handled rather than
		 * stored. Returns a Buffer; JSON is NOT attempted, because the caller
		 * wants to forward the bytes verbatim to the forum's upload endpoint.
		 */
		downloadBinary(absoluteUrl) {
			return new Promise((resolve, reject) => {
				let target;
				try {
					target = new URL(absoluteUrl);
				} catch (err) {
					return reject(err);
				}
				const lib = target.protocol === 'http:' ? http : https;
				const req = lib.request({
					method: 'GET',
					hostname: target.hostname,
					port: target.port || (target.protocol === 'http:' ? 80 : 443),
					path: `${target.pathname}${target.search}`,
					headers: { Accept: '*/*' },
				}, (res) => {
					// One redirect hop is enough for Discord's CDN.
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
						res.resume();
						return resolve(this.downloadBinary(new URL(res.headers.location, absoluteUrl).toString()));
					}
					const chunks = [];
					res.on('data', (c) => chunks.push(c));
					res.on('error', reject);
					res.on('end', () => {
						if (res.statusCode >= 400) {
							return reject(new NodebbError(res.statusCode, 'binary download failed', absoluteUrl));
						}
						return resolve(Buffer.concat(chunks));
					});
				});
				req.on('error', reject);
				req.end();
			});
		},

		// POST <url>/api/v3/bridge-upload  (multipart/form-data, field `files[]`)
		//
		// NodeBB's Write API v3 has NO upload endpoint - `src/api/files.js` only
		// exposes `delete` and `createFolder`, and the `PUT /api/v3/files` route
		// is commented out in `src/routes/write/files.js`. The only other route,
		// `POST /api/post/upload`, cannot be driven by an API token at all: it has
		// no `authenticateRequest` in its chain, so `req.uid` is always 0 and
		// `privileges.global.can('upload:post:image', 0)` fails -> 403.
		//
		// `nodebb-plugin-bridge-upload` supplies an authenticated route built with
		// `routeHelpers.setupApiRoute`, which does include `authenticateRequest`.
		//
		// Written as a raw multipart body because the client has no dependency and
		// NodeBB expects the literal field name `files[]`.
		uploadAttachment(buffer, filename, { asUid, contentType } = {}) {
			const target = authMode === 'master' ? withUid('/bridge-upload', asUid || actorUid) : '/bridge-upload';
			const boundary = `----hermesbridge${Date.now().toString(16)}${crypto.randomBytes(6).toString('hex')}`;
			const name = String(filename || 'upload.bin').replace(/["\\\r\n]/g, '_');
			const head = Buffer.from(
				`--${boundary}\r\n`
				+ `Content-Disposition: form-data; name="files[]"; filename="${name}"\r\n`
				+ `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`,
				'utf8'
			);
			const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
			return request('POST', `${base}${target}`, {
				token: apiToken,
				body: Buffer.concat([head, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ''), tail]),
				contentType: `multipart/form-data; boundary=${boundary}`,
			}).then((res) => {
				const payload = (res && typeof res === 'object' && 'response' in res) ? res.response : res;
				const image = payload && Array.isArray(payload.images) ? payload.images[0] : null;
				if (!image || !image.url) {
					throw new NodebbError(502, res, `${url}/api/v3/bridge-upload`);
				}
				return {
					url: `${url}${image.url}`,
					name: image.name || name,
				};
			});
		},

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
		/**
		 * All posts of a topic, newest included.
		 *
		 * PAGINATION IS NOT OPTIONAL. `GET /api/topic/<tid>` returns one page
		 * (`postsPerPage`, 15 by default) and its `page` parameter is 1-BASED, so
		 * `?page=2` is the SECOND page. Reading only the default page silently
		 * caps the bridge at the first 15 posts of a topic: with a cursor past
		 * that, every later post - including anything with an image - is
		 * invisible forever, with no error anywhere. That is exactly how a GIF
		 * posted as reply 47 "never reached" Discord.
		 *
		 * v1 is still the right source for the pid LIST (v3 has no such route)
		 * and it reports how many pages exist, so walk to the end and stop as
		 * soon as a page comes back empty.
		 */
		async getTopicPosts(tid, { maxPages = 40 } = {}) {
			const endpoint = `/api/topic/${encodeURIComponent(tid)}`;
			const withPage = (page) => {
				const q = page ? `?page=${page}` : '';
				const full = authMode === 'master' ? withUid(`${endpoint}${q}`, actorUid) : `${endpoint}${q}`;
				return request('GET', `${url}${full}`, { token: apiToken });
			};

			const pids = [];
			const seen = new Set();
			for (let page = 1; page <= maxPages; page += 1) {
				// eslint-disable-next-line no-await-in-loop
				const listing = await withPage(page);
				const batch = (listing && listing.posts ? listing.posts : []);
				if (!batch.length) {
					break;
				}
				batch.forEach((p) => {
					const pid = Number(p && p.pid);
					if (pid && !seen.has(pid)) {
						seen.add(pid);
						pids.push(pid);
					}
				});
			}
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
			// Ascending: the mirror walks the topic in order and the cursor is a
			// high-water mark over pids.
			return { posts: posts.filter(Boolean).sort((a, b) => Number(a.pid) - Number(b.pid)) };
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
		//
		// `asUid` impersonates a specific account so a Discord message is
		// attributed to the human's forum account instead of the bridge's, which
		// is what makes the ranks plugin award the badge for THIS post. It only
		// works with a master token; a per-user token falls back to the bridge
		// account. It is used for posting only, never for reads.
		replyToTopic: (tid, { content, asUid } = {}) => {
			const payload = { content };
			if (authMode === 'master') {
				payload._uid = asUid || actorUid;
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
