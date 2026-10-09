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

/**
 * Escape text so it survives a MARKDOWN render pass as literal text.
 *
 * The forum runs nodebb-plugin-markdown with `html: false`, so post content is
 * rendered by markdown-it and raw HTML is escaped into visible tags. Anything we
 * want to survive as TEXT must therefore be escaped for markdown, not HTML:
 * `htmlEscape("<b>")` becomes `&lt;b&gt;` which markdown-it then prints
 * literally as the characters `&lt;b&gt;`.
 */
function mdLiteral(text) {
	return String(text || '')
		// Backslash-escape every markdown metacharacter that markdown-it resolves
		// OUTSIDE a code span. Inside a code span the backslash is NOT consumed,
		// so escaping there would print a literal `\` to the reader.
		.replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, '\\$1');
}

/**
 * Escape a value for use inside a markdown CODE SPAN (`` `rank` ``).
 *
 * Only ` and \ matter there. Escaping anything else (brackets, underscores)
 * would survive as a visible backslash, because markdown-it does not process
 * escape sequences inside code spans - verified in-container:
 *   render('`[Appr\\entice]`') -> <code>[Appr\entice]</code>
 */
function mdCode(text) {
	return String(text || '').replace(/([\\`])/g, '\\$1');
}

/**
 * Build the markdown body for a Discord reply mirrored into a forum topic.
 *
 * Format notes, all forced by how the forum actually renders:
 *  - markdown, not HTML: nodebb-plugin-markdown has `html: false`, so HTML we
 *    send comes out escaped and double-wrapped in `<p dir="auto">`.
 *  - no `<span class="imrnes-rank">`: the ranks plugin already injects the badge
 *    next to the username via a theme patch, and NodeBB's sanitizer strips
 *    `class` anyway (sanitizeConfig has no allowedClasses), so a second badge
 *    in the body is both redundant and unstyleable.
 *  - the rank is kept as a bold line so it still reads as a label in the post
 *    body, in the thread view and in e-mail notifications.
 */
function forumPostMarkdown({ nickname, rank, content, link }) {
	const lines = [];
	lines.push(`**${mdLiteral(nickname)}**`);
	if (rank) {
		lines.push('', `\`${mdCode(rank)}\``);
	}
	const body = String(content || '').trim();
	if (body) {
		// Quote lines so the mirrored message is visually attributed to Discord.
		// Discord's own `>` quoting becomes a blockquote, matching the old HTML.
		lines.push('', body.split('\n').map((l) => `> ${mdLiteral(l)}`).join('\n'));
	}
	if (link) {
		lines.push('', `[Lihat di Discord](${link.replace(/[()]/g, encodeURIComponent)})`);
	}
	// The marker must stay an HTML comment: the markdown-it `html: false` path
	// escapes `<!-- -->` to `&lt;!-- --&gt;` in stored content, and text.js
	// htmlToPlainText() strips both the real and the escaped form.
	lines.push('', MARKER);
	return lines.join('\n');
}

module.exports = {
	MARKER, htmlEscape, mdEscape, mdLiteral, mdCode, webhookSafe, htmlToPlainText, forumPostMarkdown,
};