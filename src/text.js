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
		// `<b`, `<i`, `<em`, `<a`, `<code` ... WITHOUT a word boundary match
		// `<img>`, `<iframe>`, `<input>` and friends: `<i[^>]*>` happily consumes
		// a whole `<img src=... />` and leaves a bare `*` behind. That is why the
		// image disappeared from the Discord mirror with no error anywhere.
		// `\b` after the tag name is the fix; the closing forms need it too so
		// `</i>` never eats something else.
		.replace(/<em\b[^>]*>/gi, '*')
		.replace(/<\/em\s*>/gi, '*')
		.replace(/<i\b[^>]*>/gi, '*')
		.replace(/<\/i\s*>/gi, '*')
		.replace(/<code[^>]*>/gi, '`')
		.replace(/<\/code>/gi, '`')
		.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
		// <img> must become a markdown image, and the attribute ORDER matters:
		// NodeBB/markdown-it emits `<img class="..." alt="..." src="...">` with
		// `src` LAST, so a `src="..."[^>]*` pattern never matches and the tag
		// falls through to the generic stripper, leaving a bare `*` (from the
		// `<em>` rule) where the image was. Match the attributes independently
		// of their order instead.
		//
		// The result is markdown `![alt](url)` because Discord renders that
		// inline; a bare URL shows up as a wall of unclickable text, and an
		// upload the user cannot see is the same as a dropped upload.
		.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
			const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs);
			if (!src || !src[1]) {
				return '';
			}
			const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs);
			return `\n![${mdLiteral(alt ? alt[1] : 'image')}](${src[1].replace(/[()]/g, encodeURIComponent)})\n`;
		})
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
	 * Direction matters here. Forum -> Discord renders the rank as a label
	 * because Discord has no plugin that can style an author's badge. The
	 * reverse direction must NOT: the forum already injects a styled badge next
	 * to the username via the ranks plugin theme patch, and NodeBB's sanitizer
	 * strips `class`, so a rank in the body would be an unstyled duplicate of
	 * a badge the theme already draws. Worse, the rank is attributed to the
	 * posting account, so a body rank shows the BRIDGE's rank, not the human's.
	 *
	 * The human's identity travels instead, as a plain markdown line that
	 * survives the markdown render pass:
	 *   **Name** *(via Discord)* — followed by the quoted message and link.
	 *
	 * @param {object}  opts
	 * @param {string}  opts.nickname  author's display name on Discord
	 * @param {string}  [opts.rank]    omitted for Discord -> forum on purpose
	 * @param {string}  opts.content   the Discord message
	 * @param {string}  [opts.link]    permalink back to the Discord message
	 */
function forumPostMarkdown({ nickname, rank, content, link, attachments = [] }) {
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
	// Attachments are uploaded to the forum first (nodebb.js uploadAttachment), so
	// they arrive here as absolute forum URLs. Images get an inline markdown image
	// so they render inside the quoted block; anything else becomes a plain link,
	// because a markdown image of a video/audio file renders as a broken thumb.
	if (attachments.length) {
		lines.push('');
		attachments.forEach((att) => {
			const href = String(att.url || '').replace(/[()]/g, encodeURIComponent);
			if (/\.(png|jpe?g|gif|webp|bmp|avif)(?:$|[?#])/i.test(href) || att.isImage) {
				lines.push(`![${mdLiteral(att.name || 'gambar')}](${href})`);
			} else {
				lines.push(`[${mdLiteral(att.name || 'lampiran')}: ${href}](${href})`);
			}
		});
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