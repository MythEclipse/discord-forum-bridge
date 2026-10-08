'use strict';

/**
 * Discord <-> forum.imrnes.team bridge.
 *
 * Requires DISCORD_BOT_TOKEN (Bot page in the Developer Portal). The OAuth2
 * client secret cannot log a bot in - it only authorises OAuth2 grants and
 * application-command updates.
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { config } = require('./config');
const { createClient } = require('./nodebb');
const { Bridge } = require('./bridge');
const log = require('./log');

if (!config.discord.botToken) {
	log.error('DISCORD_BOT_TOKEN missing - see README "Generate the bot token"');
	process.exit(1);
}

const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers,
	],
	partials: [Partials.Channel],
});

const nodebb = createClient(config.nodebb);
const bridge = new Bridge({ discord: null, nodebb, config });

const transport = {
	async send({ channelId, content }) {
		const channel = await discord.channels.fetch(channelId);
		if (!channel || !channel.isTextBased()) {
			throw new Error(`channel ${channelId} is not text based`);
		}
		return channel.send(content);
	},
};
bridge.discord = transport;

// guild member cache -> forum postcount lookup, so rank reflects the forum
async function enrichMember(member) {
	if (!member || !member.user) {
		return null;
	}
	const nickname = member.displayName || member.user.username;
	const link = bridge.identity.findByDiscordId(member.id) || bridge.identity.findByUsername(nickname);
	if (!link || !link.username) {
		return {
			id: member.id,
			nickname: nickname,
			user: member.user,
			forumPostcount: 0,
			forumUsername: null,
		};
	}
	try {
		const forumUser = await nodebb.getUserByUsername(link.username);
		return {
			id: member.id,
			nickname: nickname,
			user: member.user,
			forumPostcount: forumUser ? parseInt(forumUser.postcount, 10) || 0 : 0,
			forumUsername: forumUser ? forumUser.username : link.username,
		};
	} catch (err) {
		return { id: member.id, nickname: nickname, user: member.user, forumPostcount: 0, forumUsername: link.username };
	}
}

let pollTimer = null;

discord.once('ready', async () => {
	bridge.setBotUserId(discord.user.id);
	log.info('discord ready', { tag: discord.user.tag, id: discord.user.id });

	const channel = await discord.channels.fetch(config.discord.channelId);
	if (!channel) {
		log.error('target channel not found', config.discord.channelId);
		process.exit(1);
	}
	log.info('mirroring channel', `${channel.name} (${channel.id})`);

	await bridge.loadRankLadder();
	await bridge.ensureTopic();

	// start from the newest post so a restart never replays history
	let lastPid = 0;
	try {
		const res = await nodebb.getTopicPosts(bridge.topicId, { from: 0, to: 100 });
		const posts = (res && res.posts) || [];
		lastPid = posts.reduce((max, p) => Math.max(max, Number(p.pid) || 0), 0);
		log.info('forum sync cursor', { lastPid });
	} catch (err) {
		log.warn('could not seed forum cursor', err.message);
	}

	const poll = async () => {
		try {
			const res = await nodebb.getTopicPosts(bridge.topicId, { from: lastPid, to: lastPid + 50 });
			const posts = (res && res.posts) || [];
			for (const post of posts) {
				lastPid = Math.max(lastPid, Number(post.pid) || 0);
				await bridge.onForumReply(post, { postcount: 0 });
			}
		} catch (err) {
			log.warn('forum poll failed', err.message);
		}
	};

	pollTimer = setInterval(poll, config.behaviour.syncIntervalMs);
	setInterval(() => bridge.loadRankLadder(), config.behaviour.raceSyncIntervalMs);
	log.info('bridge running', { intervalMs: config.behaviour.syncIntervalMs });
});

discord.on('messageCreate', async (message) => {
	if (message.channel.id !== config.discord.channelId) {
		return;
	}
	try {
		if (message.content.startsWith('!link ')) {
			const username = message.content.slice(6).trim();
			const forumUser = await nodebb.getUserByUsername(username);
			if (!forumUser || !forumUser.username) {
				await message.reply(`Forum user \`${username}\` tidak ditemukan.`);
				return;
			}
			bridge.identity.setLink(message.author.id, {
				discordId: message.author.id,
				discordTag: message.author.tag,
				username: forumUser.username,
				uid: forumUser.uid,
			});
			await message.reply(`Terhubung: Discord \`${message.author.tag}\` <-> forum \`${forumUser.username}\` (${forumUser.postcount} posts).`);
			log.info('identity linked', { discordId: message.author.id, username: forumUser.username });
			return;
		}
		await bridge.onDiscordMessage(message, await enrichMember(message.member));
	} catch (err) {
		log.error('discord message failed', err.message);
	}
});

discord.on('error', (err) => log.error('discord client error', err.message));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err && err.message));
process.on('SIGTERM', () => {
	if (pollTimer) clearInterval(pollTimer);
	log.info('shutting down');
	process.exit(0);
});

discord.login(config.discord.botToken).catch((err) => {
	log.error('discord login failed', err.message);
	process.exit(1);
});
