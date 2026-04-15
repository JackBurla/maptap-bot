/**
 * One-time historical score importer
 * Reads maptap-scores.json and imports all scores into Postgres.
 * Run ONCE after setting up the Railway Postgres database.
 * 
 * Usage:
 *   $env:DATABASE_URL='your_railway_postgres_url'
 *   node scrape-history.js
 */

const { Pool } = require('pg');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Create table if needed
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

  const db = JSON.parse(fs.readFileSync('maptap-scores.json', 'utf8'));
  console.log(`Importing ${db.scores.length} scores...`);

  let added = 0, skipped = 0;
  for (const s of db.scores) {
    const result = await pool.query(
      `INSERT INTO scores (user_id, username, score, rounds, date_str, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, date_str) DO NOTHING`,
      [s.user_id, s.username, s.score, s.rounds || [], s.date_str, s.recorded_at]
    );
    if (result.rowCount > 0) { added++; }
    else { skipped++; }
  }

  console.log(`Done! Added ${added}, skipped ${skipped} duplicates.`);
  await pool.end();
}

run().catch(console.error);
