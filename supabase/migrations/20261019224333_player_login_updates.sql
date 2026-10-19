-- Auth mutations happen only through auth.admin.updateUserById in the Edge Function.
-- These service-only functions authorize, serialize, audit and finalize roster changes.
BEGIN;

CREATE TABLE public.player_login_updates (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  player_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  user_id uuid NOT NULL,
  roster_email text,
  old_auth_email text NOT NULL,
  new_email text NOT NULL,
  status text NOT NULL CHECK (status IN ('applying','complete','failed','needs_review')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX player_login_updates_one_in_progress ON public.player_login_updates(user_id)
  WHERE status IN ('applying','needs_review');
ALTER TABLE public.player_login_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_login_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.player_login_updates TO service_role;
-- Conflict and finalization checks need only these Auth columns. The service
-- role still receives no SQL write privilege on Auth; mutations use its API.
GRANT SELECT (id, email, email_change) ON auth.users TO service_role;

CREATE FUNCTION public.service_player_login_context(p_actor_id uuid, p_player_id uuid, p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE p public.players%ROWTYPE; clean text := lower(trim(p_email));
BEGIN
  SELECT * INTO p FROM public.players WHERE id=p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.location_admins WHERE user_id=p_actor_id AND location_id=p.location_id)
    AND NOT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=p_actor_id) THEN
    RAISE EXCEPTION 'Not authorized for this venue' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object(
    'player', jsonb_build_object('id',p.id,'name',p.name,'email',p.email,'user_id',p.user_id,'location_id',p.location_id),
    'venue', (SELECT name FROM public.locations WHERE id=p.location_id),
    'shared_login', EXISTS(SELECT 1 FROM public.players WHERE user_id=p.user_id AND id<>p.id),
    'staff_login', EXISTS(SELECT 1 FROM public.location_admins WHERE user_id=p.user_id)
      OR EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=p.user_id),
    'email_conflict', clean IS NOT NULL AND EXISTS(
      SELECT 1 FROM auth.users WHERE id IS DISTINCT FROM p.user_id
        AND (lower(email)=clean OR lower(email_change)=clean)
    ),
    'roster_conflict', clean IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.players WHERE id<>p.id AND lower(trim(email))=clean
    ),
    'in_progress', EXISTS(SELECT 1 FROM public.player_login_updates WHERE user_id=p.user_id AND status IN ('applying','needs_review'))
  );
END; $$;

CREATE FUNCTION public.service_begin_player_login_update(
  p_request_id uuid, p_actor_id uuid, p_player_id uuid, p_user_id uuid,
  p_roster_email text, p_old_auth_email text, p_new_email text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE p public.players%ROWTYPE; prior public.player_login_updates%ROWTYPE; ctx jsonb;
BEGIN
  -- Idempotency is bound to the actor, player, account and exact proposed address.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,106));
  SELECT * INTO p FROM public.players WHERE id=p_player_id FOR UPDATE;
  ctx := public.service_player_login_context(p_actor_id,p_player_id,p_new_email);
  SELECT * INTO prior FROM public.player_login_updates WHERE id=p_request_id;
  IF FOUND THEN
    IF prior.actor_id<>p_actor_id OR prior.player_id<>p_player_id OR prior.user_id<>p_user_id
      OR prior.new_email<>p_new_email THEN RAISE EXCEPTION 'Request does not match this correction'; END IF;
    RETURN jsonb_build_object('status',prior.status);
  END IF;
  IF p.user_id IS DISTINCT FROM p_user_id OR p.email IS DISTINCT FROM p_roster_email THEN
    RAISE EXCEPTION 'Player changed. Review the correction again';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id AND email=p_old_auth_email) THEN
    RAISE EXCEPTION 'Login changed. Review the correction again';
  END IF;
  IF (ctx->>'shared_login')::boolean OR (ctx->>'staff_login')::boolean
    OR (ctx->>'email_conflict')::boolean OR (ctx->>'roster_conflict')::boolean
    OR (ctx->>'in_progress')::boolean THEN
    RAISE EXCEPTION 'Account conflict or correction already in progress. Review this account';
  END IF;
  IF p_new_email IS NULL OR p_new_email<>lower(trim(p_new_email)) OR length(p_new_email)>254
    OR p_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid email address';
  END IF;
  INSERT INTO public.player_login_updates(id,actor_id,player_id,location_id,user_id,roster_email,old_auth_email,new_email,status)
    VALUES(p_request_id,p_actor_id,p_player_id,p.location_id,p_user_id,p_roster_email,p_old_auth_email,p_new_email,'applying');
  INSERT INTO public.audit_events(actor_id,location_id,action,entity,entity_id,before_data,after_data)
    VALUES(p_actor_id,p.location_id,'player.login_email.started','players',p.id,
      public.redact_audit_payload(jsonb_build_object('email',p.email,'user_id',p.user_id)),
      jsonb_build_object('request_id',p_request_id,'status','applying','user_id',p_user_id));
  RETURN jsonb_build_object('status','started');
END; $$;

-- Other editors cannot change the link or email during an unfinished correction.
CREATE FUNCTION public.guard_player_login_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.player_login_updates WHERE player_id=OLD.id AND status IN ('applying','needs_review')) THEN
      RAISE EXCEPTION 'A login correction is unfinished. Review the account before deleting this player';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.user_id IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email AND NOT EXISTS(
    SELECT 1 FROM public.player_login_updates r WHERE r.player_id=OLD.id AND r.status='applying'
      AND r.id::text=current_setting('app.player_login_request',true)
  ) THEN
    RAISE EXCEPTION 'Use Manage Login to correct both the roster email and the existing login';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    IF EXISTS(SELECT 1 FROM public.player_login_updates r WHERE r.player_id=OLD.id
      AND r.status IN ('applying','needs_review')
      AND r.id::text IS DISTINCT FROM current_setting('app.player_login_request',true)) THEN
      RAISE EXCEPTION 'A login correction is unfinished. Review the account before editing its email or link';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_player_login_update() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_player_login_update BEFORE UPDATE OR DELETE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.guard_player_login_update();

CREATE FUNCTION public.service_finish_player_login_update(p_request_id uuid, p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r public.player_login_updates%ROWTYPE; p public.players%ROWTYPE; ctx jsonb;
BEGIN
  SELECT * INTO r FROM public.player_login_updates WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND OR r.actor_id<>p_actor_id THEN RAISE EXCEPTION 'Correction not found'; END IF;
  SELECT * INTO p FROM public.players WHERE id=r.player_id FOR UPDATE;
  ctx := public.service_player_login_context(p_actor_id,r.player_id,r.new_email);
  IF r.status='complete' THEN RETURN jsonb_build_object('status','complete'); END IF;
  IF r.status<>'applying' THEN RAISE EXCEPTION 'Correction needs review'; END IF;
  IF p.user_id IS DISTINCT FROM r.user_id OR p.location_id<>r.location_id
    OR p.email IS DISTINCT FROM r.roster_email
    OR (ctx->>'shared_login')::boolean OR (ctx->>'staff_login')::boolean
    OR (ctx->>'email_conflict')::boolean OR (ctx->>'roster_conflict')::boolean THEN
    RAISE EXCEPTION 'Player or account links changed. Review this account';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=r.user_id AND email=r.new_email) THEN
    RAISE EXCEPTION 'Auth email has not been verified after the update';
  END IF;
  PERFORM set_config('app.player_write','on',true);
  PERFORM set_config('app.player_login_request',r.id::text,true);
  UPDATE public.players SET email=r.new_email WHERE id=p.id;
  UPDATE public.player_login_updates SET status='complete',updated_at=now() WHERE id=r.id;
  INSERT INTO public.audit_events(actor_id,location_id,action,entity,entity_id,before_data,after_data)
    VALUES(p_actor_id,r.location_id,'player.login_email.completed','players',p.id,
      public.redact_audit_payload(jsonb_build_object('email',r.roster_email,'user_id',r.user_id)),
      public.redact_audit_payload(jsonb_build_object('email',r.new_email,'user_id',r.user_id,'request_id',r.id)));
  RETURN jsonb_build_object('status','complete');
END; $$;

CREATE FUNCTION public.service_fail_player_login_update(p_request_id uuid,p_actor_id uuid,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r public.player_login_updates%ROWTYPE; next_status text;
BEGIN
  SELECT * INTO r FROM public.player_login_updates WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND OR r.actor_id<>p_actor_id OR r.status<>'applying' THEN RETURN; END IF;
  next_status := CASE WHEN EXISTS(SELECT 1 FROM auth.users WHERE id=r.user_id AND email=r.old_auth_email)
    THEN 'failed' ELSE 'needs_review' END;
  UPDATE public.player_login_updates SET status=next_status,failure_code=left(p_failure_code,80),updated_at=now() WHERE id=r.id;
  INSERT INTO public.audit_events(actor_id,location_id,action,entity,entity_id,after_data)
    VALUES(p_actor_id,r.location_id,'player.login_email.'||next_status,'players',r.player_id,
      jsonb_build_object('request_id',r.id,'status',next_status,'failure_code',left(p_failure_code,80),'user_id',r.user_id));
END; $$;

REVOKE ALL ON FUNCTION public.service_player_login_context(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.service_begin_player_login_update(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.service_finish_player_login_update(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.service_fail_player_login_update(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.service_player_login_context(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_begin_player_login_update(uuid,uuid,uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_finish_player_login_update(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_fail_player_login_update(uuid,uuid,text) TO service_role;
COMMIT;
