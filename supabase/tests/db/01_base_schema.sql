-- Reconstructed PRE-MIGRATION base schema (state before
-- supabase/migrations/add_multi_location_safe.sql). Every item here is an
-- INFERENCE from SUPABASE_SCHEMA.md, the legacy migrations, the dated
-- migrations' own references, and src/ client usage. See README "Invented
-- base-schema items" for the provenance of each non-documented column.

-- Legacy tables that 202607110001 later drops
CREATE TABLE public.leagues (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.admins (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  email   TEXT,
  role    TEXT
);

-- league_config: canonical league row (columns from AdminLeague.jsx / leagueUtils.js
-- and phase-1 migration ORDER BY clauses)
CREATE TABLE public.league_config (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  num_weeks  INTEGER,
  start_date DATE,
  is_active  BOOLEAN DEFAULT false,
  is_working BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.courses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  num_holes  INTEGER DEFAULT 9,
  start_hole INTEGER DEFAULT 1,
  hole_pars  JSONB,
  total_par  INTEGER,
  pars       INTEGER[],          -- legacy column referenced by 202607100002 backfill
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.players (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  phone           TEXT,
  handicap        NUMERIC,
  team_id         UUID,
  user_id         UUID REFERENCES auth.users(id),
  league_id       UUID CONSTRAINT players_league_id_fkey REFERENCES public.leagues(id),
  avatar_url      TEXT,
  is_sub          BOOLEAN DEFAULT false,
  in_skins        BOOLEAN DEFAULT false,
  handicap_locked BOOLEAN DEFAULT false,
  league_password TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT,
  player1_id UUID REFERENCES public.players(id),
  player2_id UUID REFERENCES public.players(id),
  league_id  UUID REFERENCES public.leagues(id),   -- per SUPABASE_SCHEMA.md (FK -> leagues)
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.players
  ADD CONSTRAINT players_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id);

CREATE TABLE public.events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  event_date      DATE,
  start_date      DATE,
  end_date        DATE,
  status          TEXT DEFAULT 'draft',
  course_id       UUID REFERENCES public.courses(id),
  league_id       UUID REFERENCES public.leagues(id),  -- per SUPABASE_SCHEMA.md (FK -> leagues)
  notes           TEXT,
  week_number     INTEGER,
  is_bye          BOOLEAN DEFAULT false,
  hole_event_hole INTEGER,
  hole_event_name TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
  -- NOTE: deliberately NO is_playoff column (no migration adds it).
);

-- scores: hole_scores integer[] and NOT NULL hole_scores/gross_total per the
-- comments in 202607100002 and 202607300002 ("live schema").
CREATE TABLE public.scores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID REFERENCES public.events(id),
  player_id     UUID REFERENCES public.players(id),
  hole_scores   INTEGER[] NOT NULL,
  gross_total   INTEGER NOT NULL,
  net_total     INTEGER NOT NULL,
  handicap_used INTEGER,
  sub_played    BOOLEAN DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.handicap_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID REFERENCES public.players(id),
  event_id      UUID REFERENCES public.events(id),
  handicap      NUMERIC,
  scores_used   INTEGER,
  calculated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.skins (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  UUID REFERENCES public.events(id),
  player_id UUID REFERENCES public.players(id),
  hole      INTEGER,
  won       BOOLEAN,
  notes     TEXT
);

CREATE TABLE public.news_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT,
  body       TEXT,
  league_id  UUID CONSTRAINT news_posts_league_id_fkey REFERENCES public.leagues(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.app_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT,
  description TEXT,
  event_date  DATE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.subs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID REFERENCES public.players(id),
  event_id       UUID REFERENCES public.events(id),
  sub_first_name TEXT NOT NULL,
  sub_last_name  TEXT NOT NULL,
  sub_email      TEXT,
  sub_phone      TEXT,
  sub_handicap   NUMERIC,
  sub_player_id  UUID REFERENCES public.players(id),
  status         TEXT DEFAULT 'pending',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.alerts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT,
  body       TEXT,
  sent_by    TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT,
  auth_key   TEXT,
  user_id    UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.follows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id  UUID REFERENCES public.players(id),
  following_id UUID REFERENCES public.players(id),
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (follower_id, following_id)
);

CREATE TABLE public.messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID REFERENCES public.players(id),
  recipient_id UUID REFERENCES public.players(id),
  content      TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Production seed referenced by add_super_admins.sql (FK to auth.users).
INSERT INTO auth.users (id, email) VALUES ('acd6c8a3-35e1-4892-a928-0a8996c02d10', 'owner@example.test');
