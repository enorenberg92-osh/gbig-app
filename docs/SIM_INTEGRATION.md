# Simulator integration: live scoring

This document is for whoever connects the bay simulators (or their tournament-mode software) to the league app. You'll need Supabase SQL-editor access for key setup and an HTTP client on the sim side.

## What it does

```
bay PC / sim software ──POST each hole──▶ sim-ingest (edge function)
                                              │  SHA-256(api key) → location
                                              ▼
                                   public.sim_ingest(...)       (service role only)
                                              │  same code path as the app's
                                              ▼  record_live_hole RPC
                                   live_rounds  ──realtime──▶  /league/tonight (phones + lobby TV)
                                              │
                              { finalize:true }▼
                                   scores (status 'verified')  ──▶  standings + handicaps, no review
```

- **Live cards.** `live_rounds` has one row per player per league week. `hole_scores` holds one integer per hole, and an unplayed hole is `NULL`. The app's score-entry screen and the simulator write to the same row, and the last write for a hole wins. Live cards never feed standings or handicaps.
- **Submission.** The official record is the `scores` row. The app creates it with **Submit Scores** (`submit_scores`), as a **pending** row an admin approves. The simulator creates it with `finalize: true`, and those rows are **verified immediately** (no review queue) and recalculate the players' handicaps at once.
- **Disputes.** If a player disagrees with the sim, an admin edits the score in **Admin → Scores** (any week, even published ones). An admin can also correct a live card from SQL with `select record_live_hole(event_id, player_id, hole, strokes)`, which is audited as `live.admin_record_hole`.

## 1. Create an API key (location admin)

Keys belong to one location. The database stores only the SHA-256 digest, so the plaintext key is shown once. Creating a new key **revokes the previous `sim` key** for that location, which is how you rotate.

Run this in the SQL editor while signed in as a location admin, or through `supabase.rpc` from an admin session:

```sql
-- returns {"id": "...", "key": "gbig_sim_…", "key_prefix": "gbig_sim_1a2b", "kind": "sim"}
select admin_create_location_api_key('<location uuid>', 'sim', 'Bay PCs');

-- list keys (the hash is never readable by clients)
select id, key_prefix, label, created_at, last_used_at, revoked_at
  from location_api_keys where location_id = '<location uuid>';

-- revoke immediately (e.g. a bay PC was stolen)
select admin_revoke_location_api_key('<key id>');
```

Running as `postgres` in the dashboard SQL editor fails the admin check, because `auth.uid()` is empty there. From the dashboard, insert the key by hand instead:

```sql
-- pick a long random key yourself, e.g. `openssl rand -hex 32` → gbig_sim_<hex>
insert into location_api_keys (location_id, kind, key_hash, key_prefix, label)
values ('<location uuid>', 'sim',
        encode(sha256(convert_to('gbig_sim_<hex>', 'UTF8')), 'hex'),
        'gbig_sim_<first 4 hex>', 'Bay PCs');
```

Store the key on the bay PCs like a password. It can write scores for every rostered player at that location, but it can't read any data.

## 2. Endpoint

```
POST https://<project-ref>.supabase.co/functions/v1/sim-ingest
Authorization: Bearer gbig_sim_…        (or  x-api-key: gbig_sim_…)
Content-Type: application/json
```

### Body

| field | type | notes |
|---|---|---|
| `player_id` | uuid | Preferred. It is the `players.id` for that location. |
| `player_email` | string | Alternative to `player_id`. Matching ignores case. It fails if two players share the email. |
| `hole` | int | 1…`num_holes` of the week's course. |
| `strokes` | int or null | 1…20. `null` clears the hole, for example after a mulligan the sim undid. |
| `holes` | array | Catch-up batch of `[{ "hole": 3, "strokes": 4 }, …]`, at most 36. Use it after a network drop. |
| `bay` | string | Optional. It is shown on the leaderboard as "Bay 3". |
| `event_id` | uuid | Optional. It defaults to the open league week the player is rostered in. |
| `finalize` | bool | `true` tries to submit the player's **team** (see below). |

Send at least one of `hole`, `holes` or `finalize`. You can combine them. For example, the last hole plus `finalize: true` in one call records the hole first and then finalizes.

### Rules the server enforces

- The key must be active and belong to the player's location.
- The player must be **rostered** for the week, using the dated roster (`roster_at`), so mid-season swaps work.
- The week must be **open**. Once an admin publishes it, writes return 422.
- Hole must be within the course's hole count, and strokes must be 1–20.
- Once a player's round is submitted, whether by the app or the sim, further hole writes are ignored and return `"submitted": true`. If an admin **rejects** the submission, the card reopens automatically.
- Approved subs are handled the same way as in the app. Scores go on the absent player's slot at the sub's handicap.

### Finalize

`finalize: true` looks at every rostered teammate:

- If anyone still has holes missing, nothing is submitted and the response says who:

  ```json
  { "finalize": { "finalized": false, "reason": "incomplete",
                  "waiting_on": [{ "player_id": "…", "name": "Sam Two", "holes_played": 7 }] } }
  ```

- If everyone has every hole, one `verified` score row per teammate is inserted. The totals and handicap are computed server-side, and the event is audited as `score.submit` with `source: "sim"`. The live cards flip to submitted.

  ```json
  { "finalize": { "finalized": true, "inserted": 2, "already_submitted": false, "status": "verified" } }
  ```

- Calling it again is harmless and returns `"already_submitted": true`.

The simplest integration is to send `finalize: true` with every player's last hole. The first teammate to finish gets `incomplete`, and the second one's call submits the team.

### Responses

| status | when |
|---|---|
| 200 | `{ ok: true, event_id, player_id, team_id, live: {hole_scores, holes_played, submitted, …}, finalize }` |
| 400 | Body isn't a JSON object. |
| 401 | Key missing, wrong, or revoked. |
| 422 | Validation error. The `error` message is readable, for example "Hole must be between 1 and 9", "Player is not rostered for an open league week", or "This week is not open for scoring". Don't retry these. |
| 500 | Something unexpected. Retry with backoff. Details are only in the function logs. |

Writes are idempotent per hole, because the last value wins, so retrying a 500 or a timeout is safe.

## 3. Examples

```bash
URL=https://<project-ref>.supabase.co/functions/v1/sim-ingest
KEY=gbig_sim_…

# one hole
curl -sS -X POST "$URL" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"player_email":"sam@example.com","hole":4,"strokes":5,"bay":"3"}'

# undo a hole
curl -sS -X POST "$URL" -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"player_id":"<uuid>","hole":4,"strokes":null}'

# catch up after the bay PC was offline
curl -sS -X POST "$URL" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"player_id":"<uuid>","holes":[{"hole":5,"strokes":4},{"hole":6,"strokes":3}]}'

# last hole + submit the team when both players are done
curl -sS -X POST "$URL" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"player_id":"<uuid>","hole":9,"strokes":4,"finalize":true}'
```

## 4. Knowing who is in the bay

The simulator needs a `player_id` or `player_email` for each golfer. These are the options, from least to most work:

1. **Type or pick the email** in the sim's player setup. This works today.
2. **QR check-in (next step, not built yet).** A printed QR code at each bay encodes `https://<app host>/league/checkin?bay=3`. A player scans it with their phone. They're already signed in to the league app, so the page knows who they are, and it records a `bay_checkins` row (location, bay, player_id, event_id, checked_in_at) for tonight. The sim then asks `GET sim-ingest?bay=3` (same API key) for the players checked in to that bay and posts their holes with those ids. Nobody types anything. The planned pieces are a `bay_checkins` table, a `checkin_to_bay(p_bay)` player RPC that uses the same roster and open-week checks as `record_live_hole`, a small `/league/checkin` page, and a `GET` branch in this function. Check-ins expire at midnight in the location's timezone.
3. **Sim-native login.** If the sim software has its own player accounts, store the league `player_id` on them once.

## 5. Leaderboard

`/league/tonight` in the app shows everyone with a live card updated today in the location's timezone, plus anyone whose score was entered today without one. It shows thru, gross, net to par over the holes played (handicap strokes are allocated by the course stroke index, the same way match play does it), and a status of Live, Submitted, or Final. It updates in realtime from `live_rounds`, with a 30-second poll as backup.

For the lobby TV, sign in once with any league account and open `/league/tonight?tv=1`. That gives big type and a clock, and it alternates between Players and Teams every 20 seconds and pages through long lists. Add `&view=teams` to stay on Teams.

## 6. Deploy checklist

1. Run `supabase/migrations/202609230002_live_rounds.sql` in the SQL editor. It is idempotent. It adds `live_rounds` to the `supabase_realtime` publication. Confirm under **Database → Publications** that `live_rounds` is listed.
2. `supabase functions deploy sim-ingest --project-ref <ref> --no-verify-jwt`. No extra secrets are needed, because it uses the built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Create a key (section 1) and try the curl examples against an open week with a test player.

## 7. Security notes

- The API key is hashed with SHA-256 before it leaves the edge function. The plaintext is never stored and never reaches Postgres logs.
- `sim_ingest` and its helpers can't be executed by `anon` or `authenticated`. Only the service role can call them, which means only this function.
- The key only resolves to its own location. A player id from another location returns "Player not found".
- The function has no rate limit. Keys are per location and revocable. If a key leaks, revoke it and rotate.
