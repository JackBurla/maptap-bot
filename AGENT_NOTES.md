# Agent Notes — MapTap Bot

> Internal implementation reference. The user-facing architecture and league
> documentation lives in `docs/`.

## What the active bot does

This Discord bot records daily [MapTap](https://maptap.gg) scores and runs a
three-division, ten-day league.

- It receives score posts from every server channel it can view; score input is
  **not** limited to `ANNOUNCE_CHANNEL_ID`.
- A score post must contain both `maptap.gg` and `Final Score`.
- It stores one score per user per Eastern-time day, reacts ✅ for a new score
  and ❌ for a duplicate, and maintains high-score 🤓 and low-score Dunce
  reactions across the day's submissions.
- It provides `/maptap`, `/mystats`, and `/leagues`; `/leagues post:true` is
  limited to server managers.
- `ANNOUNCE_CHANNEL_ID` is the destination for scheduled reminders, recap
  embeds, and league posts.

The retired insult queue, insult submissions, and their associated tables and
commands are no longer part of the executable application. Do not reintroduce
documentation or migrations for them without an explicit product decision.

## Runtime and deployment

- Hosted on Railway with Railway Postgres.
- Required environment variables: `DISCORD_TOKEN`, `ANNOUNCE_CHANNEL_ID`, and
  `DATABASE_URL`.
- Optional `GUILD_ID` registers slash commands to a specific guild; otherwise
  they are registered globally.
- Railway deploys `main` automatically.
- Scheduled jobs use `America/New_York`:
  - 9:00 PM: remind league players who have not submitted;
  - 12:00 AM: post yesterday's score recap;
  - 12:01 AM: finalize yesterday's league results and post league output.
- The daily league cron calls `buildDailyLeagueMessages` once. Do not add a
  preliminary call solely to finalize results; rollover handles finalization in
  the correct place.

## Database tables

| Table | Purpose |
| --- | --- |
| `scores` | One row per user/day, including score, rounds, and source message IDs. |
| `one_time_score_replies` | Idempotency state for one-time score replies. |
| `bot_state` | Daily recap idempotency guard. |
| `league_seasons` | Ten-day league seasons. |
| `league_memberships` | Per-season player division assignments. |
| `league_matchups` | Scheduled head-to-head or league-average matchups. |
| `league_results` | W/L/T outcomes, points, score differential, and resolution type. |
| `league_titles` | Completed-season division champions. |
| `league_exclusions` | Players removed from future seasons for excessive no-shows. |
| `league_state` | League closeout and reminder idempotency guards. |

## League invariants

- Keep pure scheduling, standings, and formatting helpers in `leagues.js`.
- The league starts on `2026-06-29`; prior scores do not resolve league
  matchups.
- Seasons last ten days. Initial seeding places the five best eligible
  historical averages in League Tism, the next five in League Mid, and all
  others in League Dunce.
- Normal rollover promotes/relegates one player between adjacent divisions and
  adds new players to League Dunce. Season 3 has a one-time expansion rule;
  preserve it unless explicitly retiring it.
- A player with at least seven no-show-related results is excluded from future
  rosters.
- `createNextSeason` must finalize the previous season's last date **before**
  calculating standings, titles, exclusions, or promotion/relegation. Rollover
  can be triggered by startup, score submission, `/leagues`, or the nightly
  job, and it is not rerun for a completed season.
- Live W/L reactions happen when both sides of a head-to-head matchup have
  submitted. League-average matchups can resolve live once all required scores
  exist; outstanding cases resolve during the 12:01 AM closeout.
- The nightly post shows the completed day's results/tables separately from the
  next day's matchups. `/leagues` is a same-day live snapshot and shows only
  still-undecided matchups in its second section.

## Verification and utilities

- Run `node test-leagues.js` after changing league logic or its formatting.
- `scrape-history.js` is a one-time importer for `maptap-scores.json`.
- `export-scores.js` exports the `scores` table to CSV.
- See `docs/architecture-and-runtime-flow.md` and
  `docs/league-lifecycle-and-operations.md` for detailed flow diagrams.
