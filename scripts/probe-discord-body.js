#!/usr/bin/env node
'use strict';

/**
 * Live probe: render a Discord reply with the REAL forumPostMarkdown() builder,
 * post it through the real Write API, then read it back both raw (v3) and
 * rendered (v1) so the two can be compared.
 *
 * The v1 read path is what a browser actually displays, so it is the only way to
 * prove the body is formatted rather than shown as escaped tag text.
 */

const https = require('https');
const { forumPostMarkdown } = require('../src/text');

const env = Object.fromEntries(
	require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
		.split('\n').filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
		.map((l) => {
			const i = l.indexOf('=');
			// .env values may be quoted; dotenv strips them, a naive split does not.
			return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
		}),
);

const tid = process.argv[2] || '1';
const body = forumPostMarkdown({
	nickname: 'Arima OSCP',
	rank: '[Neophyte]',
	content: 'uji format discord -> forum\nbaris kedua **bold** dan <script>x</script>',
	link: 'https://discord.com/channels/1450861658061803624/1557932678362169375/1557939999999999999',
});

console.log('=== BODY WE SEND ===');
console.log(body);

function call(method, route, payload) {
	return new Promise((resolve, reject) => {
		const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
		const req = https.request(
			`${env.NODEBB_URL}${route}`,
			{
				method,
				headers: Object.assign({
					Authorization: `Bearer ${env.NODEBB_API_TOKEN}`,
				}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
			},
			(res) => {
				let buf = '';
				res.on('data', (c) => { buf += c; });
				res.on('end', () => {
					try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`${method} ${route} -> ${res.statusCode}: ${buf.slice(0, 200)}`)); }
				});
			},
		);
		req.on('error', reject);
		if (data) { req.write(data); }
		req.end();
	});
}

(async () => {
	const res = await call('POST', `/api/v3/topics/${tid}`, {
		_uid: env.NODEBB_BRIDGE_UID || 12, content: body,
	});
	const pid = res.response.pid;
	console.log('\n=== STORED RAW (v3) ===');
	console.log(res.response.content);
	console.log('pid:', pid);

	// v1 is the path a browser renders; its content is what the user sees.
	const v1 = await call('GET', `/api/topic/${tid}?_uid=${env.NODEBB_BRIDGE_UID || 12}`);
	const rendered = (v1.posts || []).find((p) => p.pid === pid);
	console.log('\n=== RENDERED (v1, what a browser shows) ===');
	console.log(rendered && rendered.content);
})().catch((err) => {
	console.error('PROBE FAILED', err.message);
	process.exit(1);
});