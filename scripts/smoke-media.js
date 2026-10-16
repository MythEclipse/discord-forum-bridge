'use strict';
// Regression tests for the media render shapes.
//
// The point of these is NOT "the code runs" - it is that each of the four
// attachment kinds produces the markdown text the forum will actually render.
// Two of them (<video>/<audio>) only survive NodeBB because `settings:markdown`
// holds {"html":"on"}; if that setting is ever reverted, markdown-it will escape
// them into visible text, so the tag-presence assertions here are the tripwire.
const assert = require('assert');
const t = require('../src/text');
const { forumPostMarkdown, mediaKind, contentKind, absolutiseImages } = t;

let passed = 0;
const check = (name, fn) => {
	try {
		fn();
		passed += 1;
		console.log('  ✔ ' + name);
	} catch (err) {
		console.log('  ✘ ' + name);
		console.log('      ' + err.message);
		process.exitCode = 1;
	}
};

const img = { url: 'http://f/assets/uploads/files/1-photo.png', name: 'photo.png', kind: 'image' };
const vid = { url: 'http://f/assets/uploads/files/2-clip.mp4', name: 'clip.mp4', kind: 'video' };
const aud = { url: 'http://f/assets/uploads/files/3-sound.mp3', name: 'sound.mp3', kind: 'audio' };
const doc = { url: 'http://f/assets/uploads/files/4-paper.pdf', name: 'paper.pdf' };

check('image renders as a markdown image, not a player', () => {
	const md = forumPostMarkdown({ nickname: 'N', content: 'hi', attachments: [img] });
	assert.ok(md.includes('![photo.png]'), 'markdown image missing');
	assert.ok(!md.includes('<video'), 'image became a video tag');
});

check('video renders a <video controls> player', () => {
	const md = forumPostMarkdown({ nickname: 'N', content: 'hi', attachments: [vid] });
	assert.ok(md.includes('<video controls'), 'no <video controls>');
	assert.ok(md.includes('2-clip.mp4'), 'video src missing');
	assert.ok(!md.includes('!['), 'video wrongly became a markdown image');
});

check('audio renders an <audio controls> player', () => {
	const md = forumPostMarkdown({ nickname: 'N', content: 'hi', attachments: [aud] });
	assert.ok(md.includes('<audio controls'), 'no <audio controls>');
	assert.ok(!md.includes('!['), 'audio wrongly became a markdown image');
});

check('an unknown file type stays a plain link (never a broken thumb)', () => {
	const md = forumPostMarkdown({ nickname: 'N', content: 'hi', attachments: [doc] });
	assert.ok(md.includes('[paper.pdf'), 'expected a plain link');
	assert.ok(!md.includes('<video') && !md.includes('!['), 'unknown type got a player');
});

check('all four kinds in one post each keep their own shape', () => {
	const md = forumPostMarkdown({ nickname: 'N', content: 'hi', attachments: [img, vid, aud, doc] });
	assert.ok(md.includes('![') && md.includes('<video') && md.includes('<audio') && md.includes('[paper.pdf'));
});

check('a sticker (isImage, animated gif) stays an image so it animates', () => {
	const sticker = { url: 'http://f/assets/uploads/files/5-sticker.gif', name: 'sticker.gif', isImage: true, kind: 'image' };
	const md = forumPostMarkdown({ nickname: 'N', content: ':sticker:', attachments: [sticker] });
	assert.ok(md.includes('![sticker.gif]'), 'sticker not an inline image');
	assert.ok(!md.includes('<video'), 'sticker became a player');
});

check('contentKind maps discord content-types, ignoring codecs', () => {
	assert.strictEqual(contentKind('image/gif'), 'image');
	assert.strictEqual(contentKind('video/mp4'), 'video');
	assert.strictEqual(contentKind('audio/ogg; codecs=opus'), 'audio');
	assert.strictEqual(contentKind('application/pdf'), '');
	assert.strictEqual(contentKind(undefined), '');
});

check('mediaKind falls back to the extension when no kind was given', () => {
	assert.strictEqual(mediaKind({ url: '/x/a.mp4' }), 'video');
	assert.strictEqual(mediaKind({ url: '/x/a.mp3' }), 'audio');
	assert.strictEqual(mediaKind({ url: '/x/a.gif' }), 'image');
	assert.strictEqual(mediaKind({ url: '/x/a.bin' }), 'other');
});

check('an explicit kind wins over a lying extension', () => {
	assert.strictEqual(mediaKind({ url: '/x/a.png', kind: 'video' }), 'video');
});

check('absolutiseImages rewrites a relative player src too', () => {
	t.setForumUrl('https://forum.imrnes.team');
	const out = absolutiseImages('<video controls src="/assets/uploads/files/2-clip.mp4"></video>');
	assert.ok(out.includes('src="https://forum.imrnes.team/assets/uploads/files/2-clip.mp4'), out);
});

check('absolutiseImages leaves an already-absolute src alone', () => {
	t.setForumUrl('https://forum.imrnes.team');
	const src = '<audio controls src="https://cdn.example/s.mp3"></audio>';
	assert.strictEqual(absolutiseImages(src), src);
});

check('absolutiseImages still leaves protocol-relative urls alone', () => {
	t.setForumUrl('https://forum.imrnes.team');
	const src = '<video src="//cdn.example/v.mp4"></video>';
	assert.strictEqual(absolutiseImages(src), src);
});

console.log('  ' + passed + ' passed' + (process.exitCode ? ', WITH FAILURES' : ''));
