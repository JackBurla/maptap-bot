const assert = require('assert');
const {
  AVERAGE_OPPONENT,
  LEAGUE_NAMES,
  applyPromotionRelegation,
  buildPlayerAverages,
  dateAdd,
  formatLeagueUpdate,
  formatTitleTracker,
  generateSeasonSchedule,
  rankStandings,
  resultForScores,
  seedInitialMemberships,
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

function testMessageSplit() {
  const chunks = splitDiscordMessage(Array(200).fill('line').join('\n'), 100);
  assert(chunks.length > 1);
  assert(chunks.every(chunk => chunk.length <= 100));
}

function testLeagueNamesAndTitles() {
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
    standings: {},
    titles: { 1: [{ username: 'A', titles: 2 }] },
    scheduleDate: '2026-06-02',
    schedule: []
  });
  assert(message.includes('**Titles**'));
  assert(message.includes('League Tism: A x2'));
}

testInitialSeeding();
testScheduleGeneration();
testResultsAndStandings();
testPromotionRelegation();
testMessageSplit();
testLeagueNamesAndTitles();

console.log('league tests passed');
