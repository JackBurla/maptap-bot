/**
 * MapTap Discord Bot
 * npm install discord.js node-cron
 * DISCORD_TOKEN and ANNOUNCE_CHANNEL_ID must be set as env variables.
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs   = require('fs');

const TOKEN               = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const DB_FILE             = 'maptap-scores.json';

if (!TOKEN)               throw new Error('Missing DISCORD_TOKEN');
if (!ANNOUNCE_CHANNEL_ID) throw new Error('Missing ANNOUNCE_CHANNEL_ID');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { scores: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { scores: [] }; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function todayEST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function parseScore(content) {
  const match = content.match(/final score[:\s]+(\d+)/i);
  if (!match) return null;
  const score = parseInt(match[1], 10);
  if (isNaN(score) || score <= 0) return null;
  return { score };
}

function isMapTapPost(content) {
  return content.toLowerCase().includes('maptap.gg') && /final score/i.test(content);
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getTodayStats(dateStr) {
  const { scores } = loadDB();
  const today = scores.filter(s => s.date_str === dateStr);
  if (!today.length) return null;
  const best  = today.reduce((a, s) => s.score > a.score ? s : a);
  const worst = today.reduce((a, s) => s.score < a.score ? s : a);
  const avg   = Math.round(today.reduce((sum, s) => sum + s.score, 0) / today.length);
  return { best, worst, avg, count: today.length };
}

function getTop5AllTime() {
  const { scores } = loadDB();
  const totals = {};
  for (const s of scores) {
    if (!totals[s.user_id]) totals[s.user_id] = { username: s.username, total: 0, days: 0 };
    totals[s.user_id].total += s.score;
    totals[s.user_id].days  += 1;
    totals[s.user_id].username = s.username;
  }
  return Object.values(totals).sort((a, b) => b.total - a.total).slice(0, 5);
}

function getTop3IndividualScores() {
  const { scores } = loadDB();
  return [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
}

function getBottom3IndividualScores() {
  const { scores } = loadDB();
  return [...scores].sort((a, b) => a.score - b.score).slice(0, 3);
}

const MEDALS = ['1.', '2.', '3.', '4.', '5.'];
const SHAME  = ['1.', '2.', '3.'];

function buildAnnouncement(dateStr) {
  const stats   = getTodayStats(dateStr);
  const top5    = getTop5AllTime();
  const top3    = getTop3IndividualScores();
  const bottom3 = getBottom3IndividualScores();

  const embed = new EmbedBuilder()
    .setTitle('MapTap Daily Recap')
    .setColor(0x5865F2)
    .setFooter({ text: formatDate(dateStr) });

  embed.addFields({
    name: "Today's Scores",
    value: stats
      ? [
          `Best:    **${stats.best.username}** - ${stats.best.score.toLocaleString()} pts`,
          `Worst:   **${stats.worst.username}** - ${stats.worst.score.toLocaleString()} pts`,
          `Average: ${stats.avg.toLocaleString()} pts (${stats.count} players)`
        ].join('\n')
      : '_No scores recorded today_'
  });

  embed.addFields({
    name: 'Top 5 All-Time (cumulative)',
    value: top5.length
      ? top5.map((r, i) => `${MEDALS[i]} **${r.username}** - ${r.total.toLocaleString()} pts (${r.days}d)`).join('\n')
      : '_No data yet_'
  });

  const top3Lines    = top3.map((r, i)    => `${MEDALS[i]} **${r.username}** - ${r.score.toLocaleString()} pts on ${formatDate(r.date_str)}`).join('\n');
  const bottom3Lines = bottom3.map((r, i) => `${SHAME[i]} **${r.username}** - ${r.score.toLocaleString()} pts on ${formatDate(r.date_str)}`).join('\n');

  embed.addFields({
    name: 'Best & Worst Single-Day Scores (all time)',
    value: `**Top 3**\n${top3Lines}\n\n**Bottom 3**\n${bottom3Lines}`
  });

  return embed;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Daily recap fires at 9 PM EST, channel: ${ANNOUNCE_CHANNEL_ID}`);
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  if (!isMapTapPost(message.content)) return;

  const parsed = parseScore(message.content);
  if (!parsed) return;

  const { score } = parsed;
  const dateStr   = todayEST();
  const userId    = message.author.id;
  const username  = message.member?.displayName ?? message.author.username;

  const data    = loadDB();
  const already = data.scores.find(s => s.user_id === userId && s.date_str === dateStr);

  if (already) {
    message.react('❌').catch(() => {});
    console.log(`Ignored duplicate: ${username} on ${dateStr}`);
  } else {
    data.scores.push({ user_id: userId, username, score, date_str: dateStr, recorded_at: new Date().toISOString() });
    saveDB(data);
    message.react('✅').catch(() => {});
    console.log(`Saved: ${username} -> ${score} on ${dateStr}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'maptap') return;
  await interaction.deferReply();
  await interaction.editReply({ embeds: [buildAnnouncement(todayEST())] });
});

cron.schedule('0 21 * * *', async () => {
  try {
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    await channel.send({ embeds: [buildAnnouncement(todayEST())] });
    console.log('Daily recap sent');
  } catch (err) {
    console.error('Failed to send recap:', err);
  }
}, { timezone: 'America/New_York' });

client.login(TOKEN);
