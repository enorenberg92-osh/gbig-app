-- ============================================================================
-- Live rounds + tonight's leaderboard + simulator ingest (2026-09-23)
-- ----------------------------------------------------------------------------
-- Hole-by-hole "scratch" state for the open week. Players' phones (and, later,
-- the simulator software) record each hole as it is finished; the lobby
-- leaderboard reads it in realtime. The official record is still the pending
-- `scores` row created by submit_scores (or, for the simulator, by the
-- finalize helper below) — live rows never feed standings or handicaps.
--
--   live_rounds                  one row per (event, player), NULL = unplayed
--   record_live_hole(...)        player / admin RPC, one hole at a time
--   scores trigger               flags live rows submitted when a played
--                                score lands (and unflags on reject/delete)
--   location_api_keys            per-location simulator keys (SHA-256 only)
--   admin_create_location_api_key / admin_revoke_location_api_key
--   sim_ingest(key_hash, payload) service-role only; used by the sim-ingest
--                                edge function (docs/SIM_INTEGRATION.md)
--
-- Idempotent: safe to run more than once. One transaction.
-- ============================================================================

BEGIN;

-- ── 1. live_rounds ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.live_rounds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  event_id      UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  team_id       UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  hole_scores   INTEGER[] NOT NULL DEFAULT '{}',
  holes_played  INTEGER NOT NULL DEFAULT 0,
  handicap_used INTEGER,
  source        TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'sim')),
  bay           TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT live_rounds_event_player_key UNIQUE (event_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_live_rounds_location_updated
  ON public.live_rounds (location_id, updated_at DESC);

-- holes_played is always derived from the array (NULL = not played yet).
CREATE OR REPLACE FUNCTION public.live_rounds_derive()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.holes_played := (SELECT count(*) FROM unnest(NEW.hole_scores) AS h(v) WHERE v IS NOT NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS live_rounds_derive ON public.live_rounds;
CREATE TRIGGER live_rounds_derive
  BEFORE INSERT OR UPDATE ON public.live_rounds
  FOR EACH ROW EXECUTE FUNCTION public.live_rounds_derive();

-- Read-only to clients: everyone at the location can watch the leaderboard;
-- every write goes through record_live_hole / sim_ingest.
ALTER TABLE public.live_rounds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "live_rounds: location members read" ON public.live_rounds;
CREATE POLICY "live_rounds: location members read" ON public.live_rounds
  FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));
REVOKE ALL ON public.live_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.live_rounds TO authenticated;

-- Realtime: the leaderboard subscribes to changes. Supabase projects always
-- have this publication; guard anyway so plain Postgres (CI) still migrates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'live_rounds'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.live_rounds;
  END IF;
END $$;


-- ── 2. Shared internals (never granted to clients) ──────────────────────────

-- Handicap for a slot exactly as submit_scores computes it: an approved sub
-- plays at the sub's handicap; otherwise the rostered player's.
CREATE OR REPLACE FUNCTION public.live_slot_handicap(p_event_id UUID, p_player_id UUID)
RETURNS TABLE (handicap_used INTEGER, sub_played BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE sub_row public.subs%ROWTYPE;
BEGIN
  SELECT * INTO sub_row FROM public.subs
   WHERE event_id = p_event_id AND player_id = p_player_id AND status = 'approved'
   ORDER BY created_at DESC NULLS LAST
   LIMIT 1;
  IF FOUND THEN
    handicap_used := COALESCE(
      (SELECT round(sp.handicap)::integer FROM public.players sp WHERE sp.id = sub_row.sub_player_id),
      round(COALESCE(sub_row.sub_handicap, 0))::integer
    );
    sub_played := true;
  ELSE
    handicap_used := (SELECT round(COALESCE(p.handicap, 0))::integer FROM public.players p WHERE p.id = p_player_id);
    sub_played := false;
  END IF;
  RETURN NEXT;
END;
$$;

-- Write one hole for one rostered player on an OPEN event. Callers have
-- already authorized; this validates the payload and does the upsert.
-- p_strokes NULL clears the hole. Rows already submitted are left alone.
CREATE OR REPLACE FUNCTION public.live_record_hole_internal(
  p_event_id UUID,
  p_player_id UUID,
  p_hole INTEGER,
  p_strokes INTEGER,
  p_source TEXT,
  p_bay TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  num_holes INTEGER;
  roster_team UUID;
  hcp INTEGER;
  already BOOLEAN;
  live_row public.live_rounds%ROWTYPE;
BEGIN
  -- Share-lock the event: publish_week / submit_scores take FOR UPDATE, so a
  -- hole can't land mid-publish, while holes from many bays never block each other.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found' USING ERRCODE = '22023'; END IF;
  IF event_row.status <> 'open' THEN
    RAISE EXCEPTION 'This week is not open for scoring' USING ERRCODE = '22023';
  END IF;

  SELECT c.num_holes INTO num_holes FROM public.courses c WHERE c.id = event_row.course_id;
  IF num_holes IS NULL OR num_holes < 1 THEN
    RAISE EXCEPTION 'This week has no course assigned' USING ERRCODE = '22023';
  END IF;
  IF p_hole IS NULL OR p_hole < 1 OR p_hole > num_holes THEN
    RAISE EXCEPTION 'Hole must be between 1 and %', num_holes USING ERRCODE = '22023';
  END IF;
  IF p_strokes IS NOT NULL AND (p_strokes < 1 OR p_strokes > 20) THEN
    RAISE EXCEPTION 'Strokes must be from 1 to 20' USING ERRCODE = '22023';
  END IF;
  IF p_source NOT IN ('app', 'sim') THEN
    RAISE EXCEPTION 'Unknown source' USING ERRCODE = '22023';
  END IF;

  SELECT r.team_id INTO roster_team
    FROM public.roster_at r
   WHERE r.event_id = p_event_id AND r.player_id = p_player_id
   LIMIT 1;
  IF roster_team IS NULL THEN
    RAISE EXCEPTION 'That player is not rostered for this week' USING ERRCODE = '22023';
  END IF;

  already := EXISTS (
    SELECT 1 FROM public.scores s
     WHERE s.event_id = p_event_id AND s.player_id = p_player_id
       AND s.entry_type = 'played' AND s.status <> 'rejected'
  );
  SELECT h.handicap_used INTO hcp FROM public.live_slot_handicap(p_event_id, p_player_id) h;

  INSERT INTO public.live_rounds (
    location_id, event_id, player_id, team_id, hole_scores, handicap_used, source, bay, submitted
  ) VALUES (
    event_row.location_id, p_event_id, p_player_id, roster_team,
    array_fill(NULL::integer, ARRAY[num_holes]), hcp, p_source, p_bay, already
  )
  ON CONFLICT (event_id, player_id) DO NOTHING;

  IF already THEN
    UPDATE public.live_rounds SET submitted = true
     WHERE event_id = p_event_id AND player_id = p_player_id AND NOT submitted;
  END IF;

  -- Writing an element past the end of a 1-D array pads with NULLs, so a
  -- course switched mid-week still works; the array is trimmed to num_holes.
  UPDATE public.live_rounds lr
     SET hole_scores = (CASE WHEN array_length(lr.hole_scores, 1) >= num_holes
                             THEN lr.hole_scores[1:num_holes]
                             ELSE lr.hole_scores
                             || array_fill(NULL::integer, ARRAY[num_holes - COALESCE(array_length(lr.hole_scores, 1), 0)])
                        END),
         team_id = roster_team,
         handicap_used = hcp,
         source = p_source,
         bay = COALESCE(p_bay, lr.bay),
         updated_at = now()
   WHERE lr.event_id = p_event_id AND lr.player_id = p_player_id AND NOT lr.submitted;
  UPDATE public.live_rounds lr
     SET hole_scores[p_hole] = p_strokes
   WHERE lr.event_id = p_event_id AND lr.player_id = p_player_id AND NOT lr.submitted
  RETURNING * INTO live_row;

  IF NOT FOUND THEN
    SELECT * INTO live_row FROM public.live_rounds
     WHERE event_id = p_event_id AND player_id = p_player_id;
  END IF;

  RETURN jsonb_build_object(
    'event_id', live_row.event_id,
    'player_id', live_row.player_id,
    'team_id', live_row.team_id,
    'hole_scores', to_jsonb(live_row.hole_scores),
    'holes_played', live_row.holes_played,
    'handicap_used', live_row.handicap_used,
    'submitted', live_row.submitted,
    'updated_at', live_row.updated_at
  );
END;
$$;

-- Turn a team's complete live rounds into its pending submission — the same
-- rows submit_scores inserts (submit_scores itself is left untouched).
CREATE OR REPLACE FUNCTION public.live_finalize_team_internal(
  p_event_id UUID,
  p_team_id UUID,
  p_source TEXT DEFAULT 'sim'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  waiting JSONB;
  rec RECORD;
  gross INTEGER;
  inserted_count INTEGER := 0;
  affected INTEGER;
BEGIN
  -- Same lock submit_scores / publish_week take.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found' USING ERRCODE = '22023'; END IF;
  IF event_row.status <> 'open' THEN
    RAISE EXCEPTION 'This week is not open for scoring' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This week has no course assigned' USING ERRCODE = '22023'; END IF;

  -- Every rostered teammate needs every hole before anything is submitted.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id', r.player_id, 'name', r.player_name,
           'holes_played', COALESCE(lr.holes_played, 0)))
    INTO waiting
    FROM public.roster_at r
    LEFT JOIN public.live_rounds lr ON lr.event_id = r.event_id AND lr.player_id = r.player_id
   WHERE r.event_id = p_event_id AND r.team_id = p_team_id
     AND NOT EXISTS (
       SELECT 1 FROM public.scores s
        WHERE s.event_id = p_event_id AND s.player_id = r.player_id
          AND s.entry_type = 'played' AND s.status <> 'rejected')
     AND (lr.id IS NULL
          OR COALESCE(array_length(lr.hole_scores, 1), 0) < course_row.num_holes
          OR lr.holes_played < course_row.num_holes
          OR EXISTS (SELECT 1 FROM unnest(lr.hole_scores[1:course_row.num_holes]) h(v) WHERE v IS NULL));
  IF waiting IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'incomplete', 'waiting_on', waiting);
  END IF;

  FOR rec IN
    SELECT r.player_id, lr.hole_scores[1:course_row.num_holes] AS holes, h.handicap_used, h.sub_played
      FROM public.roster_at r
      JOIN public.live_rounds lr ON lr.event_id = r.event_id AND lr.player_id = r.player_id
      CROSS JOIN LATERAL public.live_slot_handicap(p_event_id, r.player_id) h
     WHERE r.event_id = p_event_id AND r.team_id = p_team_id
       AND NOT EXISTS (
         SELECT 1 FROM public.scores s
          WHERE s.event_id = p_event_id AND s.player_id = r.player_id
            AND s.entry_type = 'played' AND s.status <> 'rejected')
  LOOP
    gross := (SELECT sum(v) FROM unnest(rec.holes) AS t(v));
    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, hole_stats, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, rec.player_id, p_team_id, rec.holes, NULL, gross,
      gross - rec.handicap_used, rec.handicap_used, rec.sub_played, 'played', 'pending',
      event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;

  IF inserted_count > 0 THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'score.submit', 'events', p_event_id, NULL,
      jsonb_build_object('team_id', p_team_id, 'source', p_source, 'status', 'pending')
    );
  END IF;

  RETURN jsonb_build_object(
    'finalized', true,
    'inserted', inserted_count,
    'already_submitted', inserted_count = 0,
    'status', 'pending'
  );
END;
$$;


-- ── 3. record_live_hole (players + admins) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_live_hole(
  p_event_id UUID,
  p_player_id UUID,
  p_hole INTEGER,
  p_strokes INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  target_team UUID;
  is_teammate BOOLEAN;
  is_admin BOOLEAN;
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;

  SELECT r.team_id INTO target_team
    FROM public.roster_at r
   WHERE r.event_id = p_event_id AND r.player_id = p_player_id
   LIMIT 1;

  -- A rostered player may score themself and their own teammates; an admin
  -- of the event's location may score anyone rostered (dispute fixes).
  is_teammate := target_team IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.roster_at r
      JOIN public.players p ON p.id = r.player_id
     WHERE r.event_id = p_event_id AND r.team_id = target_team
       AND p.user_id = auth.uid() AND p.location_id = event_row.location_id
  );
  is_admin := public.is_admin_of_location(event_row.location_id);
  IF NOT is_teammate AND NOT is_admin THEN
    RAISE EXCEPTION 'You can only record holes for your own team' USING ERRCODE = '42501';
  END IF;

  result := public.live_record_hole_internal(p_event_id, p_player_id, p_hole, p_strokes, 'app', NULL);

  -- Per-hole writes from the team itself are scratch state (the submission is
  -- what gets audited); an admin touching someone else's card is recorded.
  IF NOT is_teammate THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'live.admin_record_hole', 'live_rounds', p_event_id, NULL,
      jsonb_build_object('player_id', p_player_id, 'hole', p_hole, 'strokes', p_strokes)
    );
  END IF;
  RETURN result;
END;
$$;


-- ── 4. scores → live_rounds.submitted ───────────────────────────────────────
-- A played score landing (submit_scores, admin entry, sim finalize) closes the
-- live card; a rejection or delete reopens it so the team can resubmit.
CREATE OR REPLACE FUNCTION public.live_rounds_sync_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev UUID;
  pl UUID;
  now_submitted BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ev := OLD.event_id; pl := OLD.player_id;
  ELSE
    ev := NEW.event_id; pl := NEW.player_id;
  END IF;
  now_submitted := EXISTS (
    SELECT 1 FROM public.scores s
     WHERE s.event_id = ev AND s.player_id = pl
       AND s.entry_type = 'played' AND s.status <> 'rejected'
  );
  UPDATE public.live_rounds
     SET submitted = now_submitted
   WHERE event_id = ev AND player_id = pl AND submitted IS DISTINCT FROM now_submitted;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS scores_live_submitted_ins ON public.scores;
CREATE TRIGGER scores_live_submitted_ins
  AFTER INSERT ON public.scores
  FOR EACH ROW WHEN (NEW.entry_type = 'played')
  EXECUTE FUNCTION public.live_rounds_sync_submitted();

DROP TRIGGER IF EXISTS scores_live_submitted_upd ON public.scores;
CREATE TRIGGER scores_live_submitted_upd
  AFTER UPDATE OF status ON public.scores
  FOR EACH ROW WHEN (NEW.entry_type = 'played' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.live_rounds_sync_submitted();

DROP TRIGGER IF EXISTS scores_live_submitted_del ON public.scores;
CREATE TRIGGER scores_live_submitted_del
  AFTER DELETE ON public.scores
  FOR EACH ROW WHEN (OLD.entry_type = 'played')
  EXECUTE FUNCTION public.live_rounds_sync_submitted();


-- ── 5. Per-location API keys (simulator) ────────────────────────────────────
-- Only the SHA-256 hex digest of a key is stored; the plaintext is returned
-- once by admin_create_location_api_key and never again.
CREATE TABLE IF NOT EXISTS public.location_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'sim' CHECK (kind IN ('sim')),
  key_hash     TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix   TEXT,
  label        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_location_api_keys_location ON public.location_api_keys (location_id, kind);

ALTER TABLE public.location_api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "location_api_keys: location admins read" ON public.location_api_keys;
CREATE POLICY "location_api_keys: location admins read" ON public.location_api_keys
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id));
REVOKE ALL ON public.location_api_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, location_id, kind, key_prefix, label, created_at, last_used_at, revoked_at)
  ON public.location_api_keys TO authenticated;

-- Create (or rotate) the location's key of this kind. Any older active key of
-- the same kind is revoked in the same transaction.
CREATE OR REPLACE FUNCTION public.admin_create_location_api_key(
  p_location_id UUID,
  p_kind TEXT DEFAULT 'sim',
  p_label TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plain TEXT;
  new_id UUID;
  revoked_count INTEGER;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  IF COALESCE(p_kind, '') NOT IN ('sim') THEN RAISE EXCEPTION 'Unknown key kind'; END IF;

  -- 2 × v4 UUID = 244 random bits from the core CSPRNG (no pgcrypto needed).
  plain := 'gbig_' || p_kind || '_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  UPDATE public.location_api_keys
     SET revoked_at = now()
   WHERE location_id = p_location_id AND kind = p_kind AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;

  INSERT INTO public.location_api_keys (location_id, kind, key_hash, key_prefix, label, created_by)
  VALUES (p_location_id, p_kind, encode(sha256(convert_to(plain, 'UTF8')), 'hex'),
          left(plain, 13), NULLIF(trim(COALESCE(p_label, '')), ''), auth.uid())
  RETURNING id INTO new_id;

  PERFORM public.write_audit_event(
    p_location_id, 'api_key.create', 'location_api_keys', new_id, NULL,
    jsonb_build_object('kind', p_kind, 'key_prefix', left(plain, 13), 'revoked_previous', revoked_count)
  );
  RETURN jsonb_build_object('id', new_id, 'kind', p_kind, 'key', plain, 'key_prefix', left(plain, 13));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_location_api_key(p_key_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE key_row public.location_api_keys%ROWTYPE;
BEGIN
  SELECT * INTO key_row FROM public.location_api_keys WHERE id = p_key_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(key_row.location_id);
  IF key_row.revoked_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.location_api_keys SET revoked_at = now() WHERE id = p_key_id;
  PERFORM public.write_audit_event(
    key_row.location_id, 'api_key.revoke', 'location_api_keys', p_key_id,
    jsonb_build_object('kind', key_row.kind, 'key_prefix', key_row.key_prefix), NULL
  );
  RETURN true;
END;
$$;


-- ── 6. sim_ingest (service role only; called by the sim-ingest function) ────
-- p_key_hash: SHA-256 hex of the presented key (hashed in the edge function).
-- p_payload:  { player_id | player_email, hole?, strokes?, holes?: [{hole,strokes}],
--               bay?, event_id?, finalize? }
-- Errors: 28000 = bad key (401); 22023 = bad request (422).
CREATE OR REPLACE FUNCTION public.sim_ingest(p_key_hash TEXT, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key_row public.location_api_keys%ROWTYPE;
  loc UUID;
  target_player UUID;
  target_event UUID;
  target_team UUID;
  match_count INTEGER;
  bay TEXT;
  hole_item JSONB;
  live JSONB;
  fin JSONB;
BEGIN
  SELECT * INTO key_row FROM public.location_api_keys
   WHERE key_hash = lower(COALESCE(p_key_hash, '')) AND kind = 'sim' AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '28000'; END IF;
  loc := key_row.location_id;
  -- Throttled so a busy night isn't a write per hole on the key row.
  UPDATE public.location_api_keys SET last_used_at = now()
   WHERE id = key_row.id AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '5 minutes');

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Body must be a JSON object' USING ERRCODE = '22023';
  END IF;
  bay := NULLIF(left(trim(COALESCE(p_payload->>'bay', '')), 40), '');

  -- Player: by id or by email, always inside the key's location.
  IF COALESCE(p_payload->>'player_id', '') <> '' THEN
    IF (p_payload->>'player_id') !~* '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'player_id is not a valid id' USING ERRCODE = '22023';
    END IF;
    SELECT p.id INTO target_player FROM public.players p
     WHERE p.id = (p_payload->>'player_id')::uuid AND p.location_id = loc;
  ELSIF COALESCE(p_payload->>'player_email', '') <> '' THEN
    SELECT count(*), min(p.id::text)::uuid INTO match_count, target_player
      FROM public.players p
     WHERE p.location_id = loc AND lower(p.email) = lower(trim(p_payload->>'player_email'));
    IF match_count > 1 THEN
      RAISE EXCEPTION 'More than one player has that email; send player_id' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'player_id or player_email is required' USING ERRCODE = '22023';
  END IF;
  IF target_player IS NULL THEN RAISE EXCEPTION 'Player not found' USING ERRCODE = '22023'; END IF;

  -- Event: the open week the player is rostered in (one league per location
  -- in practice; event_id disambiguates if a location ever runs two).
  IF COALESCE(p_payload->>'event_id', '') <> '' THEN
    IF (p_payload->>'event_id') !~* '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'event_id is not a valid id' USING ERRCODE = '22023';
    END IF;
    SELECT e.id INTO target_event FROM public.events e
     WHERE e.id = (p_payload->>'event_id')::uuid AND e.location_id = loc AND e.status = 'open';
    IF target_event IS NULL THEN RAISE EXCEPTION 'That week is not open' USING ERRCODE = '22023'; END IF;
  ELSE
    SELECT count(DISTINCT e.id), min(e.id::text)::uuid INTO match_count, target_event
      FROM public.events e
      JOIN public.roster_at r ON r.event_id = e.id AND r.player_id = target_player
     WHERE e.location_id = loc AND e.status = 'open';
    IF match_count = 0 THEN
      RAISE EXCEPTION 'Player is not rostered for an open league week' USING ERRCODE = '22023';
    ELSIF match_count > 1 THEN
      RAISE EXCEPTION 'Player is in more than one open week; send event_id' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT r.team_id INTO target_team FROM public.roster_at r
   WHERE r.event_id = target_event AND r.player_id = target_player LIMIT 1;
  IF target_team IS NULL THEN
    RAISE EXCEPTION 'Player is not rostered for this week' USING ERRCODE = '22023';
  END IF;

  -- Finalize needs the event row FOR UPDATE; take it before recording holes
  -- (which share-lock the row) so two bays finishing together queue up
  -- instead of deadlocking on a share -> update lock upgrade.
  IF p_payload->'finalize' = 'true'::jsonb THEN
    PERFORM 1 FROM public.events WHERE id = target_event FOR UPDATE;
  END IF;

  -- Holes: a single {hole, strokes} and/or a catch-up batch in "holes".
  IF p_payload ? 'hole' THEN
    IF jsonb_typeof(p_payload->'hole') <> 'number'
       OR (p_payload ? 'strokes' AND jsonb_typeof(p_payload->'strokes') NOT IN ('number', 'null')) THEN
      RAISE EXCEPTION 'hole and strokes must be numbers' USING ERRCODE = '22023';
    END IF;
    live := public.live_record_hole_internal(
      target_event, target_player, (p_payload->>'hole')::integer,
      (p_payload->>'strokes')::integer, 'sim', bay);
  END IF;
  IF jsonb_typeof(p_payload->'holes') = 'array' THEN
    IF jsonb_array_length(p_payload->'holes') > 36 THEN
      RAISE EXCEPTION 'Too many holes in one request' USING ERRCODE = '22023';
    END IF;
    FOR hole_item IN SELECT value FROM jsonb_array_elements(p_payload->'holes') LOOP
      IF jsonb_typeof(hole_item->'hole') <> 'number'
         OR jsonb_typeof(COALESCE(hole_item->'strokes', 'null'::jsonb)) NOT IN ('number', 'null') THEN
        RAISE EXCEPTION 'hole and strokes must be numbers' USING ERRCODE = '22023';
      END IF;
      live := public.live_record_hole_internal(
        target_event, target_player, (hole_item->>'hole')::integer,
        (hole_item->>'strokes')::integer, 'sim', bay);
    END LOOP;
  END IF;

  IF p_payload->'finalize' = 'true'::jsonb THEN
    fin := public.live_finalize_team_internal(target_event, target_team, 'sim');
  ELSIF live IS NULL THEN
    RAISE EXCEPTION 'Nothing to do: send hole + strokes, holes, or finalize' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'event_id', target_event,
    'player_id', target_player,
    'team_id', target_team,
    'live', live,
    'finalize', fin
  );
END;
$$;


-- ── 7. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.live_rounds_derive() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_rounds_sync_submitted() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_slot_handicap(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.live_record_hole_internal(UUID, UUID, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.live_finalize_team_internal(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_live_hole(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_create_location_api_key(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_revoke_location_api_key(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sim_ingest(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_live_hole(UUID, UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_location_api_key(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_location_api_key(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sim_ingest(TEXT, JSONB) TO service_role;

COMMIT;
