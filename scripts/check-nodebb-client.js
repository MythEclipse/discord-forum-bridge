'use strict';

/**
 * Unit tests for the NodeBB v3 client that the forum smoke tests cannot reach.
 *
 * `scripts/smoke-forum.js` stubs the whole client out, so the parts that decide
 * WHICH forum data the bridge even sees have no coverage there. `getTopicPosts`
 * is the worst offender: it silently read only the first page of a topic, which
 * made every post past `postsPerPage` invisible with no error anywhere.
 *
 * These tests drive `createClient` against a fake HTTP layer by pointing it at a
 * local server, so the real request/response plumbing (URL building, `_uid`
 * handling, Buffer bodies) is exercised too.
 *
 * Run: npm run check:client
 */

const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/nodebb');

const tests = [];
function test(name, fn) {
	tests.push({ name, fn });
}

/** Boot a throwaway server that answers from `routes`. */
async function withServer(routes, fn) {
	const server = http.createServer((req, res) => {
		const handler = routes[req.url.split('?')[0]];
		if (!handler) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status: { code: 'not-found' }, response: {} }));
			return;
		}
		handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	try {
		return await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

function json(res, payload, code = 200) {
	res.writeHead(code, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

/* ── getTopicPosts pagination ───────────────────────────────────────────── */

test('getTopicPosts walks EVERY page, not just the first', async () => {
	const seenPages = [];
	// Two full pages of 15, then an empty one - the shape of a topic whose posts
	// have run past `postsPerPage`.
	const routes = {
		'/api/topic/1': (req, res) => {
			const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
			seenPages.push(page);
			if (page === 1) {
				return json(res, { posts: Array.from({ length: 15 }, (_, i) => ({ pid: i + 1 })) });
			}
			if (page === 2) {
				return json(res, { posts: Array.from({ length: 15 }, (_, i) => ({ pid: i + 16 })) });
			}
			return json(res, { posts: [] });
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		// v3 has no "list posts of a topic", so each pid is re-fetched; serve them
		// from the same handler by short-circuiting in the test below.
		client.rawGet = null;
		const res = await client.getTopicPosts(1);
		assert.ok(res, 'returned a result');
	});

	// The route table above has no /api/v3/posts/<pid> entries, so posts resolve
	// to null; what matters is that all three pages were requested, proving the
	// client keeps paging until an empty page instead of stopping at the first.
	assert.deepStrictEqual(seenPages, [1, 2, 3], 'requested page 1, 2, then stopped at the empty page 3');
});

test('getTopicPosts stops at maxPages instead of looping forever', async () => {
	let calls = 0;
	const routes = {
		'/api/topic/1': (req, res) => {
			calls += 1;
			// never empty - a topic that keeps reporting posts
			json(res, { posts: [{ pid: calls }] });
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		await client.getTopicPosts(1, { maxPages: 5 });
	});
	assert.strictEqual(calls, 5, 'stopped at the caller-supplied page cap');
});

test('getTopicPosts returns posts in ascending pid order', async () => {
	const routes = {
		'/api/topic/9': (req, res) => json(res, {
			posts: [{ pid: 7 }, { pid: 3 }, { pid: 5 }],
		}),
		'/api/v3/posts/7': (req, res) => json(res, { response: { pid: 7, content: 'seven' } }),
		'/api/v3/posts/3': (req, res) => json(res, { response: { pid: 3, content: 'three' } }),
		'/api/v3/posts/5': (req, res) => json(res, { response: { pid: 5, content: 'five' } }),
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		const { posts } = await client.getTopicPosts(9);
		assert.deepStrictEqual(posts.map((p) => p.pid), [3, 5, 7], 'sorted oldest first');
		assert.strictEqual(posts[0].content, 'three', 'v3 raw content is carried through');
	});
});

test('getTopicPosts drops a pid that v3 cannot read instead of failing', async () => {
	const routes = {
		'/api/topic/4': (req, res) => json(res, { posts: [{ pid: 1 }, { pid: 2 }] }),
		'/api/v3/posts/1': (req, res) => json(res, { response: { pid: 1, content: 'ok' } }),
		'/api/v3/posts/2': (req, res) => json(res, {
			status: { code: 'not-found' }, response: {},
		}, 404),
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		const { posts } = await client.getTopicPosts(4);
		assert.deepStrictEqual(posts.map((p) => p.pid), [1], 'the readable post survives');
	});
});

/* ── master token semantics ─────────────────────────────────────────────── */

test('master mode sends _uid on every call', async () => {
	const seen = [];
	const routes = {
		'/api/v3/config': (req, res) => {
			seen.push(req.url);
			json(res, { response: { ok: true } });
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 4, authMode: 'master' });
		await client.getConfig();
	});
	assert.ok(seen[0].includes('_uid=4'), `expected _uid=4, got ${seen[0]}`);
});

test('v3 responses are unwrapped from the {status,response} envelope', async () => {
	const routes = {
		'/api/v3/config': (req, res) => json(res, {
			status: { code: 'ok', message: 'OK' }, response: { title: 'IMRNES' },
		}),
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		const cfg = await client.getConfig();
		assert.strictEqual(cfg.title, 'IMRNES', 'payload, not the envelope');
	});
});

/* ── binary download ────────────────────────────────────────────────────── */

test('downloadBinary returns raw bytes and does not JSON-parse them', async () => {
	const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
	const routes = {
		'/img.png': (req, res) => {
			res.writeHead(200, { 'Content-Type': 'image/png' });
			res.end(bytes);
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		const got = await client.downloadBinary(`${url}/img.png`);
		assert.ok(Buffer.isBuffer(got), 'a Buffer, not a parsed object');
		assert.deepStrictEqual(got, bytes, 'byte-for-byte');
	});
});

test('downloadBinary follows one redirect', async () => {
	const bytes = Buffer.from('GIF89a-real-bytes');
	const routes = {
		'/redir': (req, res) => {
			res.writeHead(302, { Location: '/final.gif' });
			res.end();
		},
		'/final.gif': (req, res) => {
			res.writeHead(200, { 'Content-Type': 'image/gif' });
			res.end(bytes);
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		const got = await client.downloadBinary(`${url}/redir`);
		assert.deepStrictEqual(got, bytes, 'followed the redirect');
	});
});

test('downloadBinary rejects on an error status', async () => {
	const routes = { '/gone': (req, res) => json(res, { error: 'nope' }, 404) };
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		await assert.rejects(() => client.downloadBinary(`${url}/gone`), /404/);
	});
});

/* ── multipart upload ───────────────────────────────────────────────────── */

test('uploadAttachment posts multipart with the files[] field', async () => {
	let captured = null;
	const routes = {
		'/api/v3/bridge-upload': (req, res) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				captured = { headers: req.headers, body: Buffer.concat(chunks) };
				json(res, {
					status: { code: 'ok' },
					response: { images: [{ url: '/assets/uploads/files/9-a.gif', name: 'a.gif' }] },
				});
			});
		},
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 'tok', uid: 12, authMode: 'master' });
		const out = await client.uploadAttachment(Buffer.from('GIF89a'), 'a.gif', {
			asUid: 4, contentType: 'image/gif',
		});
		assert.strictEqual(out.url, `${url}/assets/uploads/files/9-a.gif`, 'url is absolutised');
		assert.strictEqual(out.name, 'a.gif');
	});
	assert.ok(/^multipart\/form-data; boundary=/.test(captured.headers['content-type']),
		`content-type was ${captured.headers['content-type']}`);
	assert.ok(captured.headers['content-type'].includes('multipart'), 'not application/json');
	assert.ok(captured.body.includes('name="files[]"'), 'uses the literal field name NodeBB expects');
	assert.ok(captured.body.includes('filename="a.gif"'), 'carries the filename');
	assert.ok(captured.body.includes('GIF89a'), 'carries the bytes verbatim');
	assert.ok(captured.headers.authorization.includes('tok'), 'bearer token present');
});

test('uploadAttachment throws when the forum returns no image', async () => {
	const routes = {
		'/api/v3/bridge-upload': (req, res) => json(res, {
			status: { code: 'ok' }, response: { images: [] },
		}),
	};
	await withServer(routes, async (url) => {
		const client = createClient({ url, apiToken: 't', uid: 12, authMode: 'master' });
		await assert.rejects(() => client.uploadAttachment(Buffer.from('x'), 'a.png'), /502|bridge-upload/);
	});
});

/* ── runner ─────────────────────────────────────────────────────────────── */

(async () => {
	let failed = 0;
	for (const { name, fn } of tests) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await fn();
			console.log(`ok - ${name}`);
		} catch (err) {
			failed += 1;
			console.log(`FAIL - ${name}`);
			console.log(`      ${err.message}`);
		}
	}
	console.log(failed ? `\n${failed} CLIENT TEST(S) FAILED` : '\nALL NODEBB CLIENT TESTS PASSED');
	process.exit(failed ? 1 : 0);
})();
