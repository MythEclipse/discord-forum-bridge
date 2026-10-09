'use strict';

/**
 * Text conversion between forum HTML and Discord markdown.
 *
 * Split into its own module so both the text channel bridge and the forum-mode
 * bridge use identical escaping rules, and so the rules are unit-testable
 * without any network or Discord connection.
 */

const MARKER = '<!-- imrnes-bridge -->';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function htmlEscape(text) {
	return String(text || '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Escape only what would break Discord markdown formatting. */
function mdEscape(text) {
	return String(text || '')
		.replace(/([\\*_~|])/g, '\\$1')
		.replace(/^>/gm, '\\>');
}

/** Discord webhook names allow a limited charset, so sanitise. */
function webhookSafe(name) {
	return String(name || 'Forum user').replace(/[^\w .\-]/g, '').slice(0, 80) || 'Forum user';
}

/**
 * Forum HTML -> plain Discord markdown.
 *
 * HTML comments are stripped FIRST. That ordering matters: NodeBB's v1 read API
 * returns a body wrapped in `<p dir="auto">` with the real markup escaped
 * inside, so `<p dir="auto">&lt;p&gt;hi&lt;/p&gt;&lt;!-- m --&gt;</p>` contains
 * no genuine tags at all. Stripping comments before tags is what keeps the
 * bridge marker from leaking into user-visible text.
 */
function htmlToPlainText(html) {
	return String(html || '')
		// Comments are stripped twice on purpose: once as real tags, and once in
		// their ESCAPED form. NodeBB's v1 read path wraps the body in
		// `<p dir="auto">` and escapes the real markup, so a marker can arrive as
		// `&lt;!-- imrnes-bridge --&gt;` and a real-tag-only regex lets it through.
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/&lt;!--[\s\S]*?--&gt;/gi, '')
		// Entities are decoded BEFORE the structural rules, not after. Decoding
		// last would turn `&lt;p&gt;hi&lt;/p&gt;` into the literal text `<p>hi</p>`
		// AFTER the tag-stripping pass already ran, leaving raw tags in the output.
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		// Structural rules run on decoded text now.
		.replace(/<blockquote[^>]*>/gi, '> ')
		.replace(/<\/blockquote>/gi, '\n\n')
		.replace(/<br\s*\/?>/gi, '\n')
		// A closing </li> becomes a newline too, otherwise list items run together.
		.replace(/<li[^>]*>/gi, '\n- ')
		.replace(/<\/li>/gi, '')
		.replace(/<strong[^>]*>/gi, '**')
		.replace(/<\/strong>/gi, '**')
		.replace(/<b[^>]*>/gi, '**')
		.replace(/<\/b>/gi, '**')
		.replace(/<em[^>]*>/gi, '*')
		.replace(/<\/em>/gi, '*')
		.replace(/<i[^>]*>/gi, '*')
		.replace(/<\/i>/gi, '*')
		.replace(/<code[^>]*>/gi, '`')
		.replace(/<\/code>/gi, '`')
		.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
		.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '\n$1\n')
		.replace(/<\/?(?:p|div|h[1-6]|ul|ol|table|tr)[^>]*>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

module.exports = { MARKER, htmlEscape, mdEscape, webhookSafe, htmlToPlainText };