'use strict';

/**
 * Forum -> Discord identity mapping.
 *
 * A Discord user is linked to a forum account when ANY of these are true, in
 * order:
 *   1. a Discord nickname that matches a forum username (case-insensitive),
 *   2. an explicit link row in data/links.json,
 *   3. a forum `bridgeUsername` claim on the linked account.
 *
 * The resolved rank title comes from the forum's own rank plugin ladder so a
 * level change in ACP is reflected here without redeploying the bridge.
 */

const fs = require('fs');
const path = require('path');

const LINKS_PATH = path.join(__dirname, '..', 'data', 'links.json');

// Fallback ladder MUST mirror the forum's real thresholds. Using the array
// index as `min` would promote a 1-post user straight to [Apprentice].
const DEFAULT_MIN = [
	0, 5, 20, 50, 100, 200, 350, 550, 800, 1150, 1550,
	2050, 2650, 3350, 4150, 5050, 6050, 7150, 8350, 9650, 11050,
];

const DEFAULT_NAMES = [
	'[Neophyte]', '[Apprentice]', '[Pathfinder]', '[Seeker]', '[Visionary]',
	'[Voyager]', '[Adept]', '[Hacker]', '[Mage]', '[Wizard]', '[Master]',
	'[Guru]', '[Legend]', '[Guardian]', '[TITAN]', '[SAGE]', '[VANGUARD]',
	'[ASCENDED]', '[DEITY]', '[MYTHIC]', '[IMMORTAL]',
];

const DEFAULT_LADDER = DEFAULT_MIN.map((min, i) => ({ min, name: DEFAULT_NAMES[i] }));

function parseLadder(text) {
	if (!text || !String(text).trim()) {
		return null;
	}
	const parsed = String(text).split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split('|').map((p) => p.trim());
			const min = parseInt(parts[0], 10);
			if (parts.length < 2 || Number.isNaN(min) || !parts[1]) {
				return null;
			}
			return { min, name: parts[1] };
		})
		.filter(Boolean)
		.sort((a, b) => a.min - b.min);
	return parsed.length ? parsed : null;
}

function rankFor(ladder, postcount) {
	if (!ladder || !ladder.length) {
		return DEFAULT_NAMES[0];
	}
	let idx = 0;
	for (let i = 0; i < ladder.length; i++) {
		if (postcount >= ladder[i].min) {
			idx = i;
		}
	}
	return ladder[idx].name;
}

function normaliseHandle(value) {
	return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

class IdentityStore {
	constructor({ ladderText = '' } = {}) {
		this.ladder = parseLadder(ladderText) || DEFAULT_LADDER;
		this.byDiscordId = new Map();
		this.load();
	}

	load() {
		if (!fs.existsSync(LINKS_PATH)) {
			return;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(LINKS_PATH, 'utf8'));
			(raw.links || []).forEach((link) => {
				if (link && link.discordId && link.username) {
					this.byDiscordId.set(String(link.discordId), link);
				}
			});
		} catch (err) {
			// a corrupt links file must not stop the service
		}
	}

	save() {
		const dir = path.dirname(LINKS_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(LINKS_PATH, JSON.stringify({
			links: Array.from(this.byDiscordId.values()),
		}, null, 2));
	}

	setLink(discordId, link) {
		this.byDiscordId.set(String(discordId), Object.assign({}, this.byDiscordId.get(String(discordId)), link));
		this.save();
	}

	findByDiscordId(discordId) {
		return this.byDiscordId.get(String(discordId)) || null;
	}

	findByUsername(username) {
		const handle = normaliseHandle(username);
		if (!handle) {
			return null;
		}
		for (const link of this.byDiscordId.values()) {
			if (normaliseHandle(link.username) === handle) {
				return link;
			}
		}
		return null;
	}

	setLadder(ladderText) {
		const parsed = parseLadder(ladderText);
		if (parsed) {
			this.ladder = parsed;
		}
		return this.ladder;
	}

	rankTitleFor(postcount) {
		return rankFor(this.ladder, parseInt(postcount, 10) || 0);
	}

	forumAuthor(postcount) {
		return `Discord Bridge Bot | postcount: ${parseInt(postcount, 10) || 0}`;
	}
}

module.exports = { IdentityStore, parseLadder, rankFor, normaliseHandle, DEFAULT_LADDER, DEFAULT_NAMES };
