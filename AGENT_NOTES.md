# Agent Notes — maptap-bot

> Internal reference for the AI agent working on this repo. Not for production use.

---

## What this bot does

Discord bot for a friend group that plays [MapTap](https://maptap.gg) daily.

- Listens for posts containing `maptap.gg` + `Final Score`, saves scores to Postgres
- Reacts ✅ on save, ❌ if duplicate
- Reacts 🤓 to the **day's highest scorer** (moves dynamically as scores come in)
- Reacts with the custom `Dunce` emoji to the **day's lowest scorer** (same dynamic logic)
- At **9:00 PM EST**: posts daily recap embed to `ANNOUNCE_CHANNEL_ID`
- At **9:01 PM EST**: replies to the day's lowest scorer with an insult from the rotation
- `/maptap` slash command: on-demand recap embed
- `/mystats` slash command: personal stats (ephemeral)
- `/submitinsult` slash command: opens a private modal for community insult submissions
- `/insultsubmissions` slash command: manager-only audit view of who submitted community insults

---

## Insult rotation system

**How it works:**
- Insults cycle in shuffled order — no repeats until all are exhausted, then reshuffles
- State is stored in the `insult_state` Postgres table (one row: `queue`, `used`, `version`)
- Community submissions are stored in `insult_submissions` and appended to the unused queue
- Submitted insults are not echoed back into chat; they only appear when the bot eventually fires them
- Fired community insults are anonymous in chat, but server managers can audit submitters with `/insultsubmissions`
- On each deploy, any **brand-new insults** (not in queue or used) are appended to the back of the active queue
- `QUEUE_VERSION` constant controls re-seeding. **Bump it whenever the seed data needs to change** (e.g. correcting `INSULTS_ALREADY_USED`)

**To add new insults:** just append to the `INSULTS` array and push — they'll be picked up on next restart automatically.

**To force a full re-seed** (e.g. if `INSULTS_ALREADY_USED` changes): bump `QUEUE_VERSION` by 1 and push.

---

## Insult history

These were used before the queue system was in place and are seeded into `INSULTS_ALREADY_USED` (queue version 2):

| Original # | Insult |
|---|---|
| #1 | `"this guy's fuckin retarded!"` |
| #7 | `"https://www.ice.gov/careers/how-apply"` |
| #8 | `"congrats on your lobotomy"` |
| #11 | `"https://www.youtube.com/watch?v=LrkEc2V3mO4"` |

The user references insults by number from the **original 19-item list** (before any scraps). That list was:

```
1.  this guy's fuckin retarded!
2.  skill issue.                          ← scrapped
3.  your dad doesn't love you             ← scrapped
4.  respectfully, what the fuck           ← scrapped
5.  🤡🤡🤡🤡🤡                            ← scrapped
6.  https://en.wikipedia.org/wiki/Walter_E._Fernald_Developmental_Center
7.  https://www.ice.gov/careers/how-apply
8.  congrats on your lobotomy
9.  inbred                                ← scrapped
10. after much analysis you are actually the bot  ← scrapped
11. https://www.youtube.com/watch?v=LrkEc2V3mO4
12. https://www.youtube.com/watch?v=XcyhMmLTKss
13. you ever think they just maptapped wrong and blew up an Iranian hospital? Anyway nice score retard
14. budd dwyer should be your role model
15. in the steroid era this was refreshing
16. median average voter
17. charlie kirk died for this
18. hey there! congrats on the lowest score. atleast you aren't @hellorobotics
19. i am a nihlist
    [+ the cia killed JFK]
    [+ i maptapped your mother]
    [+ new game! AncestryTap! Your parents are cousins!]
```

---

## Deployment

- Hosted on **Railway** (free $5 credit tier — keep DB usage minimal)
- Env vars required: `DISCORD_TOKEN`, `ANNOUNCE_CHANNEL_ID`, `DATABASE_URL`
- Env var optional: `GUILD_ID` for immediate guild slash-command registration; without it commands register globally
- Railway auto-deploys on push to `main`
- DB is Postgres provided by Railway

---

## DB tables

| Table | Purpose |
|---|---|
| `scores` | One row per user per day. Stores score, rounds[], message_id, channel_id |
| `insult_state` | Single row. `queue` JSONB, `used` JSONB, `version` INT |
| `insult_submissions` | Community-submitted text insults, accepted by default |
| `league_seasons` | 10-day MapTap league seasons |
| `league_memberships` | Player division assignments per season |
| `league_matchups` | Scheduled head-to-head or league-average matchups |
| `league_results` | W/L/T, football points, and point differential |
| `league_titles` | Completed-season league champions |
| `league_exclusions` | Players removed from future league rosters |
| `league_state` | League cron idempotency guards |

## League system

- Implemented in `leagues.js`; keep pure scheduling/standings helpers there when possible.
- Division display names are `League Tism`, `League Mid`, and `League Dunce`.
- League launch date is `2026-06-29`; scores before that date do not resolve league matchups.
- League updates are separate plain-text Discord messages and do not change the medal recap.
- `/leagues` shows the current league state ephemerally; `/leagues post:true` posts it publicly for server managers.
- Seasons last 10 days. Initial League 1/2 seeding uses top historical averages among players with 10+ games in the prior 30 days; everyone else starts in League 3.
- Future season rollover promotes/relegates one player between adjacent divisions and adds new players to League 3.
- Players with 7+ no-shows in a 10-day season are recorded in `league_exclusions` and left out of future seasons.
- Completed-season champions are stored in `league_titles` and shown in the daily league message.
- Live W/L reactions only happen for completed head-to-head matchups. Average matchups and forfeits finalize at the 12:01 AM league cron.
