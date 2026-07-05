const SEASON_LENGTH_DAYS = 10;
const LEAGUE_LAUNCH_DATE = '2026-06-29';
const LEAGUE_NAMES = {
  1: 'League Tism',
  2: 'League Mid',
  3: 'League Dunce'
};
const AVERAGE_OPPONENT = 'AVERAGE';
const WIN_REACTION = '🇼';
const LOSS_REACTION = '🇱';
const NO_SHOW_REMOVAL_THRESHOLD = 7;
const EXCLUDED_LEAGUE_USER_IDS = new Set([
  '175759734996074497', // pancake_guys
  '215273003888541696', // Djimmy / djimmy23
  '175757349284347904'  // admiral_stupid
]);

function dateAdd(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compareDate(a, b) {
  return a.localeCompare(b);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function latestUsername(rows) {
  return rows.slice().sort((a, b) => compareDate(a.date_str, b.date_str))[rows.length - 1].username;
}

function buildPlayerAverages(scores, startDate) {
  const byUser = new Map();
  for (const row of scores) {
    if (compareDate(row.date_str, startDate) >= 0) continue;
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }

  const cutoff = dateAdd(startDate, -30);
  return [...byUser.entries()].filter(([userId]) => !EXCLUDED_LEAGUE_USER_IDS.has(userId)).map(([userId, rows]) => {
    const total = rows.reduce((sum, row) => sum + Number(row.score), 0);
    const last30Games = rows.filter(row => compareDate(row.date_str, cutoff) >= 0).length;
    return {
      user_id: userId,
      username: latestUsername(rows),
      seed_average: total / rows.length,
      total_games: rows.length,
      last30_games: last30Games
    };
  });
}

function seedInitialMemberships(players) {
  const eligible = players
    .filter(player => player.last30_games >= 10)
    .sort((a, b) => b.seed_average - a.seed_average || a.username.localeCompare(b.username));
  const elite = new Set(eligible.slice(0, 5).map(player => player.user_id));
  const middle = new Set(eligible.slice(5, 10).map(player => player.user_id));

  return players
    .slice()
    .sort((a, b) => b.seed_average - a.seed_average || a.username.localeCompare(b.username))
    .map(player => ({
      ...player,
      league_level: elite.has(player.user_id) ? 1 : middle.has(player.user_id) ? 2 : 3
    }));
}

function rankStandings(rows) {
  return rows.slice().sort((a, b) =>
    b.points - a.points ||
    b.point_diff - a.point_diff ||
    b.total_score - a.total_score ||
    b.seed_average - a.seed_average ||
    a.username.localeCompare(b.username)
  );
}

function flattenStandings(standings) {
  return [1, 2, 3].flatMap(level => standings[level] || []);
}

function applyPromotionRelegation(memberships, standingsByLeague, newPlayers) {
  const next = new Map(memberships.map(member => [member.user_id, { ...member }]));

  for (const level of [1, 2]) {
    const upper = rankStandings(standingsByLeague[level] || []);
    const lower = rankStandings(standingsByLeague[level + 1] || []);
    const relegated = upper[upper.length - 1];
    const promoted = lower[0];
    if (!relegated || !promoted || relegated.user_id === promoted.user_id) continue;
    if (next.has(relegated.user_id)) next.get(relegated.user_id).league_level = level + 1;
    if (next.has(promoted.user_id)) next.get(promoted.user_id).league_level = level;
  }

  for (const player of newPlayers) {
    if (!next.has(player.user_id)) next.set(player.user_id, { ...player, league_level: 3 });
  }

  return [...next.values()];
}

function generateSeasonSchedule(memberships, startDate, seasonId = null) {
  const schedule = [];
  const byLeague = new Map();
  for (const member of memberships) {
    if (!byLeague.has(member.league_level)) byLeague.set(member.league_level, []);
    byLeague.get(member.league_level).push(member);
  }

  for (let day = 0; day < SEASON_LENGTH_DAYS; day++) {
    const dateStr = dateAdd(startDate, day);
    for (const [leagueLevel, members] of byLeague.entries()) {
      const sorted = members.slice().sort((a, b) => a.user_id.localeCompare(b.user_id));
      let pool = sorted.slice();

      if (pool.length % 2 === 1) {
        const averagePlayer = sorted[day % sorted.length];
        schedule.push({
          season_id: seasonId,
          date_str: dateStr,
          league_level: leagueLevel,
          user_id: averagePlayer.user_id,
          opponent_user_id: null,
          opponent_type: AVERAGE_OPPONENT
        });
        pool = pool.filter(member => member.user_id !== averagePlayer.user_id);
      }

      const paired = shuffle(pool);
      for (let i = 0; i < paired.length; i += 2) {
        const a = paired[i];
        const b = paired[i + 1];
        if (!a || !b) continue;
        schedule.push({
          season_id: seasonId,
          date_str: dateStr,
          league_level: leagueLevel,
          user_id: a.user_id,
          opponent_user_id: b.user_id,
          opponent_type: 'USER'
        });
        schedule.push({
          season_id: seasonId,
          date_str: dateStr,
          league_level: leagueLevel,
          user_id: b.user_id,
          opponent_user_id: a.user_id,
          opponent_type: 'USER'
        });
      }
    }
  }
  return schedule;
}

function resultForScores(score, opponentScore) {
  if (score > opponentScore) return { result: 'W', points: 3, point_diff: score - opponentScore };
  if (score < opponentScore) return { result: 'L', points: 0, point_diff: score - opponentScore };
  return { result: 'T', points: 1, point_diff: 0 };
}

function formatRecord(row) {
  return `${row.wins}-${row.losses}-${row.ties}`;
}

async function setupLeagueDB(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_seasons (
      id            SERIAL PRIMARY KEY,
      season_number INTEGER NOT NULL UNIQUE,
      start_date    TEXT NOT NULL,
      end_date      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_memberships (
      id           SERIAL PRIMARY KEY,
      season_id    INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      league_level INTEGER NOT NULL,
      seed_average NUMERIC NOT NULL DEFAULT 0,
      joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_matchups (
      id               SERIAL PRIMARY KEY,
      season_id         INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
      date_str          TEXT NOT NULL,
      league_level      INTEGER NOT NULL,
      user_id           TEXT NOT NULL,
      opponent_user_id  TEXT,
      opponent_type     TEXT NOT NULL DEFAULT 'USER',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, date_str, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_results (
      id             SERIAL PRIMARY KEY,
      season_id      INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
      date_str       TEXT NOT NULL,
      league_level   INTEGER NOT NULL,
      user_id        TEXT NOT NULL,
      opponent_user_id TEXT,
      opponent_type  TEXT NOT NULL,
      result         TEXT NOT NULL,
      league_points  INTEGER NOT NULL,
      score          INTEGER,
      opponent_score NUMERIC,
      point_diff     NUMERIC NOT NULL DEFAULT 0,
      result_type    TEXT NOT NULL DEFAULT 'normal',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, date_str, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_titles (
      id             SERIAL PRIMARY KEY,
      season_id      INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
      season_number  INTEGER NOT NULL,
      league_level   INTEGER NOT NULL,
      user_id        TEXT NOT NULL,
      username       TEXT NOT NULL,
      points         INTEGER NOT NULL,
      point_diff     NUMERIC NOT NULL DEFAULT 0,
      awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, league_level)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_exclusions (
      user_id        TEXT PRIMARY KEY,
      username       TEXT NOT NULL,
      reason         TEXT NOT NULL,
      season_id      INTEGER REFERENCES league_seasons(id) ON DELETE SET NULL,
      no_show_count  INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_state (
      id                         INTEGER PRIMARY KEY DEFAULT 1,
      last_finalized_date        TEXT,
      last_league_post_date      TEXT,
      last_league_reminder_date  TEXT
    )
  `);
  await pool.query('ALTER TABLE league_state ADD COLUMN IF NOT EXISTS last_league_reminder_date TEXT');
  await pool.query('INSERT INTO league_state (id) VALUES (1) ON CONFLICT DO NOTHING');
  console.log('League DB ready');
}

async function getSeasonForDate(pool, dateStr) {
  const { rows } = await pool.query(
    `SELECT * FROM league_seasons
     WHERE start_date <= $1 AND end_date >= $1
     ORDER BY season_number DESC
     LIMIT 1`,
    [dateStr]
  );
  return rows[0] || null;
}

async function getLatestSeason(pool) {
  const { rows } = await pool.query('SELECT * FROM league_seasons ORDER BY season_number DESC LIMIT 1');
  return rows[0] || null;
}

async function loadPlayerAverages(pool, startDate) {
  const { rows } = await pool.query(
    `SELECT user_id, username, score, date_str
     FROM scores
     WHERE date_str < $1
     ORDER BY date_str`,
    [startDate]
  );
  const players = buildPlayerAverages(rows, startDate);
  const { rows: excludedRows } = await pool.query('SELECT user_id FROM league_exclusions');
  const excluded = new Set(excludedRows.map(row => row.user_id));
  return players.filter(player => !excluded.has(player.user_id));
}

async function insertSeason(pool, seasonNumber, startDate, memberships) {
  const endDate = dateAdd(startDate, SEASON_LENGTH_DAYS - 1);
  const { rows } = await pool.query(
    `INSERT INTO league_seasons (season_number, start_date, end_date, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING *`,
    [seasonNumber, startDate, endDate]
  );
  const season = rows[0];

  for (const member of memberships) {
    await pool.query(
      `INSERT INTO league_memberships (season_id, user_id, username, league_level, seed_average)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (season_id, user_id) DO UPDATE SET
         username = EXCLUDED.username,
         league_level = EXCLUDED.league_level,
         seed_average = EXCLUDED.seed_average`,
      [season.id, member.user_id, member.username, member.league_level, member.seed_average || 0]
    );
  }

  const schedule = generateSeasonSchedule(memberships, startDate, season.id);
  for (const matchup of schedule) {
    await pool.query(
      `INSERT INTO league_matchups (season_id, date_str, league_level, user_id, opponent_user_id, opponent_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (season_id, date_str, user_id) DO NOTHING`,
      [
        matchup.season_id,
        matchup.date_str,
        matchup.league_level,
        matchup.user_id,
        matchup.opponent_user_id,
        matchup.opponent_type
      ]
    );
  }

  console.log(`League season ${seasonNumber} ready (${startDate} to ${endDate})`);
  return season;
}

async function buildStandings(pool, seasonId) {
  const { rows } = await pool.query(
    `SELECT
       m.user_id,
       m.username,
       m.league_level,
       m.seed_average::float AS seed_average,
       COALESCE(SUM(r.league_points), 0)::int AS points,
       COALESCE(SUM(CASE WHEN r.result = 'W' THEN 1 ELSE 0 END), 0)::int AS wins,
       COALESCE(SUM(CASE WHEN r.result = 'L' THEN 1 ELSE 0 END), 0)::int AS losses,
       COALESCE(SUM(CASE WHEN r.result = 'T' THEN 1 ELSE 0 END), 0)::int AS ties,
       COALESCE(SUM(r.point_diff), 0)::float AS point_diff,
       COALESCE(SUM(r.score), 0)::int AS total_score
     FROM league_memberships m
     LEFT JOIN league_results r
       ON r.season_id = m.season_id AND r.user_id = m.user_id
     WHERE m.season_id = $1
     GROUP BY m.user_id, m.username, m.league_level, m.seed_average
     ORDER BY m.league_level ASC`,
    [seasonId]
  );

  const byLeague = {};
  for (const row of rows) {
    if (!byLeague[row.league_level]) byLeague[row.league_level] = [];
    byLeague[row.league_level].push(row);
  }
  for (const level of Object.keys(byLeague)) byLeague[level] = rankStandings(byLeague[level]);
  return byLeague;
}

async function recordLeagueTitles(pool, season) {
  const standings = await buildStandings(pool, season.id);
  for (const level of [1, 2, 3]) {
    const champion = standings[level]?.[0];
    if (!champion) continue;
    await pool.query(
      `INSERT INTO league_titles (
         season_id, season_number, league_level, user_id, username, points, point_diff
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (season_id, league_level) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         username = EXCLUDED.username,
         points = EXCLUDED.points,
         point_diff = EXCLUDED.point_diff`,
      [
        season.id,
        season.season_number,
        level,
        champion.user_id,
        champion.username,
        champion.points,
        champion.point_diff
      ]
    );
  }
}

async function recordNoShowExclusions(pool, season) {
  const { rows } = await pool.query(
    `SELECT r.user_id, m.username, COUNT(*)::int AS no_show_count
     FROM league_results r
     JOIN league_memberships m ON m.season_id = r.season_id AND m.user_id = r.user_id
     WHERE r.season_id = $1
       AND r.result_type IN ('no_show', 'double_no_show', 'forfeit_loss')
     GROUP BY r.user_id, m.username
     HAVING COUNT(*) >= $2`,
    [season.id, NO_SHOW_REMOVAL_THRESHOLD]
  );

  for (const row of rows) {
    await pool.query(
      `INSERT INTO league_exclusions (user_id, username, reason, season_id, no_show_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username,
         reason = EXCLUDED.reason,
         season_id = EXCLUDED.season_id,
         no_show_count = EXCLUDED.no_show_count`,
      [row.user_id, row.username, 'season_no_show', season.id, row.no_show_count]
    );
  }
  return rows;
}

async function createInitialSeason(pool, startDate) {
  const players = await loadPlayerAverages(pool, startDate);
  const memberships = seedInitialMemberships(players);
  return insertSeason(pool, 1, startDate, memberships);
}

async function createNextSeason(pool, startDate, previousSeason) {
  const standings = await buildStandings(pool, previousSeason.id);
  await recordLeagueTitles(pool, previousSeason);
  const removedForNoShows = await recordNoShowExclusions(pool, previousSeason);
  const noShowRemovedIds = new Set(removedForNoShows.map(row => row.user_id));
  await pool.query('UPDATE league_seasons SET status = $1 WHERE id = $2', ['complete', previousSeason.id]);
  const { rows: previousMembers } = await pool.query(
    `SELECT user_id, username, league_level, seed_average::float AS seed_average
     FROM league_memberships
     WHERE season_id = $1`,
    [previousSeason.id]
  );
  const players = await loadPlayerAverages(pool, startDate);
  const known = new Set(previousMembers.map(member => member.user_id));
  const newPlayers = players.filter(player => !known.has(player.user_id));
  const eligiblePreviousMembers = previousMembers.filter(member => !noShowRemovedIds.has(member.user_id));
  const nextMemberships = applyPromotionRelegation(eligiblePreviousMembers, standings, newPlayers);

  const latestByUser = new Map(players.map(player => [player.user_id, player]));
  for (const member of nextMemberships) {
    const latest = latestByUser.get(member.user_id);
    if (!latest) continue;
    member.username = latest.username;
    member.seed_average = latest.seed_average;
  }

  return insertSeason(pool, previousSeason.season_number + 1, startDate, nextMemberships);
}

async function ensureLeagueSeasonForDate(pool, dateStr) {
  if (compareDate(dateStr, LEAGUE_LAUNCH_DATE) < 0) return null;

  const existing = await getSeasonForDate(pool, dateStr);
  if (existing) return existing;

  let latest = await getLatestSeason(pool);
  if (!latest) return createInitialSeason(pool, dateStr);
  if (compareDate(dateStr, latest.end_date) <= 0) return latest;

  while (compareDate(dateStr, latest.end_date) > 0) {
    latest = await createNextSeason(pool, dateAdd(latest.end_date, 1), latest);
  }
  return latest;
}

async function upsertResult(pool, result) {
  await pool.query(
    `INSERT INTO league_results (
       season_id, date_str, league_level, user_id, opponent_user_id, opponent_type,
       result, league_points, score, opponent_score, point_diff, result_type
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (season_id, date_str, user_id) DO UPDATE SET
       result = EXCLUDED.result,
       league_points = EXCLUDED.league_points,
       score = EXCLUDED.score,
       opponent_score = EXCLUDED.opponent_score,
       point_diff = EXCLUDED.point_diff,
       result_type = EXCLUDED.result_type`,
    [
      result.season_id,
      result.date_str,
      result.league_level,
      result.user_id,
      result.opponent_user_id || null,
      result.opponent_type,
      result.result,
      result.league_points,
      result.score,
      result.opponent_score,
      result.point_diff,
      result.result_type
    ]
  );
}

async function getScoreMap(pool, dateStr) {
  const { rows } = await pool.query(
    `SELECT user_id, username, score, channel_id, message_id
     FROM scores
     WHERE date_str = $1`,
    [dateStr]
  );
  return new Map(rows.map(row => [row.user_id, row]));
}

function reactionForResult(result) {
  if (result === 'W') return WIN_REACTION;
  if (result === 'L') return LOSS_REACTION;
  return null;
}

async function resolveLiveHeadToHeadForScore(pool, dateStr, userId) {
  const season = await ensureLeagueSeasonForDate(pool, dateStr);
  if (!season) return [];
  const { rows } = await pool.query(
    `SELECT * FROM league_matchups
     WHERE season_id = $1 AND date_str = $2 AND user_id = $3 AND opponent_type = 'USER'
     LIMIT 1`,
    [season.id, dateStr, userId]
  );
  const matchup = rows[0];
  if (!matchup) return [];

  const scoreMap = await getScoreMap(pool, dateStr);
  const mine = scoreMap.get(matchup.user_id);
  const theirs = scoreMap.get(matchup.opponent_user_id);
  if (!mine || !theirs) return [];

  const { rows: existing } = await pool.query(
    `SELECT user_id FROM league_results
     WHERE season_id = $1 AND date_str = $2 AND user_id IN ($3, $4)`,
    [season.id, dateStr, matchup.user_id, matchup.opponent_user_id]
  );
  if (existing.length >= 2) return [];

  const myResult = resultForScores(Number(mine.score), Number(theirs.score));
  const theirResult = resultForScores(Number(theirs.score), Number(mine.score));
  const common = {
    season_id: season.id,
    date_str: dateStr,
    league_level: matchup.league_level,
    opponent_type: 'USER',
    result_type: 'normal'
  };

  await upsertResult(pool, {
    ...common,
    user_id: mine.user_id,
    opponent_user_id: theirs.user_id,
    result: myResult.result,
    league_points: myResult.points,
    score: Number(mine.score),
    opponent_score: Number(theirs.score),
    point_diff: myResult.point_diff
  });
  await upsertResult(pool, {
    ...common,
    user_id: theirs.user_id,
    opponent_user_id: mine.user_id,
    result: theirResult.result,
    league_points: theirResult.points,
    score: Number(theirs.score),
    opponent_score: Number(mine.score),
    point_diff: theirResult.point_diff
  });

  return [
    { ...mine, result: myResult.result, reaction: reactionForResult(myResult.result) },
    { ...theirs, result: theirResult.result, reaction: reactionForResult(theirResult.result) }
  ].filter(row => row.reaction);
}

async function resolveLiveAverageMatchupsForScore(pool, dateStr, userId) {
  const season = await ensureLeagueSeasonForDate(pool, dateStr);
  if (!season) return [];

  const { rows: memberships } = await pool.query(
    `SELECT league_level
     FROM league_memberships
     WHERE season_id = $1 AND user_id = $2
     LIMIT 1`,
    [season.id, userId]
  );
  const membership = memberships[0];
  if (!membership) return [];

  const { rows: averageMatchups } = await pool.query(
    `SELECT *
     FROM league_matchups
     WHERE season_id = $1 AND date_str = $2 AND league_level = $3 AND opponent_type = $4`,
    [season.id, dateStr, membership.league_level, AVERAGE_OPPONENT]
  );
  if (!averageMatchups.length) return [];

  const scoreMap = await getScoreMap(pool, dateStr);
  const reactionTargets = [];

  for (const matchup of averageMatchups) {
    const averagePlayerScore = scoreMap.get(matchup.user_id);
    if (!averagePlayerScore) continue;

    const { rows: existing } = await pool.query(
      `SELECT id FROM league_results
       WHERE season_id = $1 AND date_str = $2 AND user_id = $3`,
      [season.id, dateStr, matchup.user_id]
    );
    if (existing.length) continue;

    const { rows: leagueUsers } = await pool.query(
      `SELECT user_id
       FROM league_matchups
       WHERE season_id = $1 AND date_str = $2 AND league_level = $3 AND user_id <> $4`,
      [season.id, dateStr, matchup.league_level, matchup.user_id]
    );
    const allOthersScored = leagueUsers.every(row => scoreMap.has(row.user_id));
    if (!allOthersScored) continue;

    const leagueScoreRows = leagueUsers.map(row => scoreMap.get(row.user_id));
    if (!leagueScoreRows.length) continue;

    const opponentAverage = leagueScoreRows.reduce((sum, row) => sum + Number(row.score), 0) / leagueScoreRows.length;
    const resolved = resultForScores(Number(averagePlayerScore.score), opponentAverage);
    await upsertResult(pool, {
      season_id: season.id,
      date_str: dateStr,
      league_level: matchup.league_level,
      user_id: matchup.user_id,
      opponent_user_id: null,
      opponent_type: AVERAGE_OPPONENT,
      result: resolved.result,
      league_points: resolved.points,
      score: Number(averagePlayerScore.score),
      opponent_score: opponentAverage,
      point_diff: resolved.point_diff,
      result_type: 'average'
    });
    const reaction = reactionForResult(resolved.result);
    if (reaction) reactionTargets.push({ ...averagePlayerScore, reaction });
  }

  return reactionTargets;
}

async function finalizeLeagueDate(pool, dateStr) {
  const season = await getSeasonForDate(pool, dateStr);
  if (!season) return { season: null, results: [] };

  const { rows: matchups } = await pool.query(
    `SELECT * FROM league_matchups
     WHERE season_id = $1 AND date_str = $2
     ORDER BY league_level, user_id`,
    [season.id, dateStr]
  );
  const scoreMap = await getScoreMap(pool, dateStr);
  const handled = new Set();
  const reactionTargets = [];

  for (const matchup of matchups.filter(row => row.opponent_type === 'USER')) {
    const pairKey = [matchup.user_id, matchup.opponent_user_id].sort().join(':');
    if (handled.has(pairKey)) continue;
    handled.add(pairKey);

    const mine = scoreMap.get(matchup.user_id);
    const theirs = scoreMap.get(matchup.opponent_user_id);
    if (mine && theirs) {
      const myResult = resultForScores(Number(mine.score), Number(theirs.score));
      const theirResult = resultForScores(Number(theirs.score), Number(mine.score));
      await upsertResult(pool, {
        season_id: season.id,
        date_str: dateStr,
        league_level: matchup.league_level,
        user_id: mine.user_id,
        opponent_user_id: theirs.user_id,
        opponent_type: 'USER',
        result: myResult.result,
        league_points: myResult.points,
        score: Number(mine.score),
        opponent_score: Number(theirs.score),
        point_diff: myResult.point_diff,
        result_type: 'normal'
      });
      await upsertResult(pool, {
        season_id: season.id,
        date_str: dateStr,
        league_level: matchup.league_level,
        user_id: theirs.user_id,
        opponent_user_id: mine.user_id,
        opponent_type: 'USER',
        result: theirResult.result,
        league_points: theirResult.points,
        score: Number(theirs.score),
        opponent_score: Number(mine.score),
        point_diff: theirResult.point_diff,
        result_type: 'normal'
      });
      if (reactionForResult(myResult.result)) reactionTargets.push({ ...mine, reaction: reactionForResult(myResult.result) });
      if (reactionForResult(theirResult.result)) reactionTargets.push({ ...theirs, reaction: reactionForResult(theirResult.result) });
      continue;
    }

    if (!mine && !theirs) {
      for (const uid of [matchup.user_id, matchup.opponent_user_id]) {
        await upsertResult(pool, {
          season_id: season.id,
          date_str: dateStr,
          league_level: matchup.league_level,
          user_id: uid,
          opponent_user_id: uid === matchup.user_id ? matchup.opponent_user_id : matchup.user_id,
          opponent_type: 'USER',
          result: 'L',
          league_points: 0,
          score: null,
          opponent_score: null,
          point_diff: 0,
          result_type: 'double_no_show'
        });
      }
    }
  }

  for (const matchup of matchups.filter(row => row.opponent_type === AVERAGE_OPPONENT)) {
    const score = scoreMap.get(matchup.user_id);
    if (!score) {
      await upsertResult(pool, {
        season_id: season.id,
        date_str: dateStr,
        league_level: matchup.league_level,
        user_id: matchup.user_id,
        opponent_user_id: null,
        opponent_type: AVERAGE_OPPONENT,
        result: 'L',
        league_points: 0,
        score: null,
        opponent_score: null,
        point_diff: 0,
        result_type: 'no_show'
      });
      continue;
    }

    const leagueScoreRows = matchups
      .filter(row => row.league_level === matchup.league_level && row.user_id !== matchup.user_id)
      .map(row => scoreMap.get(row.user_id))
      .filter(Boolean);
    let opponentAverage;
    if (leagueScoreRows.length) {
      opponentAverage = leagueScoreRows.reduce((sum, row) => sum + Number(row.score), 0) / leagueScoreRows.length;
    } else {
      const { rows: seedRows } = await pool.query(
        `SELECT AVG(seed_average)::float AS avg
         FROM league_memberships
         WHERE season_id = $1 AND league_level = $2 AND user_id <> $3`,
        [season.id, matchup.league_level, matchup.user_id]
      );
      opponentAverage = Number(seedRows[0]?.avg || score.score);
    }

    const resolved = resultForScores(Number(score.score), opponentAverage);
    await upsertResult(pool, {
      season_id: season.id,
      date_str: dateStr,
      league_level: matchup.league_level,
      user_id: matchup.user_id,
      opponent_user_id: null,
      opponent_type: AVERAGE_OPPONENT,
      result: resolved.result,
      league_points: resolved.points,
      score: Number(score.score),
      opponent_score: opponentAverage,
      point_diff: resolved.point_diff,
      result_type: 'average'
    });
    if (reactionForResult(resolved.result)) reactionTargets.push({ ...score, reaction: reactionForResult(resolved.result) });
  }

  const { rows: nonForfeitDiffs } = await pool.query(
    `SELECT league_level, AVG(point_diff)::float AS avg_diff
     FROM league_results
     WHERE season_id = $1 AND date_str = $2 AND result_type IN ('normal', 'average')
     GROUP BY league_level`,
    [season.id, dateStr]
  );
  const diffByLeague = new Map(nonForfeitDiffs.map(row => [row.league_level, Number(row.avg_diff || 0)]));

  const handledForfeits = new Set();
  for (const matchup of matchups.filter(row => row.opponent_type === 'USER')) {
    const pairKey = [matchup.user_id, matchup.opponent_user_id].sort().join(':');
    if (handledForfeits.has(pairKey)) continue;
    handledForfeits.add(pairKey);

    const mine = scoreMap.get(matchup.user_id);
    const theirs = scoreMap.get(matchup.opponent_user_id);
    if ((mine && theirs) || (!mine && !theirs)) continue;

    const winner = mine || theirs;
    const loserId = mine ? matchup.opponent_user_id : matchup.user_id;
    const winnerDiff = diffByLeague.get(matchup.league_level) || 0;
    await upsertResult(pool, {
      season_id: season.id,
      date_str: dateStr,
      league_level: matchup.league_level,
      user_id: winner.user_id,
      opponent_user_id: loserId,
      opponent_type: 'USER',
      result: 'W',
      league_points: 3,
      score: Number(winner.score),
      opponent_score: null,
      point_diff: winnerDiff,
      result_type: 'forfeit_win'
    });
    await upsertResult(pool, {
      season_id: season.id,
      date_str: dateStr,
      league_level: matchup.league_level,
      user_id: loserId,
      opponent_user_id: winner.user_id,
      opponent_type: 'USER',
      result: 'L',
      league_points: 0,
      score: null,
      opponent_score: Number(winner.score),
      point_diff: 0,
      result_type: 'forfeit_loss'
    });
    reactionTargets.push({ ...winner, reaction: WIN_REACTION });
  }

  await pool.query('UPDATE league_state SET last_finalized_date = $1 WHERE id = 1', [dateStr]);
  return { season, results: await getLeagueResultsForDate(pool, season.id, dateStr), reactionTargets };
}

async function getLeagueResultsForDate(pool, seasonId, dateStr) {
  const { rows } = await pool.query(
    `SELECT r.*, m.username, om.username AS opponent_username
     FROM league_results r
     JOIN league_memberships m ON m.season_id = r.season_id AND m.user_id = r.user_id
     LEFT JOIN league_memberships om ON om.season_id = r.season_id AND om.user_id = r.opponent_user_id
     WHERE r.season_id = $1 AND r.date_str = $2
     ORDER BY r.league_level, r.result DESC, r.point_diff DESC, m.username`,
    [seasonId, dateStr]
  );
  return rows;
}

async function getLeagueTitleTracker(pool) {
  const { rows } = await pool.query(
    `SELECT league_level, user_id, username, COUNT(*)::int AS titles
     FROM league_titles
     GROUP BY league_level, user_id, username
     ORDER BY league_level ASC, titles DESC, username ASC`
  );
  const byLeague = {};
  for (const row of rows) {
    if (!byLeague[row.league_level]) byLeague[row.league_level] = [];
    byLeague[row.league_level].push(row);
  }
  return byLeague;
}

async function getScheduleForDate(pool, dateStr) {
  const season = await ensureLeagueSeasonForDate(pool, dateStr);
  if (!season) return { season: null, schedule: [] };
  const { rows } = await pool.query(
    `SELECT lm.*, m.username, om.username AS opponent_username
     FROM league_matchups lm
     JOIN league_memberships m ON m.season_id = lm.season_id AND m.user_id = lm.user_id
     LEFT JOIN league_memberships om ON om.season_id = lm.season_id AND om.user_id = lm.opponent_user_id
     WHERE lm.season_id = $1 AND lm.date_str = $2
     ORDER BY lm.league_level, m.username`,
    [season.id, dateStr]
  );
  return { season, schedule: rows };
}

async function getLeagueReminderTargets(pool, dateStr) {
  const season = await ensureLeagueSeasonForDate(pool, dateStr);
  if (!season) return { season: null, targets: [] };

  const { rows } = await pool.query(
    `SELECT DISTINCT
       lm.league_level,
       lm.user_id,
       m.username
     FROM league_matchups lm
     JOIN league_memberships m
       ON m.season_id = lm.season_id AND m.user_id = lm.user_id
     LEFT JOIN scores s
       ON s.user_id = lm.user_id AND s.date_str = lm.date_str
     WHERE lm.season_id = $1
       AND lm.date_str = $2
       AND s.user_id IS NULL
     ORDER BY lm.league_level, m.username`,
    [season.id, dateStr]
  );

  return { season, targets: rows };
}

function formatPointDiff(value) {
  const n = Number(value || 0);
  const rounded = Math.round(n * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function formatScore(value) {
  if (value === null || value === undefined) return 'DNS';
  const n = Number(value);
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function buildSeasonAwards(standings, season = {}) {
  const allPlayers = flattenStandings(standings);
  const leagueWinners = [1, 2, 3]
    .map(level => ({ league_level: level, winner: standings[level]?.[0] || null }))
    .filter(row => row.winner);
  const dunceTable = standings[3] || [];
  const chosenOne = dunceTable[dunceTable.length - 1] || null;
  const mostScored = allPlayers
    .slice()
    .sort((a, b) =>
      b.total_score - a.total_score ||
      b.points - a.points ||
      b.point_diff - a.point_diff ||
      a.username.localeCompare(b.username)
    )[0] || null;
  const israelAward = allPlayers
    .filter(row => Number(row.wins || 0) >= 3)
    .sort((a, b) =>
      a.point_diff - b.point_diff ||
      a.total_score - b.total_score ||
      b.wins - a.wins ||
      a.username.localeCompare(b.username)
    )[0] || null;

  return {
    season_number: season.season_number,
    leagueWinners,
    chosenOne,
    mostScored,
    israelAward
  };
}

function formatTitleTracker(titles) {
  const lines = [];
  for (const level of [1, 2, 3]) {
    const leagueTitles = titles[level] || [];
    if (!leagueTitles.length) continue;
    const leaders = leagueTitles
      .slice(0, 3)
      .map(row => `${row.username} x${row.titles}`)
      .join(', ');
    lines.push(`${LEAGUE_NAMES[level]}: ${leaders}`);
  }
  return lines;
}

function formatLeagueReminder(dateStr, targets) {
  if (!targets.length) return null;
  const lines = [
    `**MapTap League Reminder - ${dateStr}**`,
    '9 PM check-in. Still need scores from:'
  ];

  for (const level of [1, 2, 3]) {
    const leagueTargets = targets.filter(row => row.league_level === level);
    if (!leagueTargets.length) continue;
    lines.push(`${LEAGUE_NAMES[level]}: ${leagueTargets.map(row => `<@${row.user_id}>`).join(' ')}`);
  }

  return lines.join('\n');
}

function formatSeasonAwardsPanel(awards) {
  if (!awards) return null;
  const title = awards.season_number
    ? `**Season ${awards.season_number} Special Awards**`
    : '**Season Special Awards**';
  const lines = [title];

  if (awards.leagueWinners?.length) {
    lines.push('**League Winners**');
    for (const row of awards.leagueWinners) {
      lines.push(`${LEAGUE_NAMES[row.league_level]}: ${row.winner.username}`);
    }
  }

  if (awards.chosenOne) {
    lines.push('', `**The Chosen One**: ${awards.chosenOne.username} (${LEAGUE_NAMES[3]} last place)`);
  }

  if (awards.mostScored) {
    lines.push(`**Most Points Scored**: ${awards.mostScored.username} - ${formatScore(awards.mostScored.total_score)} scored`);
  }

  if (awards.israelAward) {
    lines.push(`**Israel Award**: ${awards.israelAward.username} - ${awards.israelAward.wins} wins, ${formatPointDiff(awards.israelAward.point_diff)} diff, ${formatScore(awards.israelAward.total_score)} scored`);
  }

  return lines.join('\n');
}

function formatLeagueUpdate({ dateStr, results, standings, titles, scheduleDate, schedule }) {
  const sections = [`**MapTap Leagues - ${dateStr}**`];

  sections.push('**Results**');
  for (const level of [1, 2, 3]) {
    const leagueResults = results.filter(row => row.league_level === level);
    if (!leagueResults.length) continue;
    sections.push(`__${LEAGUE_NAMES[level]}__`);
    const seenPairs = new Set();
    for (const row of leagueResults) {
      if (row.opponent_type === 'USER') {
        const key = [row.user_id, row.opponent_user_id].sort().join(':');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const other = leagueResults.find(r => r.user_id === row.opponent_user_id);
        if (!other) continue;
        sections.push(`${row.username} ${formatScore(row.score)} - ${formatScore(other.score)} ${other.username}`);
      } else {
        sections.push(`${row.username} ${formatScore(row.score)} vs Avg ${formatScore(row.opponent_score)} (${row.result})`);
      }
    }
  }
  if (sections[sections.length - 1] === '**Results**') sections.push('_No league results finalized._');

  sections.push('', '**Tables**');
  for (const level of [1, 2, 3]) {
    const table = standings[level] || [];
    if (!table.length) continue;
    sections.push(`__${LEAGUE_NAMES[level]}__`);
    for (const row of table) {
      sections.push(`${row.points} pts | ${formatRecord(row)} | ${formatPointDiff(row.point_diff)} | ${formatScore(row.total_score)} scored | ${row.username}`);
    }
  }

  sections.push('', '**Titles**');
  const titleLines = formatTitleTracker(titles || {});
  if (titleLines.length) sections.push(...titleLines);
  else sections.push('_No league titles awarded yet._');

  sections.push('', `**Schedule - ${scheduleDate}**`);
  for (const level of [1, 2, 3]) {
    const leagueSchedule = schedule.filter(row => row.league_level === level);
    if (!leagueSchedule.length) continue;
    sections.push(`__${LEAGUE_NAMES[level]}__`);
    const seenPairs = new Set();
    for (const row of leagueSchedule) {
      if (row.opponent_type === AVERAGE_OPPONENT) {
        sections.push(`${row.username} vs League Average`);
        continue;
      }
      const key = [row.user_id, row.opponent_user_id].sort().join(':');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      sections.push(`${row.username} vs ${row.opponent_username}`);
    }
  }

  return sections.join('\n');
}

function splitDiscordMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function buildDailyLeagueMessages(pool, resultDate, scheduleDate) {
  const finalized = await finalizeLeagueDate(pool, resultDate);
  const scheduleInfo = await getScheduleForDate(pool, scheduleDate);
  const standingsSeason = finalized.season || scheduleInfo.season;
  if (!standingsSeason) return { messages: [], reactionTargets: [] };
  const standings = await buildStandings(pool, standingsSeason.id);
  const titles = await getLeagueTitleTracker(pool);
  const awardsText = finalized.season && resultDate === finalized.season.end_date
    ? formatSeasonAwardsPanel(buildSeasonAwards(standings, finalized.season))
    : null;
  const text = formatLeagueUpdate({
    dateStr: resultDate,
    results: finalized.results || [],
    standings,
    titles,
    scheduleDate,
    schedule: scheduleInfo.schedule || []
  });
  return {
    messages: awardsText ? [...splitDiscordMessage(text), awardsText] : splitDiscordMessage(text),
    reactionTargets: finalized.reactionTargets || []
  };
}

async function buildCurrentLeagueMessages(pool, dateStr) {
  const viewDate = compareDate(dateStr, LEAGUE_LAUNCH_DATE) < 0 ? LEAGUE_LAUNCH_DATE : dateStr;
  const scheduleInfo = await getScheduleForDate(pool, viewDate);
  const season = scheduleInfo.season;
  if (!season) return { messages: [] };
  const standings = await buildStandings(pool, season.id);
  const titles = await getLeagueTitleTracker(pool);
  const results = await getLeagueResultsForDate(pool, season.id, dateStr);
  const text = formatLeagueUpdate({
    dateStr: viewDate,
    results,
    standings,
    titles,
    scheduleDate: viewDate,
    schedule: scheduleInfo.schedule || []
  });
  return { messages: splitDiscordMessage(text) };
}

module.exports = {
  AVERAGE_OPPONENT,
  EXCLUDED_LEAGUE_USER_IDS,
  LEAGUE_LAUNCH_DATE,
  LEAGUE_NAMES,
  LOSS_REACTION,
  NO_SHOW_REMOVAL_THRESHOLD,
  SEASON_LENGTH_DAYS,
  WIN_REACTION,
  applyPromotionRelegation,
  buildCurrentLeagueMessages,
  buildDailyLeagueMessages,
  buildPlayerAverages,
  buildSeasonAwards,
  buildStandings,
  dateAdd,
  ensureLeagueSeasonForDate,
  finalizeLeagueDate,
  formatLeagueUpdate,
  formatLeagueReminder,
  formatSeasonAwardsPanel,
  formatTitleTracker,
  generateSeasonSchedule,
  getLeagueReminderTargets,
  getLeagueTitleTracker,
  rankStandings,
  recordNoShowExclusions,
  recordLeagueTitles,
  resolveLiveHeadToHeadForScore,
  resolveLiveAverageMatchupsForScore,
  resultForScores,
  seedInitialMemberships,
  setupLeagueDB,
  splitDiscordMessage
};
