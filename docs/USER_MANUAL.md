# GBIG League App — User Manual

_Version 2.0 — covers the app as deployed July 2026 (Phase 1 + Phase 2)._
_Audience: players, league admins, and super-admins. Written for training new users._

---

## Table of Contents

1. [What This App Is](#1-what-this-app-is)
2. [Roles at a Glance](#2-roles-at-a-glance)
3. [Getting Started (Everyone)](#3-getting-started-everyone)
4. [Player Guide](#4-player-guide)
5. [Admin Guide](#5-admin-guide)
6. [The Weekly Admin Cycle (Cheat Sheet)](#6-the-weekly-admin-cycle-cheat-sheet)
7. [Super-Admin Guide](#7-super-admin-guide)
8. [How the System Thinks (Key Concepts)](#8-how-the-system-thinks-key-concepts)
9. [The Handicap System](#9-the-handicap-system)
10. [Troubleshooting & FAQ](#10-troubleshooting--faq)

---

## 1. What This App Is

The GBIG app runs an indoor golf league end to end: weekly schedules, hole-by-hole score entry by players, admin review and approval, standings, skins, substitutes, handicaps, member messaging, events, and push alerts. It installs on a phone like a native app (PWA) and supports multiple locations, each with its own branding, admins, and leagues.

Four bottom tabs organize the member experience:

| Tab | What it does |
|---|---|
| **Reservations** | Book a bay (booking form) |
| **League** | Everything league: scores, standings, profile, subs, friends, admin panel |
| **Events** | Facility events with RSVP (can be toggled off) |
| **Alerts** | Announcements from the facility, with optional push notifications |

## 2. Roles at a Glance

| Role | Who | Can do |
|---|---|---|
| **Player** | League member | Submit own team's scores, view standings, edit own profile & password, request subs, follow/message friends, RSVP to events |
| **Admin** | League manager(s) at a location | Everything a player can, plus: approve/edit/reject scores, close out weeks, manage players/teams/courses/schedule, approve subs, recalculate handicaps, send alerts, toggle features |
| **Super-admin** | Platform owner | Create locations, edit branding, invite location admins, set location-level feature flags |

Every change an admin makes (score approvals, week publishes, handicap changes, roster edits) is recorded in a permanent audit trail with who did it and what changed.

## 3. Getting Started (Everyone)

### Logging in
1. Open the app link for your location.
2. Enter the **email** and **league password** your admin set up for you.
3. First login links your account automatically — your profile, team, and scores appear.

### Installing on your phone
The app prompts you to install after login. If you miss it:
- **iPhone (Safari):** Share button → "Add to Home Screen."
- **Android (Chrome):** Menu (⋮) → "Install app" / "Add to Home screen."

### Turning on alerts
Open the **Alerts** tab and tap **Enable Notifications** when prompted. You'll get push notifications for league announcements even when the app is closed.

### Changing your password
League tab → **My Profile** → scroll to the password section → enter current + new password → **Update Password**.

---

## 4. Player Guide

### 4.1 The League Dashboard

After login, the League tab shows:
- A **Submit Scores** banner — lit up when a round is open, locked when there's no active week.
- Tiles: **Standings**, **My Profile**, **Request Sub**, **Friends**. (Tiles your facility has disabled won't appear.)
- Admins also see an **Open Admin Panel** button.

### 4.2 Submitting Scores

One submission covers your **whole team** — either teammate can do it, once per week.

1. Tap the **Submit Scores** banner while the week is open.
2. Enter both players' scores hole by hole (the app shows par and running vs-par for each of you).
3. Use **Prev/Next** to move between holes; the progress dots show what's filled.
4. On the last hole, review the scorecard grid, then tap **Submit**.

**What happens next:** your scores go into a **review queue** — the message says "awaiting admin review." They do **not** appear in standings until an admin approves them. This keeps standings trustworthy.

Rules to know:
- Every hole must have a score from 1–20 for both players.
- You can't submit twice — a second attempt says your team already submitted. If you made a mistake, tell your admin; they can fix any score.
- You can only submit for **your own team**, and only while the round is **open**.

### 4.3 Standings

- **This Week / Season** toggle — one event or cumulative.
- **Net / Gross** toggle — net uses handicaps.
- Players see closed (finalized) weeks; the current open week appears once it's closed out.
- Only **admin-approved** scores count. Missed weeks show as penalty entries (see [Section 8.3](#83-the-missed-week-penalty)).

### 4.4 My Profile

- **Stat tiles**: rounds played, best/average scores, current handicap.
- **Season trend chart**: your scores over the season, in week order.
- **Scoring by par type**: how you do on par 3s / 4s / 5s.
- **Recent rounds**: hole-by-hole history.
- **Avatar**: tap the camera badge to upload and crop a photo.
- **Password change** at the bottom.

### 4.5 Requesting a Sub

Can't make a week? League tab → **Request Sub**.

1. Pick the week, enter your sub's name and contact info, and their handicap (whole number, −2 to 27). Past subs can be re-picked quickly.
2. Submit — your admin reviews it.
3. Once approved, the admin enters the sub's score for your team that week. The sub's score counts for your **team's standings**, but never for **your personal handicap**.

### 4.6 Friends & Messages

- **Search any player across all locations** (name search) and follow them.
- When two players follow each other (**mutual**), direct messaging unlocks.
- Privacy: cross-location search shows only name, photo, and location — never email, phone, or handicap.

### 4.7 Events

Facility events (tournaments, socials) with live capacity meters. Tap to RSVP; tap again to cancel.

---

## 5. Admin Guide

Open with **League tab → Open Admin Panel**. Sections (left nav on desktop, chip row on mobile): Overview, Scores, Standings, Players, Subs, Handicap, League, Schedule, Events, Courses, Skins, Alerts. (Sections for disabled features are hidden.)

### 5.1 First-Time League Setup (do these in order)

1. **Courses** — create each 9- or 18-hole course with **par for every hole** (3–6 each). The app blocks score entry on any event whose course has missing/invalid pars — no silent guessing.
2. **League** (League section) — create the league (name, number of weeks, start date), then mark it as your **working league** (the star/working toggle). The working league is the one all admin screens operate on.
3. **Players** — add players (name, email, handicap, league password). Adding an email auto-creates their login account. Or bulk-import from CSV (Players → Import).
4. **Teams** — pair players into 2-person teams. Every team must have exactly two players.
5. **Schedule** — generate the season's weeks from the League section (one tap), or add events one at a time in Schedule. Assign a course to each event. Set bye weeks as needed.
6. **Open week 1** — in Schedule, set the first event's status to **Open**. Players can now submit.

### 5.2 Scores Section (the one you'll live in)

Pick any week from the dropdown. For each team you can:
- **Enter Scores** — type both players' hole scores yourself (all holes, 1–20). Admin-entered scores are **instantly approved** — no review step.
- **Edit** — fix an existing score (works on **closed weeks too** — see 5.3).
- **Remove** — delete a score row entirely.
- **Pending review** tag — appears on player-submitted scores awaiting your approval. Open the team, check the numbers, save to approve (or correct and save).
- **Skins calculator** — after scores are in, one tap computes skins (lowest unique score per hole, no carryovers; only players marked "in skins" count).

Handicaps recalculate automatically after every save.

**Sub weeks:** when an approved sub played, the score you enter is tagged automatically — it counts for the team but is excluded from the absent player's handicap. If the sub has their own profile, they also get a personal copy of the round.

### 5.3 Fixing Past Weeks

Life happens — someone's score was wrong three weeks ago, or someone got a missed-week penalty but actually played.

Just pick the old week in **Scores** and edit or enter the score. The week itself stays closed (standings history stays intact), and:
- Entering a real score for a player who had a **missed-week penalty automatically deletes the penalty** — the real score takes over.
- The correction is audit-logged, and the player's handicap recalculates.

### 5.4 Overview — Closing Out a Week

The Overview section is a 5-step wizard for week close-out:

1. **Review scores** — confirms every team submitted; shows who's missing.
2. **Skins** — the week's skins results (skipped if skins is toggled off).
3. **Results** — final team leaderboard for the week.
4. **Email** — a pre-written recap email; copy it or open your mail app.
5. **Publish** — the big one. In a single, safe operation it:
   - Blocks if any scores are still **pending** (approve or reject them first);
   - Applies the **missed-week penalty** to any rostered player with no score;
   - Closes the week and **opens the next scheduled week** automatically;
   - Is idempotent — clicking twice can't double-apply anything.

### 5.5 Players Section

- **Add/edit players** — name, email, handicap (−2 to 27), skins participation, handicap lock, league password.
- **Create account** — for players added without email; sets up their login.
- **CSV import** — bulk player+team import (Players → Import). Teams require both players.
- **Delete player** — blocked while they're on an active team (remove them from the team first); otherwise removes the player and all their data.
- **Teams** — create/edit/delete; exactly two players each; edits are audit-logged.

### 5.6 Subs Section

- **Pending** requests: **Approve** (creates/links the sub's profile automatically) or **Deny**.
- **Sub roster**: every sub who has played, with inline handicap editing (−2 to 40 for subs).
- **Sync Profile**: re-link an approved sub whose profile is missing.

### 5.7 Handicap Section

- Live view of every player's score history and computed handicap (see [Section 9](#9-the-handicap-system) for the math).
- **Recalculate All** — one tap, recalculates everyone (locked players skipped).
- **Lock** — freezes a player's handicap against auto-recalc (for special cases).

### 5.8 Schedule Section

- Add/edit events: name, week number, dates, course, status, notes.
- **Weekly hole event** — e.g., closest-to-pin on hole 5; shows players a target celebration.
- **Bye weeks** — marked events that don't expect scores.
- **Statuses**: `draft` (staged), `open` (accepting scores — only one at a time), `cancelled`. Weeks become `closed` only through **Publish** in Overview — there is no manual "close" button, and closed weeks can't be deleted.

### 5.9 League Section

- Multiple leagues per location (e.g., Monday and Wednesday night).
- **Working league** — the one admin screens operate on (exactly one).
- **Display on website** (`active`) — whether players see it. Multiple can be active.
- **Generate schedule** — creates all season weeks in one tap.
- **Features card** — league-level toggles (see 5.11).

### 5.10 Alerts Section

Write an announcement → **Send**. Every member sees it in their Alerts tab; members with notifications on get a push. Alerts can carry an expiry date and can be deleted.

### 5.11 Feature Toggles

Golfsoftware-style "show it when you need it": **League section → Features card** toggles per-league:

| Flag | What it hides when OFF |
|---|---|
| `friends` | Friends tile, friend search, messaging |
| `events` | The Events tab and RSVP |
| `skins` | Skins admin section, skins calculator, skins step in close-out |
| `subs` | Request Sub tile and Subs admin section |

Everything defaults **ON**. Toggles are enforced server-side too — a disabled feature can't be used even by someone crafting requests outside the app. Location-wide defaults live in the super-admin console; a league setting overrides its location.

---

## 6. The Weekly Admin Cycle (Cheat Sheet)

Print this for new admins:

```
MONDAY (league night)
  □ Week is Open (happens automatically when you published last week)
  □ Players submit scores from their phones as they finish

AFTER PLAY / NEXT MORNING
  □ Admin Panel → Scores
  □ Approve pending scores (open each team → verify → Save)
  □ Enter scores for any team that didn't self-submit
  □ Enter sub scores where subs played
  □ Run the Skins calculator

CLOSING THE WEEK
  □ Admin Panel → Overview
  □ Step 1: Review scores  (missing players listed here)
  □ Step 2: Skins
  □ Step 3: Results
  □ Step 4: Copy/send recap email
  □ Step 5: PUBLISH  → penalties applied, week closed, next week opened

DONE — standings update, players see final results.
```

---

## 7. Super-Admin Guide

The super-admin console lives at `/super-admin` (visible only to super-admin accounts, via the shield icon in the header).

### 7.1 Dashboard
All locations with member/admin/league counts.

### 7.2 Create a Location
**New Location** → name, **slug** (lowercase, URL-safe — becomes the subdomain, e.g. slug `appleton` → `appleton.yourdomain.com`), brand color, timezone. One form, no SQL.

### 7.3 Edit a Location
Open a location card →
- **Branding**: name, primary color (the whole app re-themes from this one color), logo URLs, timezone.
- **Feature flags**: location-wide defaults for friends/events/skins/subs.

### 7.4 Invite an Admin
In the location editor, enter the email of an **existing account holder** → **Add Admin**. If they've never signed in, have them create an account first, then retry. The person immediately gets the Admin Panel at that location.

### 7.5 How Subdomain Boot Works
When someone visits `<slug>.yourdomain.com`, the app looks up the slug and boots with that location's branding, timezone, and data — one deployment serves every location. Unknown hostnames fall back to the build's default location.

---

## 8. How the System Thinks (Key Concepts)

Understanding these four ideas explains almost every behavior in the app.

### 8.1 The Score Lifecycle

Every score is `pending`, `verified`, or `rejected`:

```
player submits  ──►  PENDING  ──(admin approves/saves)──►  VERIFIED
                        │
                        └──(admin rejects)──►  REJECTED (kept for audit,
                                               invisible everywhere else)
admin enters    ─────────────────────────────►  VERIFIED (instantly)
```

- **Standings** count verified scores (and verified missed-week penalties).
- **Handicaps, skins, and stats** count verified *played* scores only.
- A week cannot be **published** while any score is pending.

### 8.2 One Open Week

Per league, exactly **one** event can be open at a time — the database itself enforces it. Publishing closes the current week and opens the next automatically. This is why there's no "close" button in Schedule: closing is publishing.

### 8.3 The Missed-Week Penalty

When a week is published, any rostered player with no approved score gets a penalty entry: **net = their handicap + 7**. It counts in standings (missing a week costs you) but never affects handicaps or skins. If a real score is entered later, the penalty is deleted automatically.

### 8.4 Teams and Rosters Are Dated

Team membership is stored with effective dates, so a player can be in the Monday **and** Wednesday leagues, mid-season roster changes keep history intact, and old weeks always show who was actually on the team **at that time**.

---

## 9. The Handicap System

GBIG uses a custom league handicap, recalculated automatically after every score save:

1. Take the player's most recent **N** verified rounds (N = the league's week count, up to 12; sub-played weeks excluded).
2. For each round, compute the **differential**: gross score − course par.
3. Discard outliers: with 4+ rounds, drop the **1 highest**; with 5+ rounds, also drop the **1 lowest**.
4. Average what's left and multiply by **0.90**.
5. Round **down** to a whole number (never up).
6. Clamp between **−2 and 27** (subs: −2 to 40).

New players need at least 1 round before a handicap computes; until then, the admin-entered starting handicap is used. Admins can **lock** any player's handicap to stop auto-recalc, or override it manually (both audit-logged).

**Net score = gross − handicap** (the handicap in effect the night the round was saved — stored with the score, so later handicap changes never rewrite old net results).

---

## 10. Troubleshooting & FAQ

**"No active round right now."**
No event is open. Admin: Schedule → set the week's status to Open (or Publish the previous week, which opens the next automatically).

**"You are not rostered for this event."**
The player isn't on a team in the working league, or their profile isn't linked. Admin: check Players → Teams, and that the player's account email matches.

**"Score entry is unavailable because this course is missing valid hole pars."**
The event's course has no pars (or the wrong number of holes). Admin: Courses → edit the course → enter a 3–6 par for every hole.

**Player submitted, but standings didn't change.**
Working as designed — the score is pending. Admin: Scores → open the team → Save (approves it). Standings update on approval.

**"Resolve N pending score row(s) before publishing."**
Approve or reject the pending scores in the Scores section, then Publish again.

**"Your team already submitted scores for this round."**
The other teammate (or an admin) already submitted. Corrections go through the admin.

**Someone got a penalty but actually played.**
Scores → pick that (closed) week → Enter Scores for the team. The penalty is replaced automatically.

**"The Phase 1 database migrations must be applied…"**
The app is newer than the database (or vice versa). This should only appear mid-deployment; if it persists, the database migrations haven't been run.

**A whole section/tile is missing.**
The feature is toggled off. League admins: League → Features. Location defaults: super-admin console.

**Player can't log in.**
Admin: Players → find the player → confirm email → Create Account (if never created) or reset the league password.

**Push notifications stopped.**
Re-enable in the Alerts tab. (If keys were rotated, every device re-subscribes once.)

**Two leagues at once?**
Yes — create both in League, mark both "display on website." Admin screens follow the **working** league; switch the working league to manage the other. (Deeper per-player multi-league UX arrives with the formats engine phase.)

---

_Questions this manual doesn't answer? Every admin action is recorded in the audit trail, and the technical plan lives in `PLAN.md` / `PLAN-REVIEW-LOG.md` in the repository._
