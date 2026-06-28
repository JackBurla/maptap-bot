/**
 * Export all MapTap scores from Postgres to CSV.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node export-scores.js
 *   DATABASE_URL='postgres://...' node export-scores.js custom-file.csv
 */

const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
const outputPath = process.argv[2] || 'maptap-all-scores.csv';

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL');
}

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function run() {
  const { rows } = await pool.query(`
    SELECT
      date_str,
      username,
      user_id,
      score,
      rounds,
      recorded_at,
      channel_id,
      message_id
    FROM scores
    ORDER BY date_str ASC, score DESC, username ASC
  `);

  const columns = [
    'date_str',
    'username',
    'user_id',
    'score',
    'rounds',
    'recorded_at',
    'channel_id',
    'message_id'
  ];

  const lines = [
    columns.join(','),
    ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))
  ];

  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
  console.log(`Exported ${rows.length} score rows to ${outputPath}`);
}

run()
  .catch(err => {
    console.error('Failed to export scores:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
