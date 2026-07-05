const assert = require('assert');
const {
  AVERAGE_OPPONENT,
  EXCLUDED_LEAGUE_USER_IDS,
  LEAGUE_LAUNCH_DATE,
  LEAGUE_NAMES,
  NO_SHOW_REMOVAL_THRESHOLD,
  applyPromotionRelegation,
  buildPlayerAverages,
  buildSeasonAwards,
  dateAdd,
  formatLeagueReminder,
  formatLeagueUpdate,
  formatSeasonAwardsPanel,
  formatTitleTracker,
  generateSeasonSchedule,
  rankStandings,
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
  assert.strictEqual(standings[0].username, 'A');
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
      }]
    },
    titles: { 1: [{ username: 'A', titles: 2 }] },
    scheduleDate: '2026-06-02',
    schedule: []
  });
  assert(message.includes('**Titles**'));
  assert(message.includes('League Tism: A x2'));
  assert(message.includes('8,123 scored | A'));
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

testInitialSeeding();
testLeagueExclusions();
testScheduleGeneration();
testResultsAndStandings();
testPromotionRelegation();
testNoShowRemovalThreshold();
testMessageSplit();
testLeagueNamesAndTitles();
testLeagueReminderMessage();
testSeasonAwardsPanel();
testLiveAverageResolverExport();

console.log('league tests passed');
