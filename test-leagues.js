const assert = require('assert');
const {
  AVERAGE_OPPONENT,
  EXCLUDED_LEAGUE_USER_IDS,
  LEAGUE_LAUNCH_DATE,
  LEAGUE_NAMES,
  NO_SHOW_REMOVAL_THRESHOLD,
  applyPromotionRelegation,
  assignRoundIndices,
  buildPlayerAverages,
  createNextSeason,
  buildSeasonAwards,
  dateAdd,
  formatLeagueReminder,
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
  assert.strictEqual(seeded.filter(p => p.league_level === 1).length, 5);
  assert.strictEqual(seeded.filter(p => p.league_level === 2).length, 5);
  assert.strictEqual(seeded.find(p => p.user_id === 'newbie').league_level, 3);
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
    { user_id: 'd', league_level: 2 },
    { user_id: 'e', league_level: 2 }
  ];
  const schedule = generateSeasonSchedule(members, '2026-06-01', 1);
  assert.strictEqual(schedule.filter(m => m.league_level === 1 && m.opponent_type === AVERAGE_OPPONENT).length, 10);
  assert.strictEqual(schedule.filter(m => m.league_level === 2 && m.opponent_type === AVERAGE_OPPONENT).length, 0);
  for (let day = 0; day < 10; day++) {
    const date = dateAdd('2026-06-01', day);
    assert.strictEqual(schedule.filter(m => m.date_str === date && m.league_level === 1).length, 3);
    assert.strictEqual(schedule.filter(m => m.date_str === date && m.league_level === 2).length, 2);
  }

  const topLeague = ['a', 'b', 'c', 'd', 'e'].map(user_id => ({ user_id, league_level: 1 }));
  const topSchedule = generateSeasonSchedule(topLeague, '2026-06-01', 1);
  const topPairs = pairCounts(topSchedule.filter(m => m.opponent_type === 'USER'));
  assert.strictEqual(topPairs.size, 10);
  for (const count of topPairs.values()) assert.strictEqual(count, 2);
  for (const member of topLeague) {
    assert.strictEqual(topSchedule.filter(m => m.user_id === member.user_id && m.opponent_type === AVERAGE_OPPONENT).length, 2);
  }

  const soloSchedule = generateSeasonSchedule([{ user_id: 'solo', league_level: 3 }], '2026-06-01', 1);
  assert.strictEqual(soloSchedule.filter(m => m.opponent_type === AVERAGE_OPPONENT).length, 10);

  const dunceLeague = Array.from({ length: 10 }, (_, idx) => ({ user_id: `d${idx}`, league_level: 3 }));
  const dunceSchedule = generateSeasonSchedule(dunceLeague, '2026-06-01', 1);
  const duncePairs = pairCounts(dunceSchedule);
  assert.strictEqual(duncePairs.size, 45);
  // 10 days x 5 pairs per round = 50 total meetings (full round-robin + one rematch round).
  assert.strictEqual([...duncePairs.values()].reduce((sum, count) => sum + count, 0), 50);
  assert.strictEqual(dunceSchedule.filter(m => m.opponent_type === AVERAGE_OPPONENT).length, 0);
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
  const next = applyPromotionRelegation(members, {
    1: [
      { user_id: 'p1', username: 'P1', points: 6, point_diff: 5, total_score: 10, seed_average: 1 },
      { user_id: 'p2', username: 'P2', points: 0, point_diff: -5, total_score: 10, seed_average: 1 }
    ],
    2: [
      { user_id: 'c1', username: 'C1', points: 9, point_diff: 5, total_score: 10, seed_average: 1 },
      { user_id: 'c2', username: 'C2', points: 0, point_diff: -5, total_score: 10, seed_average: 1 }
    ],
    3: [
      { user_id: 'l1', username: 'L1', points: 9, point_diff: 5, total_score: 10, seed_average: 1 }
    ]
  }, [{ user_id: 'new', username: 'New', seed_average: 700 }]);
  assert.strictEqual(next.find(p => p.user_id === 'c1').league_level, 1);
  assert.strictEqual(next.find(p => p.user_id === 'p2').league_level, 2);
  assert.strictEqual(next.find(p => p.user_id === 'new').league_level, 3);
}

function testOneTimeExpansionPromotion() {
  const members = [
    ...Array.from({ length: 5 }, (_, idx) => ({ user_id: `t${idx}`, username: `T${idx}`, league_level: 1 })),
    ...Array.from({ length: 5 }, (_, idx) => ({ user_id: `m${idx}`, username: `M${idx}`, league_level: 2 })),
    ...Array.from({ length: 10 }, (_, idx) => ({ user_id: `d${idx}`, username: `D${idx}`, league_level: 3 }))
  ];
  const standings = {
    1: members
      .filter(member => member.league_level === 1)
      .map((member, idx) => ({ ...member, points: 10 - idx, total_score: 1000 - idx, point_diff: 50 - idx, seed_average: 1 })),
    2: members
      .filter(member => member.league_level === 2)
      .map((member, idx) => ({ ...member, points: 10 - idx, total_score: 1000 - idx, point_diff: 50 - idx, seed_average: 1 })),
    3: members
      .filter(member => member.league_level === 3)
      .map((member, idx) => ({ ...member, points: 20 - idx, total_score: 2000 - idx, point_diff: 100 - idx, seed_average: 1 }))
  };

  const next = applyPromotionRelegation(members, standings, [], { oneTimeExpansion: true });
  assert.strictEqual(next.filter(member => member.league_level === 1).length, 6);
  assert.strictEqual(next.filter(member => member.league_level === 2).length, 6);
  assert.strictEqual(next.filter(member => member.league_level === 3).length, 8);
  assert.strictEqual(next.find(member => member.user_id === 'm0').league_level, 1);
  assert.strictEqual(next.find(member => member.user_id === 'm1').league_level, 1);
  assert.strictEqual(next.find(member => member.user_id === 'd0').league_level, 2);
  assert.strictEqual(next.find(member => member.user_id === 'd1').league_level, 2);
  assert.strictEqual(next.find(member => member.user_id === 'd2').league_level, 2);
  assert.strictEqual(next.find(member => member.user_id === 't4').league_level, 2);
  assert.strictEqual(next.find(member => member.user_id === 'm4').league_level, 3);

  const schedule = generateSeasonSchedule(next, '2026-07-29', 4);
  assert.strictEqual(schedule.filter(matchup => matchup.opponent_type === AVERAGE_OPPONENT).length, 0);
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
  assert.strictEqual(LEAGUE_NAMES[1], 'League Tism');
  assert.strictEqual(LEAGUE_NAMES[2], 'League Mid');
  assert.strictEqual(LEAGUE_NAMES[3], 'League Dunce');

  const titleLines = formatTitleTracker({
    1: [{ username: 'A', titles: 2 }],
    2: [{ username: 'B', titles: 1 }],
    3: [{ username: 'C', titles: 1 }]
  });
  assert(titleLines.includes('League Tism: A x2'));

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
  assert(message.includes('League Tism: A x2'));
  assert(message.includes('8,123 scored | A'));
  assert(message.includes('1,600 scored | League Average'));
}

function testLeagueReminderMessage() {
  const message = formatLeagueReminder('2026-07-04', [
    { league_level: 1, user_id: '111', username: 'A' },
    { league_level: 3, user_id: '333', username: 'C' }
  ]);
  assert(message.includes('**MapTap League Reminder - 2026-07-04**'));
  assert(message.includes('League Tism: <@111>'));
  assert(message.includes('League Dunce: <@333>'));
  assert.strictEqual(formatLeagueReminder('2026-07-04', []), null);
}

function testSeasonAwardsPanel() {
  const standings = {
    1: [
      { user_id: 'tism', username: 'Tism Champ', points: 20, wins: 6, point_diff: 100, total_score: 8000, seed_average: 800 },
      { user_id: 'tism-low', username: 'Tism Low', points: 6, wins: 2, point_diff: -20, total_score: 7000, seed_average: 700 }
    ],
    2: [
      { user_id: 'mid', username: 'Mid Champ', points: 21, wins: 7, point_diff: 200, total_score: 7600, seed_average: 760 },
      { user_id: 'israel', username: 'Right Day Merchant', points: 15, wins: 5, point_diff: -250, total_score: 6100, seed_average: 610 }
    ],
    3: [
      { user_id: 'dunce', username: 'Dunce Champ', points: 18, wins: 6, point_diff: 300, total_score: 8100, seed_average: 810 },
      { user_id: 'chosen', username: 'Chosen', points: 0, wins: 0, point_diff: -500, total_score: 3000, seed_average: 300 }
    ]
  };
  const awards = buildSeasonAwards(standings, { season_number: 1 });
  assert.strictEqual(awards.leagueWinners[0].winner.username, 'Tism Champ');
  assert.strictEqual(awards.chosenOne.username, 'Chosen');
  assert.strictEqual(awards.mostScored.username, 'Dunce Champ');
  assert.strictEqual(awards.israelAward.username, 'Right Day Merchant');

  const panel = formatSeasonAwardsPanel(awards);
  assert(panel.includes('**Season 1 Special Awards**'));
  assert(panel.includes('League Tism: <@tism>'));
  assert(panel.includes('**The Chosen One**: <@chosen>'));
  assert(panel.includes('**Most Points Scored**: <@dunce> - 8,100 scored'));
  assert(panel.includes('**Israel Award**: <@israel> - 5 wins, -250 diff, 6,100 scored'));
  assert.deepStrictEqual(seasonAwardUserIds(awards), ['tism', 'mid', 'dunce', 'chosen', 'israel']);
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

  // Secondary = brand + "Matchups for Day X+1" + Titles + Schedule.
  assert(secondary.includes('**MapTap Leagues**'));
  assert(secondary.includes('Season 3 — Matchups for Day 4 of 10'));
  assert(!secondary.includes('(2026-07-18)')); // no date in the matchups header line
  assert(secondary.includes('**Titles**'));
  assert(secondary.includes('League Tism: A x2'));
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
  assert(wrap.secondary.includes('Season 4 — Matchups for Day 1 of 10'));

  // /leagues live view: results and schedule share the same day (no false +1).
  const live = formatLeagueSections({
    dateStr: '2026-07-17', results: [], standings: {}, titles: {}, scheduleDate: '2026-07-17', schedule: [],
    resultsSeasonNumber: 3, resultsDay: 3, finalStandings: false,
    scheduleSeasonNumber: 3, scheduleDay: 3
  });
  assert(live.primary.includes('Season 3 — Results for Day 3 of 10 (2026-07-17)'));
  assert(live.secondary.includes('Season 3 — Matchups for Day 3 of 10'));
  assert(!live.primary.includes('Final Standings'));
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

testInitialSeeding();
testLeagueExclusions();
testScheduleGeneration();
testResultsAndStandings();
testPromotionRelegation();
testOneTimeExpansionPromotion();
testNoShowRemovalThreshold();
testMessageSplit();
testLeagueNamesAndTitles();
testLeagueReminderMessage();
testSeasonAwardsPanel();
testLiveAverageResolverExport();
testAssignRoundIndices();
testSeasonDayNumber();
testLeagueSections();
testRolloverFinalizesBeforeStandings()
  .then(() => console.log('league tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
