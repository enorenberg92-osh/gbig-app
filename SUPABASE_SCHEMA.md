# GBIG App — Supabase Schema Reference

Go to: https://supabase.com/dashboard/project/mtuzmasicpcxcvtslevm/editor

---

## Tables You Already Have (verify these columns exist)

### `players`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | Full name |
| email | text | Used for login |
| phone | text | Phone number |
| handicap | numeric | Current handicap (updated automatically) |
| team_id | uuid | FK → teams.id |
| user_id | uuid | FK → auth.users.id (set when player logs in) |

### `teams`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | e.g. "Smith / Jones" |
| player1_id | uuid | FK → players.id |
| player2_id | uuid | FK → players.id |
| league_id | uuid | FK → leagues.id |

### `events`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | e.g. "Week 4 — Pebble Beach" |
| event_date | date | |
| status | text | 'open', 'closed', 'cancelled' |
| course_id | uuid | FK → courses.id ← **ADD THIS if missing** |
| league_id | uuid | FK → leagues.id |
| notes | text | Optional |

### `scores`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| event_id | uuid | FK → events.id |
| player_id | uuid | FK → players.id |
| hole_scores | jsonb | **ADD THIS** — array of 9 integers e.g. [4,3,5,4,4,5,3,4,4] |
| gross_score | integer | Sum of hole_scores |
| net_score | integer | gross_score - player handicap |
| notes | text | Optional |
| created_at | timestamptz | Auto |

### `courses`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | Course name |
| num_holes | integer | 9 or 18 |
| start_hole | integer | 1 (front 9) or 10 (back 9) |
| hole_pars | jsonb | **ADD THIS** — array of par values e.g. [4,3,4,5,4,3,4,4,4] |
| total_par | integer | Sum of hole_pars |

### `handicap_history`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| player_id | uuid | FK → players.id |
| event_id | uuid | FK → events.id |
| handicap | numeric | Handicap after this event |
| scores_used | integer | How many scores were in the calculation |
| calculated_at | timestamptz | Auto |

### `skins`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| event_id | uuid | FK → events.id |
| player_id | uuid | FK → players.id |
| hole | integer | Hole number (1–9) |
| won | boolean | true = won skin, false = tied |
| notes | text | Optional |

### `news_posts`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | |
| body | text | |
| created_at | timestamptz | Auto |

### `app_events`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | |
| description | text | |
| event_date | date | |

### `admins`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| user_id | uuid | FK → auth.users.id ← This is what the app checks |
| email | text | For reference |
| role | text | 'owner' or 'co-admin' |

---

## New Table to Create: `subs`

Run this in the Supabase SQL Editor:

```sql
create table subs (
  id            uuid default gen_random_uuid() primary key,
  player_id     uuid references players(id),
  event_id      uuid references events(id),
  sub_first_name text not null,
  sub_last_name  text not null,
  sub_email      text,
  sub_phone      text,
  sub_handicap   numeric,
  status         text default 'pending',  -- 'pending', 'approved', 'denied'
  created_at     timestamptz default now()
);
```

---

## Columns to Add (if not already there)

Run these in the Supabase SQL Editor one at a time:

```sql
-- Add hole_scores to scores table
alter table scores add column if not exists hole_scores jsonb;

-- Add course_id to events table
alter table events add column if not exists course_id uuid references courses(id);

-- Add hole_pars to courses table
alter table courses add column if not exists hole_pars jsonb;
alter table courses add column if not exists num_holes integer default 9;
alter table courses add column if not exists start_hole integer default 1;
alter table courses add column if not exists total_par integer;

-- Add user_id to players table (links player to Supabase auth account)
alter table players add column if not exists user_id uuid references auth.users(id);
```

---

## Row Level Security (RLS) — Recommended Settings

In Supabase → Authentication → Policies, enable RLS on all tables and add these policies:

**players, teams, scores, events, courses, skins, news_posts, app_events:**
- SELECT: allow authenticated users (players can read)
- INSERT/UPDATE/DELETE: allow only admins (check admins table)

**admins:**
- SELECT: allow authenticated users to check their own admin status
- INSERT/UPDATE/DELETE: owner only

**subs:**
- INSERT: allow authenticated users (players submit their own)
- SELECT/UPDATE: allow admins only

---

## How Player Login Works

1. Admin adds a player in the Players section
2. Admin creates a Supabase auth account for that player:
   - Go to Supabase → Authentication → Users → "Add User"
   - Enter the player's email + the shared league password
3. Player logs in with their email + shared league password
4. On first login, the app links their auth.users.id to their players record via user_id

**The shared password is set and managed by you as the admin.**
Players never need to reset or manage passwords themselves.
