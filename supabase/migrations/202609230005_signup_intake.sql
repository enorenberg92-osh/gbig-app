-- League sign-up intake: the location website's WPForms sign-up form (or a
-- Zapier/Make zap) POSTs each entry to the signup-webhook edge function,
-- which authenticates it with a per-location key and hands it to
-- signup_webhook_ingest() below using the service role. Each entry is stored
-- in signup_submissions and, when it's a clean pair of players, turned into
-- players + a team in the location's working league straight away. Anything
-- unclear lands in the admin "Sign-ups" inbox as needs_review.
--
-- Deploy: run this file, then
--   supabase functions deploy signup-webhook --no-verify-jwt
BEGIN;

-- ── 1. Tables ────────────────────────────────────────────────────────────────

-- One key per location + integration kind. Only a SHA-256 hex digest is kept;
-- the plaintext is shown to the admin once when generated.
CREATE TABLE IF NOT EXISTS public.location_integration_keys (
  location_id  UUID NOT NULL REFERENCES public.locations(id),
  kind         TEXT NOT NULL DEFAULT 'signup_webhook' CHECK (kind IN ('signup_webhook')),
  key_hash     TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix   TEXT NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (location_id, kind)
);

CREATE TABLE IF NOT EXISTS public.signup_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        UUID NOT NULL REFERENCES public.locations(id),
  source             TEXT NOT NULL DEFAULT 'webhook',
  raw_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Same shape as lib/signupImport.buildSignupRow: {p1:{fullName,email,…}, p2, teamName, …}
  parsed             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Sorted lower-cased player emails ("a@x,b@y"); drives 24h duplicate detection.
  email_key          TEXT,
  status             TEXT NOT NULL DEFAULT 'needs_review'
                     CHECK (status IN ('imported', 'needs_review', 'duplicate', 'dismissed')),
  -- Players this entry resolved to ([p1, p2]) and the ones it had to create.
  player_ids         UUID[] NOT NULL DEFAULT '{}',
  created_player_ids UUID[] NOT NULL DEFAULT '{}',
  team_id            UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  league_id          UUID REFERENCES public.league_config(id) ON DELETE SET NULL,
  duplicate_of       UUID REFERENCES public.signup_submissions(id) ON DELETE SET NULL,
  error_text         TEXT,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_submissions_location_created
  ON public.signup_submissions(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_submissions_email_key
  ON public.signup_submissions(location_id, email_key, created_at DESC)
  WHERE email_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signup_submissions_needs_review
  ON public.signup_submissions(location_id)
  WHERE status = 'needs_review';

-- ── 2. RLS: admins read; every write goes through the functions below ──────
ALTER TABLE public.location_integration_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "location_integration_keys: location admins read" ON public.location_integration_keys;
CREATE POLICY "location_integration_keys: location admins read" ON public.location_integration_keys
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

DROP POLICY IF EXISTS "signup_submissions: location admins read" ON public.signup_submissions;
CREATE POLICY "signup_submissions: location admins read" ON public.signup_submissions
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

REVOKE ALL ON public.location_integration_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.signup_submissions FROM PUBLIC, anon, authenticated;
-- The hash never leaves the database, even to admins.
GRANT SELECT (location_id, kind, key_prefix, created_at, last_used_at)
  ON public.location_integration_keys TO authenticated;
GRANT SELECT ON public.signup_submissions TO authenticated;

-- ── 3. Helpers ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.signup_email_key(p_parsed JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(string_agg(DISTINCT e, ',' ORDER BY e), '')
    FROM (
      SELECT NULLIF(lower(trim(p_parsed #>> ARRAY[k, 'email'])), '') AS e
        FROM unnest(ARRAY['p1', 'p2']) k
    ) s
   WHERE e IS NOT NULL;
$$;

-- Inbox/push summary of one submission.
CREATE OR REPLACE FUNCTION public.signup_submission_summary(p_submission_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', s.id,
    'location_id', s.location_id,
    'status', s.status,
    'reason', s.error_text,
    'team_id', s.team_id,
    'team_name', COALESCE(t.name, NULLIF(trim(s.parsed->>'teamName'), '')),
    'player_names', to_jsonb(array_remove(ARRAY[
      NULLIF(trim(s.parsed #>> '{p1,fullName}'), ''),
      NULLIF(trim(s.parsed #>> '{p2,fullName}'), '')
    ], NULL))
  )
  FROM public.signup_submissions s
  LEFT JOIN public.teams t ON t.id = s.team_id
  WHERE s.id = p_submission_id;
$$;

-- Internal twin of admin_save_team's create branch (202609230001 §10). That
-- RPC authorizes via require_location_admin → auth.uid(), which is NULL for
-- the service-role webhook, so the webhook path uses this instead. Callers
-- authorize first. Kept deliberately small: create only, never edit.
CREATE OR REPLACE FUNCTION public.signup_create_team(
  p_league_id UUID,
  p_name TEXT,
  p_player_one UUID,
  p_player_two UUID,
  p_submission_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  team_id_value UUID;
  season_start DATE;
  pid UUID;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  IF p_player_one IS NULL OR p_player_two IS NULL OR p_player_one = p_player_two THEN
    RAISE EXCEPTION 'Team players must be different';
  END IF;
  IF (SELECT count(*) FROM public.players
       WHERE id IN (p_player_one, p_player_two) AND location_id = league_row.location_id) <> 2 THEN
    RAISE EXCEPTION 'Both players must belong to the league location';
  END IF;
  season_start := COALESCE(league_row.start_date, DATE '1900-01-01');

  PERFORM set_config('app.roster_write', 'on', true);
  INSERT INTO public.teams (name, player1_id, player2_id, league_id, location_id)
  VALUES (
    COALESCE(NULLIF(trim(p_name), ''), 'New team'),
    p_player_one, p_player_two, p_league_id, league_row.location_id
  ) RETURNING id INTO team_id_value;

  -- A returning player with an earlier (closed) stint in this league starts
  -- the day after it ended so the no-overlap constraint holds.
  FOREACH pid IN ARRAY ARRAY[p_player_one, p_player_two] LOOP
    INSERT INTO public.team_memberships (location_id, league_id, player_id, team_id, effective_from)
    SELECT league_row.location_id, p_league_id, pid, team_id_value,
           greatest(season_start, COALESCE(max(tm.effective_to) + 1, season_start))
      FROM public.team_memberships tm
     WHERE tm.player_id = pid AND tm.league_id = p_league_id AND tm.effective_to IS NOT NULL;
  END LOOP;

  UPDATE public.players SET team_id = team_id_value WHERE id IN (p_player_one, p_player_two);

  PERFORM public.write_audit_event(
    league_row.location_id, 'roster.team_create', 'teams', team_id_value, NULL,
    jsonb_build_object(
      'name', COALESCE(NULLIF(trim(p_name), ''), 'New team'), 'league_id', p_league_id,
      'player_ids', jsonb_build_array(p_player_one, p_player_two),
      'source', 'signup', 'signup_id', p_submission_id
    )
  );
  RETURN team_id_value;
END;
$$;

-- ── 4. Processing (webhook + admin retry) ───────────────────────────────────
-- Resolve/create both players, then create the team when it's unambiguous.
-- Never raises for data problems: they become status needs_review with a
-- reason in error_text, and any unexpected error rolls back just this
-- attempt's writes (sub-transaction) and is recorded the same way.
CREATE OR REPLACE FUNCTION public.process_signup_submission(p_submission_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub public.signup_submissions%ROWTYPE;
  league_row public.league_config%ROWTYPE;
  ids UUID[] := '{}';
  created UUID[];
  p JSONB;
  pid UUID;
  i INTEGER;
  full_name TEXT;
  first_name_value TEXT;
  email_value TEXT;
  hcp_text TEXT;
  conflict TEXT;
  reason TEXT;
  team_id_value UUID;
  team_name_value TEXT;
  league_id_value UUID;
BEGIN
  SELECT * INTO sub FROM public.signup_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sign-up not found'; END IF;
  IF sub.status = 'imported' THEN
    RETURN public.signup_submission_summary(sub.id);
  END IF;
  created := sub.created_player_ids;

  BEGIN
    IF COALESCE(trim(sub.parsed #>> '{p1,fullName}'), '') = '' THEN
      reason := 'No player name found — check the webhook field mapping (p1_name, p1_email, …).';
    ELSE
      FOR i IN 1..2 LOOP
        p := sub.parsed -> ('p' || i);
        full_name := NULLIF(regexp_replace(trim(COALESCE(p->>'fullName', '')), '\s+', ' ', 'g'), '');
        EXIT WHEN full_name IS NULL;
        full_name := left(full_name, 120);
        email_value := NULLIF(lower(trim(COALESCE(p->>'email', ''))), '');
        pid := NULL;

        -- A retry keeps the player this entry resolved to last time (covers
        -- players without an email, who can't be matched again).
        IF i <= COALESCE(array_length(sub.player_ids, 1), 0) THEN
          SELECT id INTO pid FROM public.players
           WHERE id = sub.player_ids[i] AND location_id = sub.location_id;
        END IF;
        -- Returning player: same email at this location (case-insensitive).
        IF pid IS NULL AND email_value IS NOT NULL THEN
          SELECT id INTO pid FROM public.players
           WHERE location_id = sub.location_id AND lower(trim(email)) = email_value
           ORDER BY COALESCE(is_sub, false), created_at, id
           LIMIT 1;
        END IF;
        IF pid IS NULL THEN
          -- Same columns and rules as admin_create_player (202609230001 §11).
          hcp_text := trim(COALESCE(p->>'handicap', ''));
          first_name_value := split_part(full_name, ' ', 1);
          INSERT INTO public.players (
            first_name, last_name, name, email, handicap, in_skins,
            handicap_locked, is_sub, location_id
          ) VALUES (
            first_name_value,
            NULLIF(trim(substr(full_name, length(first_name_value) + 1)), ''),
            full_name,
            email_value,
            greatest(-2, least(27, CASE WHEN hcp_text ~ '^-?[0-9]+(\.[0-9]+)?$'
                                        THEN round(hcp_text::numeric)::integer ELSE 0 END)),
            false, false, false,
            sub.location_id
          ) RETURNING id INTO pid;
          created := array_append(created, pid);
          PERFORM public.write_audit_event(
            sub.location_id, 'player.create', 'players', pid, NULL,
            jsonb_build_object('id', pid, 'name', full_name, 'source', 'signup', 'signup_id', sub.id)
          );
        END IF;
        ids := array_append(ids, pid);
      END LOOP;

      IF array_length(ids, 1) = 1 THEN
        reason := 'Only one player on the form — pair them with a partner in Players & Teams.';
      ELSIF ids[1] = ids[2] THEN
        reason := 'Both players resolve to the same player (same email).';
      END IF;

      IF reason IS NULL THEN
        SELECT * INTO league_row FROM public.league_config
         WHERE location_id = sub.location_id AND is_working
         LIMIT 1;
        IF NOT FOUND THEN
          reason := 'No working league is set — choose one in Leagues, then retry.';
        ELSE
          league_id_value := league_row.id;
        END IF;
      END IF;

      IF reason IS NULL THEN
        SELECT string_agg(format('%s is already on %s', pl.name, t.name), '; ' ORDER BY pl.name)
          INTO conflict
          FROM public.team_memberships tm
          JOIN public.players pl ON pl.id = tm.player_id
          JOIN public.teams t ON t.id = tm.team_id
         WHERE tm.league_id = league_row.id
           AND tm.effective_to IS NULL
           AND tm.player_id = ANY(ids);
        IF conflict IS NOT NULL THEN
          reason := conflict || ' in ' || COALESCE(league_row.name, 'the working league') || '.';
        END IF;
      END IF;

      IF reason IS NULL THEN
        -- The mapper always sends teamName; fall back to its "Last1/Last2"
        -- rule (a one-word name counts as the last name) just in case.
        SELECT COALESCE(
                 NULLIF(trim(sub.parsed->>'teamName'), ''),
                 string_agg(CASE WHEN position(' ' IN n) > 0 THEN substr(n, position(' ' IN n) + 1) ELSE n END, '/' ORDER BY ord)
               )
          INTO team_name_value
          FROM unnest(ARRAY[
                 regexp_replace(trim(sub.parsed #>> '{p1,fullName}'), '\s+', ' ', 'g'),
                 regexp_replace(trim(sub.parsed #>> '{p2,fullName}'), '\s+', ' ', 'g')
               ]) WITH ORDINALITY AS u(n, ord);
        team_id_value := public.signup_create_team(
          league_row.id, left(team_name_value, 80), ids[1], ids[2], sub.id
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    reason := 'Import failed: ' || SQLERRM;
    ids := sub.player_ids;
    created := sub.created_player_ids;
    team_id_value := NULL;
  END;

  UPDATE public.signup_submissions SET
    status             = CASE WHEN team_id_value IS NOT NULL THEN 'imported' ELSE 'needs_review' END,
    player_ids         = ids,
    created_player_ids = created,
    team_id            = team_id_value,
    league_id          = COALESCE(league_id_value, league_id),
    error_text         = reason,
    processed_at       = now()
  WHERE id = sub.id;

  RETURN public.signup_submission_summary(sub.id);
END;
$$;

-- Called only by the signup-webhook edge function (service role). Looks the
-- location up from the key digest, rate-limits, dedupes, stores, processes.
-- Returns {ok:false,error:'invalid_key'|'rate_limited'} instead of raising so
-- the function can map it to 401/429.
CREATE OR REPLACE FUNCTION public.signup_webhook_ingest(
  p_key_hash TEXT,
  p_raw JSONB,
  p_parsed JSONB,
  p_source TEXT DEFAULT 'webhook'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key_row public.location_integration_keys%ROWTYPE;
  parsed_value JSONB := CASE WHEN jsonb_typeof(p_parsed) = 'object' THEN p_parsed ELSE '{}'::jsonb END;
  email_key_value TEXT;
  dup_id UUID;
  dup_at TIMESTAMPTZ;
  new_id UUID;
  recent_count INTEGER;
BEGIN
  SELECT * INTO key_row FROM public.location_integration_keys
   WHERE kind = 'signup_webhook' AND key_hash = lower(COALESCE(p_key_hash, ''));
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_key'); END IF;

  IF pg_column_size(p_raw) > 65536 OR pg_column_size(parsed_value) > 65536 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_large');
  END IF;

  -- Serialize intake per location so parallel posts can't both slip under
  -- the rate limit or both miss the duplicate check.
  PERFORM pg_advisory_xact_lock(hashtext('signup_intake:' || key_row.location_id::text));

  -- A registration-opening rush must not lose entries (WPForms doesn't
  -- retry): past 30/hour they're stored for review instead of imported, and
  -- only a clearly abusive volume is refused.
  SELECT count(*) INTO recent_count FROM public.signup_submissions
   WHERE location_id = key_row.location_id
     AND created_at > now() - INTERVAL '1 hour';
  IF recent_count >= 300 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  UPDATE public.location_integration_keys SET last_used_at = now()
   WHERE location_id = key_row.location_id AND kind = key_row.kind;

  email_key_value := public.signup_email_key(parsed_value);
  IF email_key_value IS NOT NULL THEN
    SELECT id, created_at INTO dup_id, dup_at FROM public.signup_submissions
     WHERE location_id = key_row.location_id
       AND email_key = email_key_value
       AND status <> 'dismissed'
       AND created_at > now() - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  INSERT INTO public.signup_submissions (
    location_id, source, raw_payload, parsed, email_key, status, duplicate_of, error_text, processed_at
  ) VALUES (
    key_row.location_id,
    left(COALESCE(NULLIF(trim(p_source), ''), 'webhook'), 40),
    COALESCE(p_raw, '{}'::jsonb),
    parsed_value,
    email_key_value,
    CASE WHEN dup_id IS NOT NULL THEN 'duplicate' ELSE 'needs_review' END,
    dup_id,
    CASE WHEN dup_id IS NOT NULL
         THEN 'Same email(s) as a sign-up received ' || to_char(dup_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC — retry to import anyway.'
    END,
    CASE WHEN dup_id IS NOT NULL THEN now() END
  ) RETURNING id INTO new_id;

  IF dup_id IS NOT NULL THEN
    RETURN public.signup_submission_summary(new_id) || jsonb_build_object('ok', true);
  END IF;
  IF recent_count >= 30 THEN
    UPDATE public.signup_submissions
       SET error_text = 'Arrived during a burst of sign-ups (30+ this hour) — check it, then Retry import.',
           processed_at = now()
     WHERE id = new_id;
    RETURN public.signup_submission_summary(new_id) || jsonb_build_object('ok', true);
  END IF;
  RETURN public.process_signup_submission(new_id) || jsonb_build_object('ok', true);
END;
$$;

-- ── 5. Admin RPCs ────────────────────────────────────────────────────────────
-- Retry: re-run processing (also "import anyway" for a duplicate or an entry
-- that was dismissed by mistake).
CREATE OR REPLACE FUNCTION public.admin_retry_signup(p_submission_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub public.signup_submissions%ROWTYPE;
  result JSONB;
BEGIN
  SELECT * INTO sub FROM public.signup_submissions WHERE id = p_submission_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sign-up not found'; END IF;
  PERFORM public.require_location_admin(sub.location_id);
  IF sub.status = 'imported' THEN RAISE EXCEPTION 'This sign-up was already imported'; END IF;
  result := public.process_signup_submission(sub.id);
  PERFORM public.write_audit_event(
    sub.location_id, 'signup.retry', 'signup_submissions', sub.id,
    jsonb_build_object('status', sub.status, 'error_text', sub.error_text),
    jsonb_build_object('status', result->>'status', 'error_text', result->>'reason', 'team_id', result->>'team_id')
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_dismiss_signup(p_submission_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub public.signup_submissions%ROWTYPE;
BEGIN
  SELECT * INTO sub FROM public.signup_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sign-up not found'; END IF;
  PERFORM public.require_location_admin(sub.location_id);
  IF sub.status = 'imported' THEN
    RAISE EXCEPTION 'This sign-up was already imported — edit or delete the team in Players & Teams instead';
  END IF;
  UPDATE public.signup_submissions SET status = 'dismissed', processed_at = now() WHERE id = sub.id;
  PERFORM public.write_audit_event(
    sub.location_id, 'signup.dismiss', 'signup_submissions', sub.id,
    jsonb_build_object('status', sub.status), jsonb_build_object('status', 'dismissed')
  );
  RETURN public.signup_submission_summary(sub.id);
END;
$$;

-- Generate (or rotate) the location's webhook key. The plaintext is returned
-- once and never stored; rotating immediately invalidates the old key.
CREATE OR REPLACE FUNCTION public.admin_rotate_signup_key(p_location_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_key TEXT;
  had_key BOOLEAN;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  -- 2 × v4 UUID = 244 random bits from the server CSPRNG.
  new_key := 'gbsk_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  had_key := EXISTS (
    SELECT 1 FROM public.location_integration_keys
     WHERE location_id = p_location_id AND kind = 'signup_webhook'
  );
  INSERT INTO public.location_integration_keys (location_id, kind, key_hash, key_prefix, created_by)
  VALUES (
    p_location_id, 'signup_webhook',
    encode(sha256(convert_to(new_key, 'UTF8')), 'hex'),
    left(new_key, 9), auth.uid()
  )
  ON CONFLICT (location_id, kind) DO UPDATE SET
    key_hash     = EXCLUDED.key_hash,
    key_prefix   = EXCLUDED.key_prefix,
    created_by   = EXCLUDED.created_by,
    created_at   = now(),
    last_used_at = NULL;
  PERFORM public.write_audit_event(
    p_location_id, CASE WHEN had_key THEN 'integration.key_rotate' ELSE 'integration.key_create' END,
    'location_integration_keys', NULL, NULL,
    jsonb_build_object('kind', 'signup_webhook', 'key_prefix', left(new_key, 9))
  );
  RETURN new_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_signup_key(p_location_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  DELETE FROM public.location_integration_keys
   WHERE location_id = p_location_id AND kind = 'signup_webhook';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.write_audit_event(
    p_location_id, 'integration.key_revoke', 'location_integration_keys', NULL,
    jsonb_build_object('kind', 'signup_webhook'), NULL
  );
  RETURN true;
END;
$$;

-- ── 6. Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.signup_email_key(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.signup_submission_summary(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.signup_create_team(UUID, TEXT, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.process_signup_submission(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.signup_webhook_ingest(TEXT, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_retry_signup(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_dismiss_signup(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_rotate_signup_key(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_revoke_signup_key(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.signup_webhook_ingest(TEXT, JSONB, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_retry_signup(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dismiss_signup(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rotate_signup_key(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_signup_key(UUID) TO authenticated;

COMMIT;
