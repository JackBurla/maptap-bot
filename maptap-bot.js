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

    // Update dunce cap + nerd crown
    const { rows: today } = await pool.query(
      'SELECT * FROM scores WHERE date_str=$1 AND message_id IS NOT NULL', [dateStr]
    );
    if (today.length < 2) return;

    const sorted   = today.slice().sort((a, b) => a.score - b.score);
    const newDunce = sorted[0];
    const newNerd  = sorted[sorted.length - 1];

    for (const entry of today) {
      try {
        const ch  = await client.channels.fetch(entry.channel_id);
        const msg = await ch.messages.fetch(entry.message_id);
        if (entry.message_id !== newDunce.message_id) {
          const dunceReaction = [...msg.reactions.cache.values()].find(r => r.emoji.name === 'Dunce');
          if (dunceReaction) await dunceReaction.users.remove(client.user.id);
        }
        if (entry.message_id !== newNerd.message_id) {
          const nerdReaction = [...msg.reactions.cache.values()].find(r => r.emoji.name === '🤓');
          if (nerdReaction) await nerdReaction.users.remove(client.user.id);
        }
      } catch {}
    }
    try {
      const ch  = await client.channels.fetch(newDunce.channel_id);
      const msg = await ch.messages.fetch(newDunce.message_id);
      await msg.react('Dunce:1492203597373636698');
    } catch {}
    try {
      const ch  = await client.channels.fetch(newNerd.channel_id);
      const msg = await ch.messages.fetch(newNerd.message_id);
      await msg.react('🤓');
    } catch {}

  } catch (err) {
    console.error('Error saving score:', err);
  }
});

async function getMyStats(userId) {
  const { rows } = await pool.query('SELECT * FROM scores WHERE user_id = $1 ORDER BY date_str', [userId]);
  if (!rows.length) return null;

  const scores = rows.map(r => r.score);
  const best   = Math.max(...scores);
  const worst  = Math.min(...scores);
  const avg    = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const placements = [];
  const placementCounts = [];
  for (const row of rows) {
    const { rows: dayRows } = await pool.query(
      'SELECT user_id, score FROM scores WHERE date_str = $1 ORDER BY score DESC', [row.date_str]
    );
    const medalists = assignMedals(dayRows);
    const myMedal   = medalists.find(m => m.user_id === userId);
    if (myMedal) {
      placements.push(['gold','silver','bronze'].indexOf(myMedal.medal) + 1);
    } else {
      placements.push(dayRows.findIndex(r => r.user_id === userId) + 1);
    }
    placementCounts.push(dayRows.length);
  }

  const bestPlacement  = Math.min(...placements);
  const worstPlacement = Math.max(...placements);
  const avgPlacement   = (placements.reduce((a, b) => a + b, 0) / placements.length).toFixed(1);

  const medals = { gold: 0, silver: 0, bronze: 0 };
  for (const row of rows) {
    const { rows: dayRows } = await pool.query(
      'SELECT user_id, score FROM scores WHERE date_str = $1 ORDER BY score DESC', [row.date_str]
    );
    const m = assignMedals(dayRows).find(m => m.user_id === userId);
    if (m) medals[m.medal]++;
  }

  // Worst individual round guess ever
  let worstGuess = null;
  for (const row of rows) {
    if (!row.rounds || !row.rounds.length) continue;
    const min = Math.min(...row.rounds);
    if (worstGuess === null || min < worstGuess.value) {
      worstGuess = { value: min, date: row.date_str };
    }
  }

  const bestIdx   = placements.indexOf(Math.min(...placements));
  const worstIdx  = placements.indexOf(Math.max(...placements));
  const bestPlacementTotal  = placementCounts[bestIdx];
  const worstPlacementTotal = placementCounts[worstIdx];

  return { days: rows.length, best, worst, avg, bestPlacement, worstPlacement, avgPlacement, medals,
    bestPlacementTotal, worstPlacementTotal,
    bestDate:  rows.find(r => r.score === best).date_str,
    worstDate: rows.find(r => r.score === worst).date_str,
    worstGuess };
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'maptap') {
    await interaction.deferReply();
    await interaction.editReply({ embeds: [await buildAnnouncement(todayEST())] });
  }

  if (interaction.commandName === 'mystats') {
    await interaction.deferReply({ ephemeral: true });
    const stats = await getMyStats(interaction.user.id);
    if (!stats) {
      await interaction.editReply({ content: 'No scores found for you yet!' });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('Your MapTap Stats')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Games Played',    value: `${stats.days}`, inline: true },
        { name: 'Best Score',      value: `${stats.best.toLocaleString()} pts on ${formatDate(stats.bestDate)}`, inline: true },
        { name: 'Worst Score',     value: `${stats.worst.toLocaleString()} pts on ${formatDate(stats.worstDate)}`, inline: true },
        { name: 'Average Score',   value: `${stats.avg.toLocaleString()} pts`, inline: true },
        { name: 'Best Placement',  value: `#${stats.bestPlacement} of ${stats.bestPlacementTotal}`, inline: true },
        { name: 'Worst Placement', value: `#${stats.worstPlacement} of ${stats.worstPlacementTotal}`, inline: true },
        { name: 'Avg Placement',   value: `#${stats.avgPlacement}`, inline: true },
        { name: 'Medals', value: `🥇${stats.medals.gold} 🥈${stats.medals.silver} 🥉${stats.medals.bronze}`, inline: true },
        ...(stats.worstGuess ? [{ name: 'Worst Single Guess', value: `${stats.worstGuess.value} pts on ${formatDate(stats.worstGuess.date)}`, inline: true }] : []),
      );
    await interaction.editReply({ embeds: [embed] });
  }
});

const INSULTS = [
  "this guy's fuckin retarded!",
  "skill issue.",
  "your dad doesn't love you",
  "respectfully, what the fuck",
  "🤡🤡🤡🤡🤡",
  "https://en.wikipedia.org/wiki/Walter_E._Fernald_Developmental_Center",
  "https://www.ice.gov/careers/how-apply",
  "congrats on your lobotomy",
  "inbred",
  "after much analysis you are actually the bot",
  "https://www.youtube.com/watch?v=LrkEc2V3mO4",
  "https://www.youtube.com/watch?v=XcyhMmLTKss",
];

cron.schedule('1 21 * * *', async () => {
  try {
    const dateStr = todayEST();
    const { rows } = await pool.query(
      'SELECT * FROM scores WHERE date_str = $1 AND message_id IS NOT NULL ORDER BY score ASC LIMIT 1',
      [dateStr]
    );
    if (!rows.length) return;
    const loser = rows[0];
    const insult = INSULTS[Math.floor(Math.random() * INSULTS.length)];
    const ch  = await client.channels.fetch(loser.channel_id);
    const msg = await ch.messages.fetch(loser.message_id);
    await msg.reply(insult);
    console.log(`Insulted ${loser.username}`);
  } catch (err) {
    console.error('Failed to send insult:', err);
  }
}, { timezone: 'America/New_York' });

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
