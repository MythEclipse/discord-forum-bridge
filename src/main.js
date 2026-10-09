'use strict';

/**
 * Discord <-> forum.imrnes.team bridge (forum mode).
 *
 * One NodeBB topic in the bridged category becomes one Discord thread; every
 * reply in that thread becomes a forum post, and every new forum post becomes a
 * thread reply. Both directions carry the author's forum rank.
 *
 * Requires DISCORD_BOT_TOKEN (the Bot page in the Developer Portal). A client
 * secret cannot log a bot in - it only authorises OAuth2 grants.
 */

const { config, loadNodebbConfig } = require('./config');
const { createClient } = require('./nodebb');
const { DiscordTransport } = require('./discord-transport');
const { ForumMirror } = require('./forum-mirror');
const { IdentityStore } = require('./identity');
const log = require('./log');

async function main() {
	if (!config.discord.botToken) {
		log.error('DISCORD_BOT_TOKEN missing - Developer Portal -> your app -> Bot -> Reset Token');
		process.exit(1);
	}

	const nodebb = createClient(loadNodebbConfig());
	const identity = new IdentityStore();

	// Verify the forum credentials BEFORE connecting to Discord, so a bad forum
	// token fails fast with a forum error instead of a confusing Discord timeout.
	const probe = await nodebb.probe();
	log.info('nodebb api ready', { authMode: probe.authMode, uid: probe.actorUid });

	try {
		const ladder = await nodebb.getRankLadder();
		if (ladder && Array.isArray(ladder.levels) && ladder.levels.length) {
			identity.setLadder(ladder.levels);
			log.info('rank ladder loaded', { levels: identity.ladder.length });
		}
	} catch (err) {
		log.warn('rank ladder unavailable, using defaults', err.message);
	}

	const discord = new DiscordTransport(config);
	discord.onLog = (level, message, fields) => {
		const fn = log[level] || log.info;
		fn(message, fields);
	};

	const mirror = new ForumMirror({ nodebb, discord, config, identity, log });

	await discord.login();
	mirror.setBotUserId(discord.botUserId);
	log.info('discord ready', { tag: discord.client.user.tag, id: discord.botUserId });

	await mirror.start();

	// Every existing topic gets its thread, once. Set FORUM_BACKFILL=0 to skip.
	if (String(config.forum.backfill) !== '0') {
		await mirror.backfill();
	}

	const syncMs = config.behaviour.syncIntervalMs;
	const poll = setInterval(() => {
		mirror.pollOnce().catch((err) => log.warn('poll failed', err.message));
	}, syncMs);
	const ladderSync = setInterval(() => {
		nodebb.getRankLadder()
			.then((res) => {
				if (res && Array.isArray(res.levels) && res.levels.length) {
					identity.setLadder(res.levels);
					log.info('rank ladder refreshed', { levels: identity.ladder.length });
				}
			})
			.catch((err) => log.warn('rank ladder refresh failed', err.message));
	}, config.behaviour.raceSyncIntervalMs);

	log.info('bridge running', {
		channel: config.discord.channelId, cid: mirror.cid, mode: mirror.mode, syncMs,
	});

	discord.client.on('messageCreate', async (message) => {
		try {
			if (message.content.startsWith('!link ')) {
				await handleLink(message);
				return;
			}
			// A message inside a mapped thread is a reply to an existing topic.
			if (mirror.threadToTopic.has(message.channelId)) {
				await mirror.onDiscordMessage(message);
				return;
			}

			// A message in a thread with NO mapping is a discussion the user just
			// started in the forum channel. It needs a forum topic to exist at
			// all: Discord will not accept a REST message into a thread that does
			// not exist, so the topic is created first and the thread is mapped to
			// it. Previously this message was dropped on the floor, which is why a
			// brand-new thread never showed up on the forum while replies in
			// already-mapped threads worked.
			//
			// Guarded on `channel.parentId` so a message in the forum channel
			// itself (which has no parent thread) is ignored instead of creating a
			// topic with no thread to mirror back into.
			if (message.channel && message.channel.parentId) {
				const channelName = message.channel.name || '';
				const res = await mirror.adoptDiscordThread(
					message.channelId, channelName,
					{ author: message.author }
				);
				if (res && res.created) {
					// Confirm in-channel so the user is not left guessing whether the
					// post landed. Failure to send this must not undo the topic.
					await message.channel.send(
						`:white_check_mark: Diskusi ini sekarang ada di forum: ${config.nodebb.url}/topic/${res.tid}`
					).catch((err) => log.warn('could not post the topic link', err.message));
				}
			}
		} catch (err) {
			log.error('discord message failed', err.message);
		}
	});

	discord.client.on('error', (err) => log.error('discord client error', err.message));
	process.on('unhandledRejection', (err) => log.error('unhandled rejection', err && err.message));

	const shutdown = () => {
		clearInterval(poll);
		clearInterval(ladderSync);
		log.info('shutting down');
		process.exit(0);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	async function handleLink(message) {
		const username = message.content.slice(6).trim();
		const forumUser = await nodebb.getUserByUsername(username);
		if (!forumUser || !forumUser.username) {
			await message.reply(`Forum user \`${username}\` tidak ditemukan.`);
			return;
		}
		identity.setLink(message.author.id, {
			discordId: message.author.id,
			discordTag: message.author.tag,
			username: forumUser.username,
			uid: forumUser.uid,
		});
		await message.reply(`Terhubung: Discord \`${message.author.tag}\` <-> forum \`${forumUser.username}\` (${forumUser.postcount} posts).`);
		log.info('identity linked', { discordId: message.author.id, username: forumUser.username });
	}
}

main().catch((err) => {
	log.error('fatal', err.message);
	process.exit(1);
});
