# League output & scheduling changes

## Context

The daily MapTap league post ([leagues.js](../../leagues.js)) has grown long enough that Discord's
length-based splitter cuts it mid-section (the screenshot shows the break landing inside the
Schedule block). The user wants a cleaner, deliberate two-message split, a "which day of the
season" indicator in the daily post, and a scheduling guarantee that everyone plays a full
round in the large division (Dunce) and a double round-robin in the smaller divisions.

Confirmed decisions (from clarifying questions):
1. **Split boundary:** Message 1 = header + Results + Tables. Message 2 = Titles + Schedule.
2. **Day counter:** In the 12:01 AM daily post, counting to the **schedule day** (today's play day).
3. **Scheduling:** Fill all 10 days; where a full round-robin is shorter than the season, add
   rematches spread **evenly** across the cycle (not front-loaded).
4. **League Average in tables:** already implemented in commit `eb1b268` — **no change**.

All work happens on the current worktree branch. Commit per logical change.

## Current behavior (relevant code)

- [`generateSeasonSchedule`](../../leagues.js:126) picks a round per day with `rounds[day % rounds.length]`.
  For a division whose round-robin length `r` does not evenly fit the 10-day season, this
  front-loads the rematches onto the earliest rounds (round 0 first). Divisions:
  L1/L2 are always 5 players (`r=5` → clean 2× coverage today); Dunce is everyone else
  (`r=9` for 10 players → full coverage + round 0 replayed on day 10).
- [`formatLeagueUpdate`](../../leagues.js:1100) returns one big string; callers pass it through
  [`splitDiscordMessage`](../../leagues.js:1160) which chunks purely by length (~1900 chars),
  hence the ugly mid-Schedule break.
- [`buildDailyLeagueMessages`](../../leagues.js:1177) is the 12:01 AM path;
  [`buildCurrentLeagueMessages`](../../leagues.js:1204) backs `/leagues`.
- Cron at [maptap-bot.js:639](../../maptap-bot.js:639) calls `buildDailyLeagueMessages` **twice**
  (line 653 discards the result, line 655 uses it) — redundant double finalize/build.

## Changes

### 1. Even round distribution (request 3) — `leagues.js`

Add a helper that maps season days to round-robin round indices with rematches spread evenly:

```js
function assignRoundIndices(roundCount, dayCount) {
  if (roundCount === 0) return [];
  const indices = [];
  const fullPasses = Math.floor(dayCount / roundCount);
  for (let p = 0; p < fullPasses; p++) {
    for (let i = 0; i < roundCount; i++) indices.push(i);
  }
  const remaining = dayCount - fullPasses * roundCount;
  for (let k = 0; k < remaining; k++) {
    indices.push(Math.floor((k * roundCount) / remaining)); // evenly spaced extra rounds
  }
  return indices; // length === dayCount for roundCount >= 1; [] when roundCount === 0
}
```

Refactor [`generateSeasonSchedule`](../../leagues.js:126) so the per-league round-robin is computed
**once** (outside the day loop), then each day picks `rounds[roundIndices[day]] || []`. Keep the
existing pair-expansion / AVERAGE-opponent push logic unchanged.

Resulting coverage: `r=5` (L1/L2) → exactly 2× each pair; `r=9` (Dunce, 10 players) → full
round-robin + 1 rematch round; `r=7` (7–8 players) → 1× + 3 rematch rounds chosen evenly across
the cycle (rounds 0/2/4, not 0/1/2); `r>10` → 10 evenly-spread distinct rounds (max coverage).
This satisfies "everyone plays once in Dunce, twice in other leagues" and keeps all
`testScheduleGeneration` invariants (AVG counts, `topPairs` all 2×, dunce 45 pairs all ≥1) — for
`r∈{5,9}` (the only current division sizes) the indices are bit-identical to today's `day % r`.

Note (scope): the rematch rounds are chosen evenly across the *round set*, but land on the season's
trailing calendar days. With current rosters there is at most one rematch round (Dunce, r=9), so
calendar spacing is immaterial. If a division ever lands in `r∈{6,7,8}` and interleaving the
rematch *days* matters, revisit — out of scope now.

### 2. Day-of-season counter (request 2) — `leagues.js`

Add helpers:

```js
function dateDiff(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
function seasonDayNumber(season, dateStr) {
  if (!season) return null;
  const n = dateDiff(season.start_date, dateStr) + 1;
  return Math.min(Math.max(n, 1), SEASON_LENGTH_DAYS);
}
```

The daily post's primary header gains a second line:
`Season ${seasonNumber} · Day ${n} of ${SEASON_LENGTH_DAYS}`. Both `seasonNumber` and `n` are
sourced from the **standings season** (`standingsSeason = finalized.season || scheduleInfo.season`
in `buildDailyLeagueMessages`), with `n = seasonDayNumber(standingsSeason, scheduleDate)`.

Rationale for using the standings season (not the schedule season): on a normal day they are the
same season and `scheduleDate` resolves to today's play day (the intended "how many days in").
On a **rollover day** the message body — Results, Tables, and the Season Special Awards panel — all
belong to the *completing* season N, while `scheduleDate` belongs to N+1; sourcing from
`standingsSeason` keeps the header on season N and the `seasonDayNumber` clamp yields
"Season N · Day 10 of 10", correctly labeling the wrap-up instead of "Season N+1 · Day 1" over
season N's content. The counter is only rendered when a season/day is supplied, so
`formatLeagueUpdate`'s existing callers/tests without it are unaffected.

### 3. Deliberate two-message split (request 1) — `leagues.js`

Split the body builder into sections while preserving the single-string `formatLeagueUpdate`
(so the existing `testLeagueUpdateMessage` stays green):

```js
function formatLeagueSections(args) {
  // primary = header (+ optional Season/Day line) + Results + Tables
  // secondary = Titles + Schedule
  return { primary, secondary };
}
function formatLeagueUpdate(args) {
  const { primary, secondary } = formatLeagueSections(args);
  return `${primary}\n\n${secondary}`;
}
```

- [`buildDailyLeagueMessages`](../../leagues.js:1177): build via `formatLeagueSections`, then
  `messages = [primary, secondary].flatMap(s => splitDiscordMessage(s))` (per-section length safety
  net — note the explicit arrow so `flatMap`'s index arg is not passed as `maxLength`), then append
  the awards panel last when present. The cron's awards-mention logic keys on the last message
  index, which still holds.
- [`buildCurrentLeagueMessages`](../../leagues.js:1204): apply the same two-message split for
  consistency in the `/leagues` view, passing `seasonDay`/`seasonNumber` for `viewDate`.

Export `assignRoundIndices`, `seasonDayNumber`, and `formatLeagueSections` for unit testing.

### 4. Cron cleanup — `maptap-bot.js`

Remove the redundant first `buildDailyLeagueMessages` call at [maptap-bot.js:653](../../maptap-bot.js:653);
keep the destructured call on line 655. No behavior change (finalize is idempotent), just avoids a
double DB pass.

## Files touched

- [leagues.js](../../leagues.js) — scheduling refactor, day helpers, section split, exports.
- [maptap-bot.js](../../maptap-bot.js) — drop the duplicate daily-build call.
- [test-leagues.js](../../test-leagues.js) — add unit tests (below).

## Verification

- Extend [test-leagues.js](../../test-leagues.js):
  - `assignRoundIndices`: length `== dayCount` for `roundCount >= 1` (and `[]` for `roundCount === 0`);
    `r=5,d=10` → each index exactly 2×;
    `r=9,d=10` → all 9 once + exactly one repeat; `r=7,d=10` → repeats are evenly spread
    (indices 0,~2,~4, not 0,1,2); `r=12,d=10` → 10 distinct indices.
  - `seasonDayNumber`: start_date → 1; +4 days → 5; clamps below 1 and above 10.
  - `formatLeagueSections`: `primary` contains Results + Tables and the `Day N of 10` line;
    `secondary` contains Titles + Schedule; neither leaks the other's section.
  - Re-run the existing `testScheduleGeneration` / `testLeagueUpdateMessage` unchanged.
- Run `npm run test:leagues` (`node test-leagues.js`) — must print `league tests passed`.
- Manual/staging check (DB-backed paths not unit-testable): trigger the 12:01 AM path against a
  season and confirm Discord shows exactly two messages (Results+Tables, then Titles+Schedule),
  the header shows the correct `Day N of 10`, and the awards panel (final day) posts as a third
  message with mentions. Confirm `/leagues` renders the same two-message layout.
