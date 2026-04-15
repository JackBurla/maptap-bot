/**
 * MapTap Discord Bot
 * npm install discord.js node-cron pg
 * Env vars: DISCORD_TOKEN, ANNOUNCE_CHANNEL_ID, DATABASE_URL (Railway provides this automatically)
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const { Pool } = require('pg');

const TOKEN               = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const DATABASE_URL        = process.env.DATABASE_URL;

if (!TOKEN)        throw new Error('Missing DISCORD_TOKEN');
if (!ANNOUNCE_CHANNEL_ID) throw new Error('Missing ANNOUNCE_CHANNEL_ID');
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── DB setup ──────────────────────────────────────────────────────────────

async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      score       INTEGER NOT NULL,
      rounds      INTEGER[],
      date_str    TEXT NOT NULL,
      channel_id  TEXT,
      message_id  TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, date_str)
    )
  `);
  console.log('DB ready');
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

function parsePost(content) {
  const scoreMatch = content.match(/final score[:\s]+(\d+)/i);
  if (!scoreMatch) return null;
  const score = parseInt(scoreMatch[1], 10);
  if (isNaN(score) || score <= 0) return null;
  const before = content.slice(0, content.toLowerCase().indexOf('final score'));
  const nums = [...before.matchAll(/\b(\d{1,3})\b/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 0 && n <= 100);
  const rounds = nums.slice(-5);
  return { score, rounds };
}

// ── Medal logic ───────────────────────────────────────────────────────────

function assignMedals(sorted) {
  if (!sorted.length) return [];
  const results = [];
  const medalNames = ['gold', 'silver', 'bronze'];
  let medalIdx = 0, i = 0;
  while (i < sorted.length && medalIdx < medalNames.length) {
    const currentScore = sorted[i].score;
    let j = i;
    while (j < sorted.length && sorted[j].score === currentScore) j++;
    const tieCount = j - i;
    const medal = medalNames[medalIdx];
    for (let k = i; k < j; k++) results.push({ ...sorted[k], medal });
    medalIdx += tieCount >= 2 ? 2 : 1;
    i = j;
  }
  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────

async function getTodayStats(dateStr) {
  const { rows } = await pool.query('SELECT * FROM scores WHERE date_str = $1', [dateStr]);
  if (!rows.length) return null;
  const best  = rows.reduce((a, s) => s.score > a.score ? s : a);
  const worst = rows.reduce((a, s) => s.score < a.score ? s : a);
  const avg   = Math.round(rows.reduce((sum, s) => sum + s.score, 0) / rows.length);
  let worstRound = null;
  for (const s of rows) {
    if (!s.rounds || !s.rounds.length) continue;
    const min = Math.min(...s.rounds);
    if (worstRound === null || min < worstRound.value) {
      worstRound = { value: min, username: s.username };
    }
  }
  return { rows, best, worst, avg, count: rows.length, worstRound };
}

async function getMedalLeaderboard() {
  const { rows } = await pool.query('SELECT * FROM scores ORDER BY date_str');
  const byDate = {};
  for (const s of rows) {
    if (!byDate[s.date_str]) byDate[s.date_str] = [];
    byDate[s.date_str].push(s);
  }
  const tally = {};
  for (const dateStr of Object.keys(byDate)) {
    const sorted = byDate[dateStr].slice().sort((a, b) => b.score - a.score);
    for (const m of assignMedals(sorted)) {
      if (!tally[m.user_id]) tally[m.user_id] = { username: m.username, gold: 0, silver: 0, bronze: 0 };
      tally[m.user_id][m.medal]++;
      tally[m.user_id].username = m.username;
    }
  }
  return Object.values(tally)
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze)
    .slice(0, 5);
}

async function getTop3IndividualScores() {
  const { rows } = await pool.query('SELECT * FROM scores ORDER BY score DESC LIMIT 3');
  return rows;
}

async function getBottom3IndividualScores() {
  const { rows } = await pool.query('SELECT * FROM scores ORDER BY score ASC LIMIT 3');
  return rows;
}

// ── Announcement ──────────────────────────────────────────────────────────

const DAILY_MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const MEDAL_NAMES  = ['gold', 'silver', 'bronze'];
const DUNCE        = '<:Dunce:1492203597373636698>';

async function buildAnnouncement(dateStr) {
  const stats   = await getTodayStats(dateStr);
  const medals  = await getMedalLeaderboard();
  const top3    = await getTop3IndividualScores();
  const bottom3 = await getBottom3IndividualScores();

  const embed = new EmbedBuilder()
    .setTitle('MapTap Daily Recap')
    .setColor(0x5865F2)
    .setFooter({ text: formatDate(dateStr) });

  // Today's scores
  if (stats) {
    const sorted    = stats.rows.slice().sort((a, b) => b.score - a.score);
    const medalists = assignMedals(sorted);
    const medalMap  = {};
    for (const m of medalists) medalMap[m.user_id] = DAILY_MEDALS[MEDAL_NAMES.indexOf(m.medal)];

    let todayVal = [];
    for (const m of medalists) {
      todayVal.push(`${medalMap[m.user_id]} **${m.username}** - ${m.score.toLocaleString()} pts`);
    }
    todayVal.push('');
    todayVal.push(`${DUNCE} **${stats.worst.username}** - ${stats.worst.score.toLocaleString()} pts`);
    todayVal.push(`Average: ${stats.avg.toLocaleString()} pts (${stats.count} players)`);
    if (stats.worstRound) {
      todayVal.push(`${DUNCE} Worst guess: **${stats.worstRound.username}** - ${stats.worstRound.value} pts`);
    }
    embed.addFields({ name: "Today's Scores", value: todayVal.join('\n') });
  } else {
    embed.addFields({ name: "Today's Scores", value: '_No scores recorded today_' });
  }

  // Medal standings
  embed.addFields({
    name: 'Medal Standings (Top 5)',
    value: medals.length
      ? medals.map(r => {
          const parts = [];
          if (r.gold)   parts.push(`\u{1F947}${r.gold}`);
          if (r.silver) parts.push(`\u{1F948}${r.silver}`);
          if (r.bronze) parts.push(`\u{1F949}${r.bronze}`);
          return `**${r.username}** - ${parts.join(' ')}`;
        }).join('\n')
      : '_No data yet_'
  });

  // Best & worst all time
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

  try {
    await pool.query(
      `INSERT INTO scores (user_id, username, score, rounds, date_str, channel_id, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, date_str) DO NOTHING`,
      [userId, username, score, rounds, dateStr, message.channel.id, message.id]
    );
    const inserted = (await pool.query(
      'SELECT id FROM scores WHERE user_id=$1 AND date_str=$2', [userId, dateStr]
    )).rows[0];

    if (!inserted) {
      message.react('❌').catch(() => {});
      return;
    }

    message.react('✅').catch(() => {});
    console.log(`Saved: ${username} -> ${score} on ${dateStr}`);

    // Update dunce cap
    const { rows: today } = await pool.query(
      'SELECT * FROM scores WHERE date_str=$1 AND message_id IS NOT NULL', [dateStr]
    );
    if (today.length < 2) return;

    const sorted   = today.slice().sort((a, b) => a.score - b.score);
    const newDunce = sorted[0];

    for (const entry of today) {
      if (entry.message_id === newDunce.message_id) continue;
      try {
        const ch  = await client.channels.fetch(entry.channel_id);
        const msg = await ch.messages.fetch(entry.message_id);
        const reaction = [...msg.reactions.cache.values()].find(r => r.emoji.name === 'Dunce');
        if (reaction) await reaction.users.remove(client.user.id);
      } catch {}
    }
    try {
      const ch  = await client.channels.fetch(newDunce.channel_id);
      const msg = await ch.messages.fetch(newDunce.message_id);
      await msg.react('Dunce:1492203597373636698');
    } catch {}

  } catch (err) {
    console.error('Error saving score:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'maptap') return;
  await interaction.deferReply();
  await interaction.editReply({ embeds: [await buildAnnouncement(todayEST())] });
});

cron.schedule('0 21 * * *', async () => {
  try {
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    await channel.send({ embeds: [await buildAnnouncement(todayEST())] });
    console.log('Daily recap sent');
  } catch (err) {
    console.error('Failed to send recap:', err);
  }
}, { timezone: 'America/New_York' });

setupDB().then(() => client.login(TOKEN));
