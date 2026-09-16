const assert = require('assert');
const {
  AVERAGE_OPPONENT,
  EXCLUDED_LEAGUE_USER_IDS,
  LEAGUE_LAUNCH_DATE,
  LEAGUE_NAMES,
  NO_SHOW_REMOVAL_THRESHOLD,
  applyPromotionRelegation,
  assignRoundIndices,
  buildCurrentLeagueMessages,
  buildPlayerAverages,
  createNextSeason,
  buildSeasonAwards,
  dateAdd,
  formatLeagueSections,
  formatLeagueUpdate,
  formatSeasonAwardsPanel,
  formatTitleTracker,
  generateSeasonSchedule,
  rankStandings,
  seasonDayNumber,
  resolveLiveAverageMatchupsForScore,
  resultForScores,
  seedInitialMemberships,
  seasonAwardUserIds,
  splitDiscordMessage
} = require('./leagues');

function scoreRows(userId, username, scores, startDate = '2026-06-01') {
  return scores.map((score, idx) => ({
    user_id: userId,
    username,
    score,
    date_str: dateAdd(startDate, idx)
  }));
}

function testInitialSeeding() {
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push(...scoreRows(`u${i}`, `P${i}`, Array(10).fill(1000 - i), '2026-05-15'));
  }
  rows.push(...scoreRows('newbie', 'Newbie', [900], '2026-05-29'));
  const players = buildPlayerAverages(rows, '2026-06-01');
  const seeded = seedInitialMemberships(players);
  assert.strictEqual(seeded.length, 13);
  assert(seeded.every(p => p.league_level === 1));
}

function testLeagueExclusions() {
  const excludedId = [...EXCLUDED_LEAGUE_USER_IDS][0];
  const players = buildPlayerAverages([
    ...scoreRows(excludedId, 'Excluded', Array(10).fill(900), '2026-05-15'),
    ...scoreRows('active', 'Active', Array(10).fill(800), '2026-05-15')
  ], '2026-06-01');
  assert(!players.some(player => player.user_id === excludedId));
  assert(players.some(player => player.user_id === 'active'));
}

function testScheduleGeneration() {
  const members = [
    { user_id: 'a', league_level: 1 },
    { user_id: 'b', league_level: 1 },
    { user_id: 'c', league_level: 1 },
    { user_id: 'd', league_level: 1 },
    { user_id: 'e', league_level: 1 }
  ];
  const schedule = generateSeasonSchedule(members, '2026-06-01', 1);
  assert.strictEqual(schedule.filter(m => m.league_level === 1 && m.opponent_type === AVERAGE_OPPONENT).length, 10);
  for (let day = 0; day < 10; day++) {
    const date = dateAdd('2026-06-01', day);
    assert.strictEqual(schedule.filter(m => m.date_str === date && m.league_level === 1).length, 5);
  }

  const topLeague = ['a', 'b', 'c', 'd', 'e'].map(user_id => ({ user_id, league_level: 1 }));
  const topSchedule = generateSeasonSchedule(topLeague, '2026-06-01', 1);
  const topPairs = pairCounts(topSchedule.filter(m => m.opponent_type === 'USER'));
  assert.strictEqual(topPairs.size, 10);
  for (const count of topPairs.values()) assert.strictEqual(count, 2);
  for (const member of topLeague) {
    assert.strictEqual(topSchedule.filter(m => m.user_id === member.user_id && m.opponent_type === AVERAGE_OPPONENT).length, 2);
  }

  const soloSchedule = generateSeasonSchedule([{ user_id: 'solo', league_level: 1 }], '2026-06-01', 1);
  assert.strictEqual(soloSchedule.filter(m => m.opponent_type === AVERAGE_OPPONENT).length, 10);

  const largeLeague = Array.from({ length: 10 }, (_, idx) => ({ user_id: `d${idx}`, league_level: 1 }));
  const largeSchedule = generateSeasonSchedule(largeLeague, '2026-06-01', 1);
  const largePairs = pairCounts(largeSchedule);
  assert.strictEqual(largePairs.size, 45);
  // 10 days x 5 pairs per round = 50 total meetings (full round-robin + one rematch round).
  assert.strictEqual([...largePairs.values()].reduce((sum, count) => sum + count, 0), 50);
  assert.strictEqual(largeSchedule.filter(m => m.opponent_type === AVERAGE_OPPONENT).length, 0);
}

function pairCounts(schedule) {
  const counts = new Map();
  for (const row of schedule) {
    if (row.opponent_type !== 'USER') continue;
    if (row.user_id > row.opponent_user_id) continue;
    const key = [row.user_id, row.opponent_user_id].sort().join(':');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function testResultsAndStandings() {
  assert.deepStrictEqual(resultForScores(900, 850), { result: 'W', points: 3, point_diff: 50 });
  assert.deepStrictEqual(resultForScores(850, 900), { result: 'L', points: 0, point_diff: -50 });
  assert.deepStrictEqual(resultForScores(900, 900), { result: 'T', points: 1, point_diff: 0 });

  const standings = rankStandings([
    { username: 'B', points: 6, point_diff: 1, total_score: 100, seed_average: 800 },
    { username: 'A', points: 6, point_diff: 5, total_score: 80, seed_average: 700 },
    { username: 'C', points: 3, point_diff: 100, total_score: 1000, seed_average: 900 }
  ]);
  assert.strictEqual(standings[0].username, 'B');
}

function testPromotionRelegation() {
  const members = [
    { user_id: 'p1', username: 'P1', league_level: 1 },
    { user_id: 'p2', username: 'P2', league_level: 1 },
    { user_id: 'c1', username: 'C1', league_level: 2 },
    { user_id: 'c2', username: 'C2', league_level: 2 },
    { user_id: 'l1', username: 'L1', league_level: 3 }
  ];
  const next = applyPromotionRelegation(members, {}, [{ user_id: 'new', username: 'New', seed_average: 700 }]);
  assert.strictEqual(next.length, 6);
  assert(next.every(p => p.league_level === 1));
  assert.strictEqual(next.find(p => p.user_id === 'new').league_level, 1);
}

function testNoShowRemovalThreshold() {
  assert.strictEqual(NO_SHOW_REMOVAL_THRESHOLD, 7);
  const members = [
    { user_id: 'active', username: 'Active', league_level: 3 },
    { user_id: 'ghost', username: 'Ghost', league_level: 3 }
  ];
  const removed = new Set(['ghost']);
  const next = members.filter(member => !removed.has(member.user_id));
  assert(next.some(member => member.user_id === 'active'));
  assert(!next.some(member => member.user_id === 'ghost'));
}

function testMessageSplit() {
  const chunks = splitDiscordMessage(Array(200).fill('line').join('\n'), 100);
  assert(chunks.length > 1);
  assert(chunks.every(chunk => chunk.length <= 100));
}

function testLeagueNamesAndTitles() {
  assert.strictEqual(LEAGUE_LAUNCH_DATE, '2026-06-29');
  assert.strictEqual(LEAGUE_NAMES[1], 'MapTap League');

  const titleLines = formatTitleTracker({
    1: [{ username: 'A', titles: 2 }]
  });
  assert(titleLines.includes('MapTap League: A x2'));

  const message = formatLeagueUpdate({
    dateStr: '2026-06-01',
    results: [],
    standings: {
      1: [{
        username: 'A',
        points: 6,
        wins: 2,
        losses: 0,
        ties: 0,
        point_diff: 123.4,
        total_score: 8123
      }, {
        username: 'League Average',
        points: 3,
        wins: 1,
        losses: 1,
        ties: 0,
        point_diff: -12,
        total_score: 1600
      }]
    },
    titles: { 1: [{ username: 'A', titles: 2 }] },
    scheduleDate: '2026-06-02',
    schedule: []
  });
  assert(message.includes('**Titles**'));
  assert(message.includes('MapTap League: A x2'));
  assert(message.includes('8,123 scored | A'));
  assert(message.includes('1,600 scored | League Average'));
}

function testSeasonAwardsPanel() {
  const standings = {
    1: [
      { user_id: 'tism', username: 'Tism Champ', points: 20, wins: 6, point_diff: 100, total_score: 8000, seed_average: 800 },
      { user_id: 'israel', username: 'Right Day Merchant', points: 15, wins: 5, point_diff: -250, total_score: 6100, seed_average: 610 },
      { user_id: 'tism-low', username: 'Tism Low', points: 6, wins: 2, point_diff: -20, total_score: 7000, seed_average: 700 },
      { user_id: 'chosen', username: 'Chosen', points: 0, wins: 0, point_diff: -500, total_score: 3000, seed_average: 300 },
      { user_id: 'scored', username: 'Scored Champ', points: 18, wins: 6, point_diff: 300, total_score: 8100, seed_average: 810 }
    ]
  };
  const awards = buildSeasonAwards(standings, { season_number: 1 });
  assert.strictEqual(awards.leagueWinners[0].winner.username, 'Tism Champ');
  assert.strictEqual(awards.chosenOne.username, 'Chosen');
  assert.strictEqual(awards.mostScored.username, 'Scored Champ');
  assert.strictEqual(awards.israelAward.username, 'Right Day Merchant');

  const panel = formatSeasonAwardsPanel(awards);
  assert(panel.includes('**Season 1 Special Awards**'));
  assert(panel.includes('MapTap League: <@tism>'));
  assert(panel.includes('**The Chosen One**: <@chosen>'));
  assert(panel.includes('**Most Points Scored**: <@scored> - 8,100 scored'));
  assert(panel.includes('**Israel Award**: <@israel> - 5 wins, -250 diff, 6,100 scored'));
  assert.deepStrictEqual(seasonAwardUserIds(awards), ['tism', 'chosen', 'scored', 'israel']);
}

function testLiveAverageResolverExport() {
  assert.strictEqual(typeof resolveLiveAverageMatchupsForScore, 'function');
}

function testAssignRoundIndices() {
  assert.deepStrictEqual(assignRoundIndices(0, 10), []);

  // Small league: full round-robin runs exactly twice over 10 days.
  const small = assignRoundIndices(5, 10);
  assert.strictEqual(small.length, 10);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(small.filter(idx => idx === i).length, 2);
  }

  // Dunce (10 players -> 9 rounds): every round once, plus exactly one repeat.
  const dunce = assignRoundIndices(9, 10);
  assert.strictEqual(dunce.length, 10);
  for (let i = 0; i < 9; i++) assert(dunce.includes(i));
  const dunceRepeats = [...new Set(dunce)].filter(i => dunce.filter(x => x === i).length > 1);
  assert.strictEqual(dunceRepeats.length, 1);

  // Middle case (7 rounds): rematch rounds chosen evenly across the cycle (0, 2, 4), not 0, 1, 2.
  const mid = assignRoundIndices(7, 10);
  assert.strictEqual(mid.length, 10);
  const midRepeats = [...new Set(mid)].filter(i => mid.filter(x => x === i).length > 1).sort((a, b) => a - b);
  assert.deepStrictEqual(midRepeats, [0, 2, 4]);

  // Large league (12 rounds > 10 days): 10 distinct rounds, no pair meets twice.
  const large = assignRoundIndices(12, 10);
  assert.strictEqual(large.length, 10);
  assert.strictEqual(new Set(large).size, 10);
}

function testSeasonDayNumber() {
  const season = { start_date: '2026-06-29' };
  assert.strictEqual(seasonDayNumber(null, '2026-06-29'), null);
  assert.strictEqual(seasonDayNumber(season, '2026-06-29'), 1);
  assert.strictEqual(seasonDayNumber(season, '2026-07-03'), 5);
  assert.strictEqual(seasonDayNumber(season, '2026-06-28'), 1); // clamps below 1
  assert.strictEqual(seasonDayNumber(season, '2026-07-20'), 10); // clamps above SEASON_LENGTH_DAYS
}

function testLeagueSections() {
  // Daily post: results date (day 3) and schedule date (day 4) are independent.
  const { primary, secondary } = formatLeagueSections({
    dateStr: '2026-07-17',
    results: [{ league_level: 1, opponent_type: AVERAGE_OPPONENT, username: 'A', score: 900, opponent_score: 850, result: 'W' }],
    standings: {
      1: [{ username: 'A', points: 6, wins: 2, losses: 0, ties: 0, point_diff: 50, total_score: 8000 }]
    },
    titles: { 1: [{ username: 'A', titles: 2 }] },
    scheduleDate: '2026-07-18',
    schedule: [{ league_level: 1, opponent_type: AVERAGE_OPPONENT, username: 'A' }],
    resultsSeasonNumber: 3,
    resultsDay: 3,
    scheduleSeasonNumber: 3,
    scheduleDay: 4
  });

  // Primary = brand + "Results for Day X" (with results date) + Results + Tables.
  assert(primary.includes('**MapTap Leagues**'));
  assert(primary.includes('Season 3 — Results for Day 3 of 10 (2026-07-17)'));
  assert(primary.includes('**Results**'));
  assert(primary.includes('**Tables**'));
  assert(primary.includes('8,000 scored | A'));
  assert(!primary.includes('**Titles**'));
  assert(!primary.includes('**Schedule'));
  assert(!primary.includes('Matchups'));

  // Secondary = brand + "Matchups for Day X+1 (schedule date)" + Titles + Schedule.
  assert(secondary.includes('**MapTap Leagues**'));
  assert(secondary.includes('Season 3 — Matchups for Day 4 of 10 (2026-07-18)'));
  assert(secondary.includes('**Titles**'));
  assert(secondary.includes('MapTap League: A x2'));
  assert(secondary.includes('**Schedule - 2026-07-18**'));
  assert(secondary.includes('A vs League Average'));
  assert(!secondary.includes('**Results**'));
  assert(!secondary.includes('**Tables**'));

  // Header descriptors are omitted when no day is supplied (brand still shows).
  const noDay = formatLeagueSections({
    dateStr: '2026-07-17', results: [], standings: {}, titles: {}, scheduleDate: '2026-07-18', schedule: []
  });
  assert(noDay.primary.includes('**MapTap Leagues**'));
  assert(!noDay.primary.includes('Results for Day'));
  assert(!noDay.secondary.includes('Matchups for Day'));

  // Rollover day: message 1 keeps "Final Standings" for the finishing season;
  // message 2 advances to the incoming season, Day 1.
  const wrap = formatLeagueSections({
    dateStr: '2026-07-28', results: [], standings: {}, titles: {}, scheduleDate: '2026-07-29', schedule: [],
    resultsSeasonNumber: 3, resultsDay: 10, finalStandings: true,
    scheduleSeasonNumber: 4, scheduleDay: 1
  });
  assert(wrap.primary.includes('Season 3 — Final Standings (2026-07-28)'));
  assert(!wrap.primary.includes('Results for Day'));
  assert(wrap.secondary.includes('Season 4 — Matchups for Day 1 of 10 (2026-07-29)'));

  // Formatter never forces a +1: when a caller supplies equal results/schedule days
  // it renders them equal (the day offset is the caller's responsibility).
  const equal = formatLeagueSections({
    dateStr: '2026-07-17', results: [], standings: {}, titles: {}, scheduleDate: '2026-07-17', schedule: [],
    resultsSeasonNumber: 3, resultsDay: 3, finalStandings: false,
    scheduleSeasonNumber: 3, scheduleDay: 3
  });
  assert(equal.primary.includes('Season 3 — Results for Day 3 of 10 (2026-07-17)'));
  assert(equal.secondary.includes('Season 3 — Matchups for Day 3 of 10 (2026-07-17)'));
  assert(!equal.primary.includes('Final Standings'));
}

// Season rollover must finalize the previous season's last day (no-shows, forfeits,
// average matchups) BEFORE standings are read for titles and promotion/relegation.
// Regression test: uses a stub pool that records query order.
async function testRolloverFinalizesBeforeStandings() {
  const previousSeason = { id: 1, season_number: 1, start_date: '2026-07-09', end_date: '2026-07-18' };
  const queryLog = [];
  const stubPool = {
    async query(sql, params = []) {
      queryLog.push(sql);
      if (sql.includes('FROM league_seasons') && sql.includes('start_date <= $1')) {
        return { rows: [previousSeason] }; // getSeasonForDate inside finalizeLeagueDate
      }
      if (sql.includes('INSERT INTO league_seasons')) {
        return { rows: [{ id: 2, season_number: params[0], start_date: params[1], end_date: params[2], status: 'active' }] };
      }
      return { rows: [] };
    }
  };

  const season = await createNextSeason(stubPool, '2026-07-19', previousSeason);
  assert.strictEqual(season.season_number, 2);

  const finalizeIdx = queryLog.findIndex(sql => sql.includes('FROM league_matchups'));
  const standingsIdx = queryLog.findIndex(sql => sql.includes('FROM league_memberships'));
  assert(finalizeIdx !== -1, 'finalizeLeagueDate should query the previous season\'s matchups');
  assert(standingsIdx !== -1, 'createNextSeason should query standings');
  assert(finalizeIdx < standingsIdx, 'final day must be finalized before standings are computed');
}

// /leagues is a live snapshot of the CURRENT day: decided matchups under Results,
// still-to-play matchups (only) under "Still to play". Both use today's date, and it
// must never query a future date — querying tomorrow's schedule would trip
// ensureLeagueSeasonForDate into a premature rollover on a season's final day.
async function testCurrentLeagueLiveSnapshot() {
  const viewDate = '2026-07-22';
  const tomorrow = '2026-07-23';
  const season = { id: 1, season_number: 3, start_date: '2026-07-19', end_date: '2026-07-28' };
  // Pair A/B is decided today; pair C/D is not.
  const scheduleRows = [
    { league_level: 1, user_id: 'A', opponent_user_id: 'B', opponent_type: 'USER', username: 'A', opponent_username: 'B' },
    { league_level: 1, user_id: 'B', opponent_user_id: 'A', opponent_type: 'USER', username: 'B', opponent_username: 'A' },
    { league_level: 1, user_id: 'C', opponent_user_id: 'D', opponent_type: 'USER', username: 'C', opponent_username: 'D' },
    { league_level: 1, user_id: 'D', opponent_user_id: 'C', opponent_type: 'USER', username: 'D', opponent_username: 'C' }
  ];
  const resultRows = [
    { league_level: 1, user_id: 'A', opponent_user_id: 'B', opponent_type: 'USER', result: 'W', score: 900, opponent_score: 800, username: 'A', opponent_username: 'B' },
    { league_level: 1, user_id: 'B', opponent_user_id: 'A', opponent_type: 'USER', result: 'L', score: 800, opponent_score: 900, username: 'B', opponent_username: 'A' }
  ];
  const seenDates = [];
  let resultsDate = null;
  let scheduleDate = null;
  const stubPool = {
    async query(sql, params = []) {
      for (const p of params) if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p)) seenDates.push(p);
      if (sql.includes('FROM league_seasons') && sql.includes('start_date <= $1')) return { rows: [season] };
      if (sql.includes('FROM league_results r')) { resultsDate = params[1]; return { rows: resultRows }; }
      if (sql.includes('FROM league_matchups lm')) { scheduleDate = params[1]; return { rows: scheduleRows }; }
      return { rows: [] };
    }
  };

  const { messages } = await buildCurrentLeagueMessages(stubPool, viewDate);
  const joined = messages.join('\n');
  assert.strictEqual(resultsDate, viewDate, 'results must be fetched for the current day');
  assert.strictEqual(scheduleDate, viewDate, 'schedule must be fetched for the current day');
  assert(!seenDates.includes(tomorrow), '/leagues must never query a future date (rollover guard)');
  assert(messages[0].includes(`Day 4 of 10 (${viewDate}) — live`), 'message 1 is a live snapshot of the current day');
  assert(messages[0].includes('A 900 - 800 B'), 'decided matchup appears under Results');
  assert(joined.includes('**Still to play**'), 'second message has a Still to play section');
  assert(joined.includes('C vs D'), 'undecided matchup appears under Still to play');
  assert(!joined.includes('A vs B'), 'decided matchup must NOT reappear under Still to play');
  assert(!joined.includes('**Titles**'), '/leagues omits the Titles tracker (daily post only)');
}

testInitialSeeding();
testLeagueExclusions();
testScheduleGeneration();
testResultsAndStandings();
testPromotionRelegation();
testNoShowRemovalThreshold();
testMessageSplit();
testLeagueNamesAndTitles();
testSeasonAwardsPanel();
testLiveAverageResolverExport();
testAssignRoundIndices();
testSeasonDayNumber();
testLeagueSections();
Promise.all([
  testRolloverFinalizesBeforeStandings(),
  testCurrentLeagueLiveSnapshot()
])
  .then(() => console.log('league tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
