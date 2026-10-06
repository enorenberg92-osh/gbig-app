-- Minimal synthetic schema for function-level PostgreSQL tests.
-- This is NOT a replacement for a production schema dump or migration replay.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE TABLE locations(id UUID PRIMARY KEY);
CREATE TABLE location_admins(user_id UUID, location_id UUID REFERENCES locations);
CREATE TABLE league_config(id UUID PRIMARY KEY, location_id UUID, name TEXT, num_weeks INTEGER, is_working BOOLEAN);
CREATE TABLE players(id UUID PRIMARY KEY, user_id UUID, location_id UUID, name TEXT, handicap NUMERIC, team_id UUID);
CREATE TABLE teams(id UUID PRIMARY KEY, location_id UUID, league_id UUID, name TEXT);
CREATE TABLE courses(id UUID PRIMARY KEY, location_id UUID, num_holes INTEGER, hole_pars JSONB, total_par INTEGER, stroke_index JSONB);
CREATE TABLE events(id UUID PRIMARY KEY, location_id UUID, league_id UUID, course_id UUID, name TEXT, status TEXT, week_number INTEGER, start_date DATE, event_date DATE, is_bye BOOLEAN DEFAULT false, format TEXT DEFAULT 'stroke', format_config JSONB DEFAULT '{"version":1}');
CREATE TABLE team_memberships(team_id UUID, player_id UUID, location_id UUID, league_id UUID, effective_from DATE, effective_to DATE);
CREATE TABLE scores(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID REFERENCES events, player_id UUID REFERENCES players, team_id UUID, location_id UUID, hole_scores INTEGER[], hole_stats JSONB, gross_total INTEGER, net_total INTEGER, handicap_used INTEGER, sub_played BOOLEAN, entry_type TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now(), format_points NUMERIC);
CREATE UNIQUE INDEX scores_one_entry ON scores(event_id, player_id, entry_type) WHERE status <> 'rejected';
CREATE UNIQUE INDEX one_open_event ON events(location_id,league_id) WHERE status='open';
CREATE TABLE audit_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID, location_id UUID, action TEXT, entity TEXT, entity_id UUID, before_data JSONB, after_data JSONB, created_at TIMESTAMPTZ DEFAULT now());
