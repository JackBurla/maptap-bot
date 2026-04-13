/**
 * MapTap Discord Bot
 * npm install discord.js node-cron
 * Env vars: DISCORD_TOKEN, ANNOUNCE_CHANNEL_ID
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const fs   = require('fs');

const TOKEN               = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const DB_FILE             = 'maptap-scores.json';
const DUNCE_EMOJI         = 'Dunce:1492203597373636698';

if (!TOKEN)               throw new Error('Missing DISCORD_TOKEN');
if (!ANNOUNCE_CHANNEL_ID) throw new Error('Missing ANNOUNCE_CHANNEL_ID');

// ── DB ────────────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { scores: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { scores: [] }; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function todayEST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isMapTapPost(content) {
  return content.toLowerCase().includes('maptap.gg') && /final score/i.test(content);
}

/**
 * Parse a MapTap post.
 * Returns { score, rounds } where rounds is an array of up to 5 numbers
 * from the line(s) before "Final score".
 */
function parsePost(content) {
  const scoreMatch = content.match(/final score[:\s]+(\d+)/i);
  if (!scoreMatch) return null;
  const score = parseInt(scoreMatch[1], 10);
  if (isNaN(score) || score <= 0) return null;

  // Grab the portion of the message before "Final score"
  const before = content.slice(0, content.toLowerCase().indexOf('final score'));
  // Extract all standalone numbers (ignore numbers that are part of words)
  const nums = [...before.matchAll(/\b(\d{1,3})\b/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 0 && n <= 100);

  // Take up to the last 5 numbers found (closest to the Final score line)
  const rounds = nums.slice(-5);

  return { score, rounds };
}

// ── Medal logic ───────────────────────────────────────────────────────────

/**
 * Given an array of { username, user_id, score } for one day (sorted desc by score),
 * assign medals per the rules:
 *   - Ties at the same rank both get that medal
 *   - If 2x gold -> next unique rank gets bronze (skip silver)
 *   - If 2x silver -> no bronze
 *   - If 2x bronze -> 4 medals total, no 5th
 *   - Otherwise standard gold/silver/bronze
 * Returns array of { ...entry, medal } for medalists only.
 */
function assignMedals(sorted) {
  if (!sorted.length) return [];

  const results = [];
  const medalNames = ['gold', 'silver', 'bronze'];
  let medalIdx = 0;
  let i = 0;

  while (i < sorted.length && medalIdx < medalNames.length) {
    const currentScore = sorted[i].score;
    // Find all entries with this score
    let j = i;
    while (j < sorted.length && sorted[j].score === currentScore) j++;
    const tieCount = j - i;
    const medal = medalNames[medalIdx];

    for (let k = i; k < j; k++) {
      results.push({ ...sorted[k], medal });
    }

    if (tieCount >= 2) {
      // Tied — skip next medal tier
      medalIdx += 2;
    } else {
      medalIdx += 1;
    }
    i = j;
  }

  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────

function getTodayStats(dateStr) {
  const { scores } = loadDB();
  const today = scores.filter(s => s.date_str === dateStr);
  if (!today.length) return null;

  const best  = today.reduce((a, s) => s.score > a.score ? s : a);
  const worst = today.reduce((a, s) => s.score < a.score ? s : a);
  const avg   = Math.round(today.reduce((sum, s) => sum + s.score, 0) / today.length);

  // Worst single round across all submissions today
  let worstRound = null;
  for (const s of today) {
    if (!s.rounds || !s.rounds.length) continue;
    const min = Math.min(...s.rounds);
    if (worstRound === null || min < worstRound.value) {
      worstRound = { value: min, username: s.username };
    }
  }

  return { best, worst, avg, count: today.length, worstRound };
}

function getMedalLeaderboard() {
  const { scores } = loadDB();

  // Group scores by date
  const byDate = {};
  for (const s of scores) {
    if (!byDate[s.date_str]) byDate[s.date_str] = [];
    byDate[s.date_str].push(s);
  }

  // Tally medals per user
  const tally = {}; // user_id -> { username, gold, silver, bronze }

  for (const dateStr of Object.keys(byDate)) {
    const sorted = byDate[dateStr].slice().sort((a, b) => b.score - a.score);
    const medalists = assignMedals(sorted);

    for (const m of medalists) {
      if (!tally[m.user_id]) {
        tally[m.user_id] = { username: m.username, gold: 0, silver: 0, bronze: 0 };
      }
      tally[m.user_id][m.medal]++;
      tally[m.user_id].username = m.username; // keep latest display name
    }
  }

  // Sort: gold desc, then silver, then bronze
  return Object.values(tally)
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze)
    .slice(0, 5);
}

function getTop3IndividualScores() {
  const { scores } = loadDB();
  return [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
}

function getBottom3IndividualScores() {
  const { scores } = loadDB();
  return [...scores].sort((a, b) => a.score - b.score).slice(0, 3);
}

// ── Announcement ──────────────────────────────────────────────────────────

function buildAnnouncement(dateStr) {
  const stats    = getTodayStats(dateStr);
  const medals   = getMedalLeaderboard();
  const top3     = getTop3IndividualScores();
  const bottom3  = getBottom3IndividualScores();

  const embed = new EmbedBuilder()
    .setTitle('MapTap Daily Recap')
    .setColor(0x5865F2)
    .setFooter({ text: formatDate(dateStr) });

  // Today's scores
  if (stats) {
    let todayVal = [
      `Best:    **${stats.best.username}** - ${stats.best.score.toLocaleString()} pts`,
      `:Dunce: **${stats.worst.username}** - ${stats.worst.score.toLocaleString()} pts`,
      `Average: ${stats.avg.toLocaleString()} pts (${stats.count} players)`,
    ];
    if (stats.worstRound) {
      todayVal.push(`:Dunce: Worst guess: **${stats.worstRound.username}** - ${stats.worstRound.value} pts`);
    }
    embed.addFields({ name: "Today's Scores", value: todayVal.join('\n') });
  } else {
    embed.addFields({ name: "Today's Scores", value: '_No scores recorded today_' });
  }

  // Medal leaderboard
  if (medals.length) {
    const lines = medals.map(r => {
      const parts = [];
      if (r.gold)   parts.push(`🥇${r.gold}`);
      if (r.silver) parts.push(`🥈${r.silver}`);
      if (r.bronze) parts.push(`🥉${r.bronze}`);
      return `**${r.username}** - ${parts.join(' ')}`;
    }).join('\n');
    embed.addFields({ name: 'Medal Standings (Top 5)', value: lines });
  } else {
    embed.addFields({ name: 'Medal Standings (Top 5)', value: '_No data yet_' });
  }

  // Best & worst all-time single day
  const top3Lines    = top3.map((r, i)    => `${i+1}. **${r.username}** - ${r.score.toLocaleString()} pts on ${formatDate(r.date_str)}`).join('\n');
  const bottom3Lines = bottom3.map((r, i) => `${i+1}. **${r.username}** - ${r.score.toLocaleString()} pts on ${formatDate(r.date_str)}`).join('\n');

  embed.addFields({
    name: 'Best & Worst Single-Day Scores (all time)',
    value: `**Top 3**\n${top3Lines}\n\n**Bottom 3**\n${bottom3Lines}`
  });

  return embed;
}

// ── Discord client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!isMapTapPost(message.content)) return;

  const parsed = parsePost(message.content);
  if (!parsed) return;

  const { score, rounds } = parsed;
  const dateStr  = todayEST();
  const userId   = message.author.id;
  const username = message.member?.displayName ?? message.author.username;

  const data    = loadDB();
  const already = data.scores.find(s => s.user_id === userId && s.date_str === dateStr);

  if (already) {
    message.react('❌').catch(() => {});
    return;
  }

  data.scores.push({ user_id: userId, username, score, rounds, date_str: dateStr, recorded_at: new Date().toISOString(), message_id: message.id, channel_id: message.channel.id });
  saveDB(data);
  message.react('✅').catch(() => {});
  console.log(`Saved: ${username} -> ${score} [${rounds}] on ${dateStr}`);

  // Update dunce cap — only if 2+ scores today
  const today = data.scores.filter(s => s.date_str === dateStr && s.message_id);
  if (today.length < 2) return;

  const sorted = today.slice().sort((a, b) => a.score - b.score);
  const newDunce = sorted[0];

  // Remove dunce from everyone else
  for (const entry of today) {
    if (entry.message_id === newDunce.message_id) continue;
    try {
      const ch  = await client.channels.fetch(entry.channel_id);
      const msg = await ch.messages.fetch(entry.message_id);
      const reaction = msg.reactions.cache.get(DUNCE_EMOJI) ?? 
        [...msg.reactions.cache.values()].find(r => r.emoji.name === 'Dunce');
      if (reaction) await reaction.users.remove(client.user.id);
    } catch {}
  }

  // Add dunce to current lowest
  try {
    const ch  = await client.channels.fetch(newDunce.channel_id);
    const msg = await ch.messages.fetch(newDunce.message_id);
    await msg.react(DUNCE_EMOJI);
  } catch {}
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
