/**
 * MapTap Discord Bot
 * npm install discord.js node-cron pg
 * Env vars: DISCORD_TOKEN, ANNOUNCE_CHANNEL_ID, DATABASE_URL (Railway provides this automatically)
 * Optional env var: GUILD_ID (registers slash commands to one server immediately instead of globally)
 */

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { Pool } = require('pg');
const {
  buildCurrentLeagueMessages,
  buildDailyLeagueMessages,
  ensureLeagueSeasonForDate,
  resolveLiveAverageMatchupsForScore,
  resolveLiveHeadToHeadForScore,
  setupLeagueDB
} = require('./leagues');

const TOKEN               = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const DATABASE_URL        = process.env.DATABASE_URL;
const GUILD_ID            = process.env.GUILD_ID;
const RUSTY_USER_ID       = '449399625389047829';
const RUSTY_WARNING_KEY   = 'rusty_fair_play_warning_v1';
const RUSTY_WARNING_TEXT  = 'WARNING - YOU HAVE BEEN REPORTED FOR VIOLATING FAIR PLAY. If you would like to continue to play with your "girlfriend\'s" help, please report to league authorities. Current proposal: Minus 5 for help + Minus 5 per daily guess in the Middle East. Thank you for your cooperation on this matter';

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS one_time_score_replies (
      reply_key   TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      sent_at     TIMESTAMPTZ,
      message_id  TEXT
    )
  `);
  console.log('DB ready');
}

async function maybeSendOneTimeScoreReply(message, userId) {
  if (userId !== RUSTY_USER_ID) return;

  const result = await pool.query(
    `INSERT INTO one_time_score_replies (reply_key, user_id, sent_at, message_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (reply_key) DO NOTHING
     RETURNING reply_key`,
    [RUSTY_WARNING_KEY, userId, message.id]
  );
  if (!result.rows[0]) return;

  await message.reply({ content: RUSTY_WARNING_TEXT, allowedMentions: { parse: [] } });
}

async function reactToLeagueTargets(targets) {
  for (const target of targets) {
    if (!target.channel_id || !target.message_id || !target.reaction) continue;
    try {
      const ch = await client.channels.fetch(target.channel_id);
      const msg = await ch.messages.fetch(target.message_id);
      await msg.react(target.reaction);
    } catch (err) {
      console.error('Failed to add league reaction:', err);
    }
  }
}

async function replyWithLeagueMessages(interaction, messages, postPublicly) {
  if (!messages.length) {
    await interaction.editReply({ content: 'No league season found yet.' });
    return;
  }

  if (postPublicly) {
    if (!interaction.channel?.isTextBased()) {
      await interaction.editReply({ content: 'Could not find a text channel to post in.' });
      return;
    }
    for (const content of messages) {
      await interaction.channel.send({ content, allowedMentions: { parse: [] } });
    }
    await interaction.editReply({ content: 'Posted league state.' });
    return;
  }

  await interaction.editReply({ content: messages[0], allowedMentions: { parse: [] } });
  for (const content of messages.slice(1)) {
    await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function todayEST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function yesterdayEST() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

function normalizeInsultSubmission(content) {
  return content.replace(/\r\n/g, '\n').trim();
}

function canManageQueue(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function formatInsultLabel(i) {
  return typeof i === 'object' ? `[image: ${i.image}]` : i;
}

function formatQueueState(queue, used) {
  const maxLength = 1900;
  const lines = [
    `**Queue (${queue.length} remaining):**`,
    ...(queue.length ? queue.map(formatInsultLabel) : ['_empty_']),
    '',
    `**Used this cycle (${used.length}):**`,
    ...(used.length ? used.map(formatInsultLabel) : ['_empty_'])
  ];
  return truncateLines(lines, maxLength);
}

function formatSubmissionAudit(rows) {
  const lines = [`**Community Submissions (${rows.length} shown):**`];
  for (const row of rows) {
    const submittedAt = new Date(row.submitted_at).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
    lines.push(`${row.id}. **${row.submitted_by_name}** (${row.submitted_by_user_id}) - ${submittedAt}`);
    lines.push(formatInsultLabel(row.content));
  }
  if (rows.length === 0) lines.push('_No community submissions yet_');
  return truncateLines(lines, 1900);
}

function truncateLines(lines, maxLength) {
  const visible = [];
  let usedChars = 0;
  for (const line of lines) {
    const next = visible.length ? `\n${line}` : line;
    if (usedChars + next.length > maxLength) break;
    visible.push(line);
    usedChars += next.length;
  }

  const omitted = lines.length - visible.length;
  if (!omitted) return visible.join('\n');

  const suffix = `\n...and ${omitted} more hidden for length`;
  while (visible.length && usedChars + suffix.length > maxLength) {
    const removed = visible.pop();
    usedChars -= removed.length + (visible.length ? 1 : 0);
  }
  return `${visible.join('\n')}${suffix}`;
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

async function getDunceLeaderboard() {
  const { rows } = await pool.query('SELECT * FROM scores ORDER BY date_str');
  const byDate = {};
  for (const s of rows) {
    if (!byDate[s.date_str]) byDate[s.date_str] = [];
    byDate[s.date_str].push(s);
  }
  const tally = {};
  for (const dateRows of Object.values(byDate)) {
    const lowest = Math.min(...dateRows.map(s => s.score));
    for (const s of dateRows.filter(s => s.score === lowest)) {
      if (!tally[s.user_id]) tally[s.user_id] = { username: s.username, count: 0 };
      tally[s.user_id].count++;
      tally[s.user_id].username = s.username;
    }
  }
  return Object.values(tally)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

// ── Announcement ──────────────────────────────────────────────────────────

const DAILY_MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const MEDAL_NAMES  = ['gold', 'silver', 'bronze'];
const DUNCE        = '<:Dunce:1492203597373636698>';
const SUBMIT_INSULT_MODAL_ID = 'submit_insult_modal';
const SUBMIT_INSULT_INPUT_ID = 'submit_insult_text';

async function buildAnnouncement(dateStr) {
  const stats   = await getTodayStats(dateStr);
  const medals  = await getMedalLeaderboard();
  const top3    = await getTop3IndividualScores();
  const bottom3 = await getBottom3IndividualScores();
  const dunces  = await getDunceLeaderboard();

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

  // Dunce leaderboard
  embed.addFields({
    name: `${DUNCE} All-Time Dunce Board (Top 3)`,
    value: dunces.length
      ? dunces.map((r, i) => `${i + 1}. **${r.username}** - ${r.count} time${r.count !== 1 ? 's' : ''}`).join('\n')
      : '_No data yet_'
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
  registerCommands().catch(err => console.error('Failed to register commands:', err));
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('maptap')
      .setDescription('Show the current MapTap recap'),
    new SlashCommandBuilder()
      .setName('mystats')
      .setDescription('Show your personal MapTap stats'),
    new SlashCommandBuilder()
      .setName('submitinsult')
      .setDescription('Privately submit an insult for the bot queue'),
    new SlashCommandBuilder()
      .setName('leagues')
      .setDescription('Show current MapTap league tables and schedule')
      .addBooleanOption(option =>
        option
          .setName('post')
          .setDescription('Post publicly in this channel (server managers only)')
      ),
    new SlashCommandBuilder()
      .setName('queuestate')
      .setDescription('Show the insult queue state')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('insultsubmissions')
      .setDescription('Show who submitted community insults')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ].map(command => command.toJSON());

  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands);
    console.log(`Registered commands for guild ${GUILD_ID}`);
    return;
  }

  await client.application.commands.set(commands);
  console.log('Registered global commands');
}

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
    const insertResult = await pool.query(
      `INSERT INTO scores (user_id, username, score, rounds, date_str, channel_id, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, date_str) DO NOTHING
       RETURNING id`,
      [userId, username, score, rounds, dateStr, message.channel.id, message.id]
    );

    if (!insertResult.rows[0]) {
      message.react('❌').catch(() => {});
      return;
    }

    message.react('✅').catch(() => {});
    console.log(`Saved: ${username} -> ${score} on ${dateStr}`);
    maybeSendOneTimeScoreReply(message, userId)
      .catch(err => console.error('Failed to send one-time score reply:', err));
    Promise.all([
      resolveLiveHeadToHeadForScore(pool, dateStr, userId),
      resolveLiveAverageMatchupsForScore(pool, dateStr, userId)
    ])
      .then(results => results.flat())
      .then(reactToLeagueTargets)
      .catch(err => console.error('Failed to resolve league matchup:', err));

    // Update dunce cap + nerd crown
    const { rows: today } = await pool.query(
      'SELECT * FROM scores WHERE date_str=$1 AND message_id IS NOT NULL', [dateStr]
    );
    if (today.length < 2) return;

    const lowestScore = Math.min(...today.map(entry => entry.score));
    const highestScore = Math.max(...today.map(entry => entry.score));
    const newDunces = today.filter(entry => entry.score === lowestScore);
    const newNerds = today.filter(entry => entry.score === highestScore);
    const dunceMessageIds = new Set(newDunces.map(entry => entry.message_id));
    const nerdMessageIds = new Set(newNerds.map(entry => entry.message_id));

    for (const entry of today) {
      try {
        const ch  = await client.channels.fetch(entry.channel_id);
        const msg = await ch.messages.fetch(entry.message_id);
        if (!dunceMessageIds.has(entry.message_id)) {
          const dunceReaction = [...msg.reactions.cache.values()].find(r => r.emoji.name === 'Dunce');
          if (dunceReaction) await dunceReaction.users.remove(client.user.id);
        }
        if (!nerdMessageIds.has(entry.message_id)) {
          const nerdReaction = [...msg.reactions.cache.values()].find(r => r.emoji.name === '🤓');
          if (nerdReaction) await nerdReaction.users.remove(client.user.id);
        }
      } catch {}
    }
    for (const newDunce of newDunces) {
      try {
        const ch  = await client.channels.fetch(newDunce.channel_id);
        const msg = await ch.messages.fetch(newDunce.message_id);
        await msg.react('Dunce:1492203597373636698');
      } catch {}
    }
    for (const newNerd of newNerds) {
      try {
        const ch  = await client.channels.fetch(newNerd.channel_id);
        const msg = await ch.messages.fetch(newNerd.message_id);
        await msg.react('🤓');
      } catch {}
    }

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
  if (interaction.isModalSubmit()) {
    if (interaction.customId !== SUBMIT_INSULT_MODAL_ID) return;

    await interaction.deferReply({ ephemeral: true });
    const content = normalizeInsultSubmission(interaction.fields.getTextInputValue(SUBMIT_INSULT_INPUT_ID));
    if (!content) {
      await interaction.editReply({ content: 'No insult submitted.' });
      return;
    }

    try {
      await addCommunityInsult(content, interaction.user.id, interaction.user.username);
      await interaction.editReply({ content: 'Submitted. It will stay hidden until the bot uses it.' });
    } catch (err) {
      if (err.code === '23505') {
        await interaction.editReply({ content: 'That one is already in the queue.' });
        return;
      }
      console.error('Failed to submit insult:', err);
      await interaction.editReply({ content: 'Could not save that submission.' });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'maptap') {
    await interaction.deferReply();
    await interaction.editReply({ embeds: [await buildAnnouncement(todayEST())] });
    return;
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
    return;
  }

  if (interaction.commandName === 'leagues') {
    const postPublicly = interaction.options.getBoolean('post') || false;
    await interaction.deferReply({ ephemeral: true });
    if (postPublicly && !canManageQueue(interaction)) {
      await interaction.editReply({ content: 'Only server managers can post the league state publicly.' });
      return;
    }

    try {
      const { messages } = await buildCurrentLeagueMessages(pool, todayEST());
      await replyWithLeagueMessages(interaction, messages, postPublicly);
    } catch (err) {
      console.error('Failed to show leagues:', err);
      await interaction.editReply({ content: 'Could not load league state.' });
    }
    return;
  }

  if (interaction.commandName === 'submitinsult') {
    const modal = new ModalBuilder()
      .setCustomId(SUBMIT_INSULT_MODAL_ID)
      .setTitle('Submit an Insult');
    const input = new TextInputBuilder()
      .setCustomId(SUBMIT_INSULT_INPUT_ID)
      .setLabel('Insult')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1800)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.commandName === 'queuestate') {
    await interaction.deferReply({ ephemeral: true });
    if (!canManageQueue(interaction)) {
      await interaction.editReply({ content: 'Only server managers can view the insult queue.' });
      return;
    }
    const { rows } = await pool.query('SELECT queue, used FROM insult_state WHERE id = 1');
    const queue = rows[0].queue.filter(i => !isRetiredInsult(i));
    const used = rows[0].used.filter(i => !isRetiredInsult(i));
    await interaction.editReply({ content: formatQueueState(queue, used) });
    return;
  }

  if (interaction.commandName === 'insultsubmissions') {
    await interaction.deferReply({ ephemeral: true });
    if (!canManageQueue(interaction)) {
      await interaction.editReply({ content: 'Only server managers can view insult submissions.' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT id, content, submitted_by_user_id, submitted_by_name, submitted_at
       FROM insult_submissions
       WHERE status = 'accepted'
       ORDER BY submitted_at DESC
       LIMIT 25`
    );
    await interaction.editReply({ content: formatSubmissionAudit(rows) });
  }
});

const INSULTS = [
  "this guy's fuckin retarded!",
  "https://en.wikipedia.org/wiki/Walter_E._Fernald_Developmental_Center",
  "https://www.ice.gov/careers/how-apply",
  "congrats on your lobotomy",
  "https://www.youtube.com/watch?v=LrkEc2V3mO4",
  "https://www.youtube.com/watch?v=XcyhMmLTKss",
  "you ever think they just maptapped wrong and blew up an Iranian hospital? Anyway nice score retard",
  "budd dwyer should be your role model",
  "in the steroid era this was refreshing",
  "median average voter",
  "charlie kirk died for this",
  "hey there! congrats on the lowest score. atleast you aren't @hellorobotics",
  "i am a nihlist",
  "the cia killed JFK",
  "i maptapped your mother",
  "new game! AncestryTap! Your parents are cousins!",
  { image: 'calvin.png' },
  { image: 'child-left-behind.png' },
  { image: 'frontal-lobe.png' },
  "https://www.proprofs.com/quiz-school/quizzes/do-i-have-cte-quiz",
  "https://msktc.org/tbi",
  "https://specialneedsanswers.com/housing-options-for-adults-with-special-needs-14975",
  "if this is kyle kys if not try again next time : )",
  "Do you ever feel like a plastic bag\nDrifting through the wind, wanting to start again?",
  "knowledge of world geography is useless its important to focus on your community",
  "https://www.youtube.com/watch?v=AVB_aIXMEgE",
  "flight 93 was shot down",
  "Lennie Small lookin ass",
  "congrats to the winner of retard of the day.... Kash Patel! You are second",
  "https://petersonacademy.com/signup",
  "it is cooler to be here than get 1000 🧂",
  "Woodrow Wilson drew better borders drunk at Versailles",
];

const INSULTS_REMOVED_HASHES = new Set([
  '06a5b0d515d74fbc8230cc8495e8892ea904fb527c5a5c8acebe21a15acbb3f5',
  'cd9187ca09dba8090db21579bc2911a4c44cd6ba5c74841a01c9140116f9667d',
]);

// Bump this any time the seed data needs to change — triggers a re-seed on next deploy
const QUEUE_VERSION = 9;

// All insults confirmed fired — go to back of queue
const INSULTS_ALREADY_USED = [
  // confirmed via Discord scrape Jun 2 2026
  { image: 'calvin.png' },
  { image: 'child-left-behind.png' },
  { image: 'frontal-lobe.png' },
  "i am a nihlist",
  "budd dwyer should be your role model",
  "median average voter",
  "https://msktc.org/tbi",
  "new game! AncestryTap! Your parents are cousins!",
  "Lennie Small lookin ass",
  "you ever think they just maptapped wrong and blew up an Iranian hospital? Anyway nice score retard",
  "i maptapped your mother",
  "https://petersonacademy.com/signup",
  "the cia killed JFK",
  "in the steroid era this was refreshing",
  // confirmed by user Jun 2 2026 (missed by scrape — deleted or pre-cutoff)
  "this guy's fuckin retarded!",
  "https://en.wikipedia.org/wiki/Walter_E._Fernald_Developmental_Center",
  "https://www.ice.gov/careers/how-apply",
  "congrats on your lobotomy",
  "https://www.youtube.com/watch?v=LrkEc2V3mO4",
  "https://www.youtube.com/watch?v=XcyhMmLTKss",
  "charlie kirk died for this",
  "hey there! congrats on the lowest score. atleast you aren't @hellorobotics",
  "https://www.proprofs.com/quiz-school/quizzes/do-i-have-cte-quiz",
  "https://specialneedsanswers.com/housing-options-for-adults-with-special-needs-14975",
  "https://www.youtube.com/watch?v=AVB_aIXMEgE",
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function insultFingerprint(i) {
  return crypto.createHash('sha256').update(JSON.stringify(i)).digest('hex');
}

function isRetiredInsult(i) {
  return INSULTS_REMOVED_HASHES.has(insultFingerprint(i));
}

async function setupInsultQueue() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS insult_submissions (
      id                   SERIAL PRIMARY KEY,
      content              TEXT NOT NULL UNIQUE,
      submitted_by_user_id TEXT NOT NULL,
      submitted_by_name    TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'accepted',
      submitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS insult_state (
      id               INTEGER PRIMARY KEY DEFAULT 1,
      queue            JSONB NOT NULL DEFAULT '[]',
      used             JSONB NOT NULL DEFAULT '[]',
      version          INTEGER NOT NULL DEFAULT 0,
      last_recap_date  TEXT,
      last_insult_date TEXT
    )
  `);
  await pool.query(`ALTER TABLE insult_state ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE insult_state ADD COLUMN IF NOT EXISTS last_recap_date TEXT`);
  await pool.query(`ALTER TABLE insult_state ADD COLUMN IF NOT EXISTS last_insult_date TEXT`);
  await pool.query(`ALTER TABLE insult_state ADD COLUMN IF NOT EXISTS counts JSONB NOT NULL DEFAULT '{}'`);

  const inserted = await pool.query(`
    INSERT INTO insult_state (id) VALUES (1) ON CONFLICT DO NOTHING RETURNING id
  `);

  const { rows } = await pool.query('SELECT queue, used, version, last_recap_date, last_insult_date FROM insult_state WHERE id = 1');
  const state = rows[0];
  const acceptedInsults = await getAcceptedCommunityInsults();
  const allInsults = [...INSULTS, ...acceptedInsults];
  const prunedQueue = state.queue.filter(i => !isRetiredInsult(i));
  const prunedUsed = state.used.filter(i => !isRetiredInsult(i));
  if (prunedQueue.length !== state.queue.length || prunedUsed.length !== state.used.length) {
    const { rows: countRows } = await pool.query('SELECT counts FROM insult_state WHERE id = 1');
    const counts = countRows[0]?.counts || {};
    for (const key of Object.keys(counts)) {
      if (isRetiredInsult(key)) delete counts[key];
    }
    await pool.query(
      'UPDATE insult_state SET queue = $1, used = $2, counts = $3 WHERE id = 1',
      [JSON.stringify(prunedQueue), JSON.stringify(prunedUsed), JSON.stringify(counts)]
    );
    state.queue = prunedQueue;
    state.used = prunedUsed;
    console.log('Removed retired insult(s) from queue state');
  }

  // Seed last_*_date to today if null — prevents tonight's midnight run after the 9PM already fired
  if (!state.last_recap_date || !state.last_insult_date) {
    await pool.query(
      'UPDATE insult_state SET last_recap_date = COALESCE(last_recap_date, $1), last_insult_date = COALESCE(last_insult_date, $1) WHERE id = 1',
      [todayEST()]
    );
  }

  if (inserted.rows.length > 0 || state.version < QUEUE_VERSION) {
    // First boot or version mismatch — re-seed with correct data
    const usedSet = new Set(INSULTS_ALREADY_USED.map(i => JSON.stringify(i)));
    const FIRE_TONIGHT = "it is cooler to be here than get 1000 🧂";
    const rest = shuffle(allInsults.filter(i => !usedSet.has(JSON.stringify(i)) && i !== FIRE_TONIGHT));
    const unused = [FIRE_TONIGHT, ...rest];
    // Seed fire counts from Discord scrape (Jun 2 2026)
    const seedCounts = {
      '[image: calvin.png]': 3,
      '[image: frontal-lobe.png]': 2,
      '[image: child-left-behind.png]': 2,
      'i am a nihlist': 2,
      'budd dwyer should be your role model': 2,
      'median average voter': 2,
      'https://msktc.org/tbi': 2,
      'new game! AncestryTap! Your parents are cousins!': 1,
      'Lennie Small lookin ass': 1,
      'you ever think they just maptapped wrong and blew up an Iranian hospital? Anyway nice score retard': 1,
      'i maptapped your mother': 1,
      'https://petersonacademy.com/signup': 1,
      'the cia killed JFK': 1,
      'in the steroid era this was refreshing': 1,
      // flight 93 and kash patel left at 0 (omitted) so they go to front tier
      // confirmed by user Jun 2 2026
      'this guy\'s fuckin retarded!': 1,
      'https://en.wikipedia.org/wiki/Walter_E._Fernald_Developmental_Center': 1,
      'https://www.ice.gov/careers/how-apply': 1,
      'congrats on your lobotomy': 1,
      'https://www.youtube.com/watch?v=LrkEc2V3mO4': 1,
      'https://www.youtube.com/watch?v=XcyhMmLTKss': 1,
      'charlie kirk died for this': 1,
      'hey there! congrats on the lowest score. atleast you aren\'t @hellorobotics': 1,
      'https://www.proprofs.com/quiz-school/quizzes/do-i-have-cte-quiz': 1,
      'https://specialneedsanswers.com/housing-options-for-adults-with-special-needs-14975': 1,
      'https://www.youtube.com/watch?v=AVB_aIXMEgE': 1,
    };
    await pool.query(
      'UPDATE insult_state SET queue = $1, used = $2, version = $3, counts = $4 WHERE id = 1',
      [JSON.stringify(unused), JSON.stringify(INSULTS_ALREADY_USED), QUEUE_VERSION, JSON.stringify(seedCounts)]
    );
    console.log(`Insult queue seeded (v${QUEUE_VERSION})`);
  } else {
    // Subsequent boots — append any brand-new insults to back of queue
    const known = new Set([...state.queue, ...state.used].map(i => JSON.stringify(i)));
    const brandNew = shuffle(allInsults.filter(i => !known.has(JSON.stringify(i))));
    if (brandNew.length > 0) {
      await pool.query(
        'UPDATE insult_state SET queue = $1 WHERE id = 1',
        [JSON.stringify([...state.queue, ...brandNew])]
      );
      console.log(`Added ${brandNew.length} new insult(s) to back of queue`);
    }
  }
  console.log('Insult queue ready');
}

function insultKey(i) {
  return typeof i === 'object' ? `[image: ${i.image}]` : i;
}

async function getAcceptedCommunityInsults(clientOrPool = pool) {
  const { rows } = await clientOrPool.query(
    `SELECT content FROM insult_submissions WHERE status = 'accepted' ORDER BY submitted_at`
  );
  return rows.map(r => r.content).filter(i => !isRetiredInsult(i));
}

async function getAllActiveInsults(clientOrPool = pool) {
  return [...INSULTS, ...await getAcceptedCommunityInsults(clientOrPool)];
}

async function addCommunityInsult(content, submittedByUserId, submittedByName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalized = normalizeInsultSubmission(content);
    if (isRetiredInsult(normalized)) {
      const err = new Error('Retired insult submission');
      err.code = '23505';
      throw err;
    }
    const stateResult = await client.query('SELECT queue, used, counts FROM insult_state WHERE id = 1 FOR UPDATE');
    const state = stateResult.rows[0];
    const allActive = await getAllActiveInsults(client);
    const known = new Set([
      ...allActive,
      ...state.queue,
      ...state.used
    ].map(i => JSON.stringify(i)));

    if (known.has(JSON.stringify(normalized))) {
      const err = new Error('Duplicate insult submission');
      err.code = '23505';
      throw err;
    }

    await client.query(
      `INSERT INTO insult_submissions (content, submitted_by_user_id, submitted_by_name)
       VALUES ($1, $2, $3)`,
      [normalized, submittedByUserId, submittedByName]
    );

    const queue = [...state.queue, normalized];
    const counts = state.counts || {};
    const key = insultKey(normalized);
    if (counts[key] === undefined) counts[key] = 0;

    await client.query(
      'UPDATE insult_state SET queue = $1, counts = $2 WHERE id = 1',
      [JSON.stringify(queue), JSON.stringify(counts)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Shuffle within count tiers so lower-fired insults always go before higher-fired ones
function buildCycleQueue(insults, counts) {
  const groups = {};
  for (const ins of insults) {
    const c = counts[insultKey(ins)] || 0;
    if (!groups[c]) groups[c] = [];
    groups[c].push(ins);
  }
  const sorted = Object.keys(groups).map(Number).sort((a, b) => a - b);
  return sorted.flatMap(c => shuffle(groups[c]));
}

async function pickInsult() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT queue, used, version, counts FROM insult_state WHERE id = 1 FOR UPDATE');
    let { queue, used, version, counts } = rows[0];
    queue = queue.filter(i => !isRetiredInsult(i));
    used = used.filter(i => !isRetiredInsult(i));

    if (queue.length === 0) {
      queue = buildCycleQueue(await getAllActiveInsults(db), counts);
      used = [];
      console.log('Insult queue cycled — starting new round');
    }

    const insult = queue.shift();
    used.push(insult);

    const key = insultKey(insult);
    counts[key] = (counts[key] || 0) + 1;

    await db.query(
      'UPDATE insult_state SET queue = $1, used = $2, version = $3, counts = $4 WHERE id = 1',
      [JSON.stringify(queue), JSON.stringify(used), version, JSON.stringify(counts)]
    );

    await db.query('COMMIT');
    return insult;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

cron.schedule('1 0 * * *', async () => {
  try {
    const dateStr = yesterdayEST();
    const { rows: stateRows } = await pool.query('SELECT last_insult_date FROM insult_state WHERE id = 1');
    if (stateRows[0]?.last_insult_date === dateStr) {
      console.log(`Insult already sent for ${dateStr}, skipping`);
      return;
    }
    const { rows } = await pool.query(
      'SELECT * FROM scores WHERE date_str = $1 AND message_id IS NOT NULL ORDER BY score ASC LIMIT 1',
      [dateStr]
    );
    if (!rows.length) return;
    const loser = rows[0];
    const insult = await pickInsult();
    const ch  = await client.channels.fetch(loser.channel_id);
    const msg = await ch.messages.fetch(loser.message_id);
    if (insult && typeof insult === 'object' && insult.image) {
      const file = new AttachmentBuilder(path.join(__dirname, 'insult-images', insult.image));
      await msg.reply({ files: [file] });
    } else {
      await msg.reply({ content: insult, allowedMentions: { parse: [] } });
    }
    await pool.query('UPDATE insult_state SET last_insult_date = $1 WHERE id = 1', [dateStr]);
    console.log(`Insulted ${loser.username}`);
  } catch (err) {
    console.error('Failed to send insult:', err);
  }
}, { timezone: 'America/New_York' });

cron.schedule('1 0 * * *', async () => {
  try {
    const resultDate = yesterdayEST();
    const scheduleDate = todayEST();
    const { rows: stateRows } = await pool.query('SELECT last_league_post_date FROM league_state WHERE id = 1');
    if (stateRows[0]?.last_league_post_date === resultDate) {
      console.log(`League update already sent for ${resultDate}, skipping`);
      return;
    }

    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const { messages, reactionTargets } = await buildDailyLeagueMessages(pool, resultDate, scheduleDate);
    for (const content of messages) {
      await channel.send({ content, allowedMentions: { parse: [] } });
    }
    await reactToLeagueTargets(reactionTargets);
    await pool.query('UPDATE league_state SET last_league_post_date = $1 WHERE id = 1', [resultDate]);
    console.log('League update sent');
  } catch (err) {
    console.error('Failed to send league update:', err);
  }
}, { timezone: 'America/New_York' });

cron.schedule('0 0 * * *', async () => {
  try {
    const dateStr = yesterdayEST();
    const { rows: stateRows } = await pool.query('SELECT last_recap_date FROM insult_state WHERE id = 1');
    if (stateRows[0]?.last_recap_date === dateStr) {
      console.log(`Recap already sent for ${dateStr}, skipping`);
      return;
    }
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    await channel.send({ embeds: [await buildAnnouncement(dateStr)] });
    await pool.query('UPDATE insult_state SET last_recap_date = $1 WHERE id = 1', [dateStr]);
    console.log('Daily recap sent');
  } catch (err) {
    console.error('Failed to send recap:', err);
  }
}, { timezone: 'America/New_York' });

setupDB()
  .then(() => setupInsultQueue())
  .then(() => setupLeagueDB(pool))
  .then(() => ensureLeagueSeasonForDate(pool, todayEST()))
  .then(() => client.login(TOKEN));
