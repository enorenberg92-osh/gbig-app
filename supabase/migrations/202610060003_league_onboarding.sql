-- Staff confirms a roster once. Atomic team imports queue resumable account
-- creation and one welcome email per player per session.
BEGIN;
CREATE TABLE IF NOT EXISTS public.league_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  league_id uuid NOT NULL REFERENCES public.league_config(id),
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  email text,
  account_status text NOT NULL DEFAULT 'pending' CHECK(account_status IN ('pending','ready','error','needs_email')),
  login_kind text CHECK(login_kind IN ('new','existing')),
  auth_user_id uuid,
  email_status text NOT NULL DEFAULT 'pending' CHECK(email_status IN ('pending','sending','sent','error','not_configured','needs_email','review')),
  account_error text,
  email_error text,
  welcome_payload jsonb,
  email_attempted_at timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(league_id,player_id)
);
ALTER TABLE public.league_onboarding ENABLE ROW LEVEL SECURITY;
CREATE POLICY league_onboarding_admin_read ON public.league_onboarding FOR SELECT TO authenticated
  USING(public.is_admin_of_location(location_id));
REVOKE ALL ON public.league_onboarding FROM anon,authenticated;
GRANT SELECT ON public.league_onboarding TO authenticated;
GRANT ALL ON public.league_onboarding TO service_role;
CREATE INDEX league_onboarding_pending ON public.league_onboarding(league_id,created_at) WHERE email_status <> 'sent';

CREATE OR REPLACE FUNCTION public.admin_import_league_team(p_league_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  l public.league_config%ROWTYPE; p jsonb; existing public.players%ROWTYPE;
  ids uuid[] := '{}'; player_id_value uuid; team_id_value uuid; current_teams uuid[];
  email_value text; name_value text; name_key text; handicap_value integer; match_count integer; slot_value text;
BEGIN
  SELECT * INTO l FROM public.league_config WHERE id=p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(l.location_id);
  IF NOT COALESCE(l.is_working,false) THEN RAISE EXCEPTION 'Choose this session as the working league before importing'; END IF;
  IF jsonb_typeof(p_payload->'players') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'players')<>2 THEN
    RAISE EXCEPTION 'A partnership needs exactly two golfers';
  END IF;
  -- Serialize imports within a venue so repeated/concurrent files cannot create
  -- duplicate identities or teams. All row writes roll back on any failure.
  PERFORM pg_advisory_xact_lock(hashtextextended(l.location_id::text,17));
  slot_value := NULLIF(trim(concat_ws(' ',NULLIF(trim(p_payload->>'day'),''),NULLIF(trim(p_payload->>'time'),''))),'');
  FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'players') LOOP
    name_value := regexp_replace(trim(p->>'name'),'\s+',' ','g');
    name_key := lower(name_value);
    email_value := NULLIF(lower(trim(p->>'email')),'');
    IF name_value IS NULL OR name_value='' THEN RAISE EXCEPTION 'Both golfers need a name'; END IF;
    IF NOT p ? 'handicap' OR p->>'handicap' IS NULL OR (p->>'handicap') !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION '%: enter a whole-number 9-hole handicap',name_value;
    END IF;
    handicap_value := (p->>'handicap')::integer;
    IF handicap_value < -2 OR handicap_value > 27 THEN RAISE EXCEPTION '%: handicap must be between -2 and 27',name_value; END IF;
    IF email_value IS NOT NULL AND email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION '%: check the email address',name_value; END IF;
    IF email_value IS NOT NULL THEN
      SELECT count(*) INTO match_count FROM public.players WHERE location_id=l.location_id AND lower(trim(email))=email_value;
      IF match_count>1 THEN RAISE EXCEPTION '%: this email belongs to multiple roster entries; resolve them first',name_value; END IF;
      SELECT * INTO existing FROM public.players WHERE location_id=l.location_id AND lower(trim(email))=email_value;
      IF FOUND AND lower(regexp_replace(trim(existing.name),'\s+',' ','g')) IS DISTINCT FROM name_key THEN
        RAISE EXCEPTION '%: this email is already assigned to a different golfer',name_value;
      END IF;
    ELSE existing := NULL; END IF;
    IF existing.id IS NULL THEN
      SELECT count(*) INTO match_count FROM public.players WHERE location_id=l.location_id AND lower(regexp_replace(trim(name),'\s+',' ','g'))=name_key;
      IF match_count>1 THEN RAISE EXCEPTION '%: multiple matching names need staff review',name_value; END IF;
      SELECT * INTO existing FROM public.players WHERE location_id=l.location_id AND lower(regexp_replace(trim(name),'\s+',' ','g'))=name_key;
      IF existing.email IS NOT NULL AND lower(trim(existing.email)) IS DISTINCT FROM email_value THEN
        RAISE EXCEPTION '%: the existing golfer has a different email; update that record first',name_value;
      END IF;
    END IF;
    IF existing.id IS NULL THEN
      player_id_value := public.admin_create_player(l.location_id,p || jsonb_build_object('email',email_value,'in_skins',false,'handicap_locked',false,'league_password','password'));
    ELSE
      player_id_value := existing.id;
      IF EXISTS(SELECT 1 FROM public.team_memberships WHERE league_id=l.id AND player_id=player_id_value AND effective_to IS NULL) THEN
        IF existing.handicap IS DISTINCT FROM handicap_value::numeric THEN RAISE EXCEPTION '%: already registered with a different handicap; edit the player rather than re-importing',name_value; END IF;
      ELSE
        PERFORM public.admin_update_player(player_id_value,jsonb_build_object('email',email_value,'handicap',handicap_value));
      END IF;
    END IF;
    IF player_id_value=ANY(ids) THEN RAISE EXCEPTION 'Partners must be different people with separate emails'; END IF;
    ids := array_append(ids,player_id_value);
    PERFORM set_config('app.player_write','on',true);
    UPDATE public.players SET phone=COALESCE(NULLIF(trim(p->>'phone'),''),phone),time_slot=COALESCE(slot_value,time_slot) WHERE id=player_id_value;
    existing := NULL;
  END LOOP;
  SELECT array_agg(DISTINCT team_id) INTO current_teams FROM public.team_memberships
    WHERE league_id=l.id AND player_id=ANY(ids) AND effective_to IS NULL;
  IF current_teams IS NOT NULL THEN
    IF cardinality(current_teams)<>1 OR (SELECT count(*) FROM public.team_memberships WHERE league_id=l.id AND team_id=current_teams[1] AND player_id=ANY(ids) AND effective_to IS NULL)<>2 THEN
      RAISE EXCEPTION 'One of these golfers is already registered with a different partner';
    END IF;
    team_id_value := current_teams[1];
  ELSE
    team_id_value := public.admin_save_team(NULL,l.id,COALESCE(NULLIF(trim(p_payload->>'team_name'),''),'League team'),to_jsonb(ids));
  END IF;
  INSERT INTO public.league_onboarding(location_id,league_id,player_id,email)
    SELECT l.location_id,l.id,id,NULLIF(lower(trim(email)),'') FROM public.players WHERE id=ANY(ids)
    ON CONFLICT(league_id,player_id) DO NOTHING;
  RETURN jsonb_build_object('team_id',team_id_value,'player_ids',to_jsonb(ids),'reused',current_teams IS NOT NULL);
END; $$;
REVOKE ALL ON FUNCTION public.admin_import_league_team(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_import_league_team(uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_queue_league_onboarding(p_league_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE l public.league_config%ROWTYPE; inserted_count integer;
BEGIN
  SELECT * INTO l FROM public.league_config WHERE id=p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(l.location_id);
  IF NOT COALESCE(l.is_working,false) THEN RAISE EXCEPTION 'Choose the working session first'; END IF;
  INSERT INTO public.league_onboarding(location_id,league_id,player_id,email)
    SELECT DISTINCT l.location_id,l.id,p.id,NULLIF(lower(trim(p.email)),'')
    FROM public.team_memberships m JOIN public.players p ON p.id=m.player_id
    WHERE m.league_id=l.id AND m.location_id=l.location_id AND p.location_id=l.location_id AND m.effective_to IS NULL
    ON CONFLICT(league_id,player_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  -- Corrected emails can finish registration; never resend a recorded welcome.
  UPDATE public.league_onboarding j SET email=NULLIF(lower(trim(p.email)),''),account_status='pending',email_status='pending',account_error=NULL,email_error=NULL,updated_at=now()
    FROM public.players p WHERE j.player_id=p.id AND j.league_id=l.id AND j.email_status<>'sent'
    AND j.email IS DISTINCT FROM NULLIF(lower(trim(p.email)),'') AND j.welcome_payload IS NULL;
  RETURN inserted_count;
END; $$;
REVOKE ALL ON FUNCTION public.admin_queue_league_onboarding(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_queue_league_onboarding(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.service_claim_league_onboarding(p_league_id uuid,p_player_ids uuid[],p_limit integer DEFAULT 10)
RETURNS SETOF public.league_onboarding LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  RETURN QUERY WITH candidates AS (
    SELECT id FROM public.league_onboarding WHERE league_id=p_league_id
      AND (p_player_ids IS NULL OR player_id=ANY(p_player_ids))
      AND (account_status<>'ready' OR email_status IN ('pending','sending','error','not_configured'))
      AND (lease_until IS NULL OR lease_until<now())
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,10))
  ) UPDATE public.league_onboarding j SET lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now()
    FROM candidates c WHERE j.id=c.id RETURNING j.*;
END; $$;
REVOKE ALL ON FUNCTION public.service_claim_league_onboarding(uuid,uuid[],integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.service_claim_league_onboarding(uuid,uuid[],integer) TO service_role;

CREATE OR REPLACE FUNCTION public.service_link_player_account(p_player_id uuid,p_user_id uuid,p_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p public.players%ROWTYPE; clean text:=lower(trim(p_email));
BEGIN
  SELECT * INTO p FROM public.players WHERE id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.location_id::text||clean,19));
  IF lower(trim(p.email)) IS DISTINCT FROM clean THEN RAISE EXCEPTION 'The roster email changed; review the player before creating access'; END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id AND lower(email)=clean) THEN RAISE EXCEPTION 'The app account does not match the roster email'; END IF;
  IF p.user_id IS NOT NULL AND p.user_id<>p_user_id THEN RAISE EXCEPTION 'This golfer is already linked to a different app account'; END IF;
  IF EXISTS(SELECT 1 FROM public.players WHERE location_id=p.location_id AND id<>p.id AND (lower(trim(email))=clean OR user_id=p_user_id)) THEN
    RAISE EXCEPTION 'Different golfers share this email or login. Give each golfer a separate email first';
  END IF;
  UPDATE public.players SET user_id=p_user_id WHERE id=p.id;
END; $$;
REVOKE ALL ON FUNCTION public.service_link_player_account(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.service_link_player_account(uuid,uuid,text) TO service_role;
COMMIT;
