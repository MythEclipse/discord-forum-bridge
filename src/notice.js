'use strict';

/**
 * Policy for the "this discussion is now on the forum" confirmation, and for the
 * link previews that Discord generates on the bridge's own messages.
 *
 * WHY THE CONFIRMATION LOOKED TWICE AS BAD AS IT WAS
 *
 * The real notification the user reported:
 *
 *     forum.imrnes.team APP
 *     :white_check_mark: Diskusi ini sekarang ada di forum: <url>
 *     bridge-imrnes (@bridge-imrnes@forum.imrnes.team)
 *     ken memulai diskusi ini dari Discord.
 *     ken memulai diskusi ini dari Discord.
 *
 * The message itself contains ONE line. The repeated sentence came from Discord
 * UNFURLING the forum url inside it: NodeBB's `og:title` and `og:description` for
 * a topic both carry the first post's text, so a single card renders that sentence
 * as both the title and the description. To a reader the whole thing looks like
 * duplicated spam. Verified against the live API, not inferred:
 *
 *     content     : ":white_check_mark: Diskusi ini sedang ada di forum: <url>"
 *     embed.type  : "rich"
 *     embed.title : "ken memulai diskusi ini dari Discord."
 *     embed.desc  : "**ken** memulai diskusi ini dari Discord\\."
 *
 * So suppressing the unfurl is part of the fix, not a cosmetic extra: removing the
 * message alone would leave the same preview on every other bridge message that
 * links back to the forum.
 *
 * The flags are numeric Discord bitfields, verified against the live API rather
 * than trusted from documentation - SUPPRESS_EMBEDS is marked deprecated in some
 * API revisions, so a live PATCH was used to prove it still takes effect (it did:
 * `flags=4` removed the embed while leaving `content` byte-identical).
 *
 * DON'T apply SUPPRESS_EMBEDS to a mirrored forum post. It is NOT selective: a live
 * test on a message whose previews were `image,rich` removed BOTH. Discord renders a
 * markdown `![](url)` as an embed of type 'image', so suppressing embeds there would
 * silently delete every mirrored image from Discord - the text would remain but the
 * picture would be gone, with no error anywhere. That is why suppression is limited
 * to the two generated messages whose only link points back at the forum (the notice
 * and the thread starter); mirrored posts keep their previews untouched.
 *
 * Also note that the flag is NOT retroactively reversible in the way one would
 * expect: PATCHing `flags: 0` back does not re-unfurl the link. Re-PATCHing the
 * identical content does, which is how the probe's two test messages were restored.
 */

// MessageFlags bitfields. Kept numeric so this module needs no discord.js import
// and stays unit-testable without a gateway connection.
//
//   SUPPRESS_EMBEDS        = 1 << 2  = 4
//   SUPPRESS_NOTIFICATIONS = 1 << 12 = 4096
const SUPPRESS_EMBEDS = 1 << 2;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

/**
 * The intro posted as the first message of a thread created from a forum topic.
 *
 * It is ALWAYS embed-suppressed, with no opt-out, because its only link points at
 * the very topic being announced: the unfurl can only ever restate what the
 * message already says. Nothing is lost, and the duplicate-looking card is the
 * exact artefact that was reported.
 */
const INTRO_FLAGS = SUPPRESS_EMBEDS;

/**
 * Decide whether the confirmation is posted, and how.
 *
 *   off    - never posted. The thread is still adopted onto the forum; the reader
 *            is simply not told about it in-channel. This is the default: the
 *            confirmation is a nicety, and the forum topic is created either way.
 *   silent - posted, but with SUPPRESS_NOTIFICATIONS so it raises no notification
 *            badge, ping or push. Still readable by scrolling to it.
 *   on     - posted normally.
 *
 * SUPPRESS_EMBEDS applies to both posted modes. Unknown values fall back to 'off'
 * so a typo in .env cannot resurrect the notification the user asked to remove.
 *
 * @param {string} mode 'off' | 'silent' | 'on'
 * @returns {{send: boolean, flags: number, mode: string}}
 */
function noticePlan(mode) {
	const normalized = String(mode || 'off').trim().toLowerCase();
	if (normalized !== 'silent' && normalized !== 'on') {
		return { send: false, flags: 0, mode: 'off' };
	}
	return {
		send: true,
		flags: SUPPRESS_EMBEDS | (normalized === 'silent' ? SUPPRESS_NOTIFICATIONS : 0),
		mode: normalized,
	};
}

module.exports = {
	noticePlan, INTRO_FLAGS, SUPPRESS_EMBEDS, SUPPRESS_NOTIFICATIONS,
};
