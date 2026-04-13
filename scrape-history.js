/**
 * One-time historical score scraper
 * Run ONCE with: node scrape-history.js
 * Populates maptap-scores.json with all past scores including round scores.
 */

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');

const TOKEN      = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const DB_FILE    = 'maptap-scores.json';

if (!TOKEN)      throw new Error('Missing DISCORD_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing ANNOUNCE_CHANNEL_ID');

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

function toDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Scraping channel ${CHANNEL_ID}...`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased()) { console.error('Bad channel'); process.exit(1); }

    let allMessages = [];
    let lastId = null;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;
      allMessages.push(...batch.values());
      lastId = batch.last().id;
      process.stdout.write(`\r  Fetched ${allMessages.length} messages...`);
      if (batch.size < 100) break;
    }

    console.log(`\nTotal messages: ${allMessages.length}`);
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    let db = { scores: [] };
    if (fs.existsSync(DB_FILE)) {
      try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
    }

    const seen = new Set(db.scores.map(s => `${s.user_id}|${s.date_str}`));
    let added = 0, skipped = 0;

    for (const msg of allMessages) {
      if (msg.author.bot) continue;
      if (!isMapTapPost(msg.content)) continue;

      const parsed = parsePost(msg.content);
      if (!parsed) continue;

      const { score, rounds } = parsed;
      const dateStr  = toDateStr(msg.createdAt);
      const userId   = msg.author.id;
      const username = msg.member?.displayName ?? msg.author.username;
      const key      = `${userId}|${dateStr}`;

      if (seen.has(key)) { skipped++; continue; }

      seen.add(key);
      db.scores.push({ user_id: userId, username, score, rounds, date_str: dateStr, recorded_at: msg.createdAt.toISOString() });
      added++;
      console.log(`  + ${username} - ${score} [${rounds.join(', ')}] on ${dateStr}`);
    }

    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    console.log(`\nDone! Added ${added} scores, skipped ${skipped} duplicates.`);
  } catch (err) {
    console.error('Error:', err);
  }

  process.exit(0);
});

client.login(TOKEN);
