-- Phase 2 items 15-17: default-on feature flags and audited super-admin mutations.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.league_config
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE POLICY "players: super admins read" ON public.players
  FOR SELECT TO authenticated USING (public.is_super_admin());
CREATE POLICY "location_admins: super admins read" ON public.location_admins
  FOR SELECT TO authenticated USING (public.is_super_admin());

CREATE OR REPLACE FUNCTION public.check_feature_enabled(
  p_location_id UUID,
  p_league_id UUID,
  p_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE WHEN lc.features ? p_key THEN (lc.features->>p_key)::boolean END,
    CASE WHEN l.features ? p_key THEN (l.features->>p_key)::boolean END,
    true
  )
  FROM public.locations l
  LEFT JOIN public.league_config lc ON lc.id = p_league_id AND lc.location_id = l.id
  WHERE l.id = p_location_id;
$$;

REVOKE ALL ON FUNCTION public.check_feature_enabled(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_feature_enabled(UUID, UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.require_feature_enabled(
  p_location_id UUID,
  p_league_id UUID,
  p_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.check_feature_enabled(p_location_id, p_league_id, p_key), false) THEN
    RAISE EXCEPTION 'Feature % is disabled', p_key USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.require_feature_enabled(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.super_admin_create_location(
  p_name TEXT,
  p_slug TEXT,
  p_primary_color TEXT,
  p_timezone TEXT
)
RETURNS public.locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE created public.locations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super-admin access required' USING ERRCODE = '42501';
  END IF;
  IF trim(p_name) = '' OR trim(p_slug) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Name and a lowercase URL-safe slug are required';
  END IF;
  INSERT INTO public.locations (name, slug, app_name, primary_color, timezone, features)
  VALUES (trim(p_name), lower(trim(p_slug)), trim(p_name), COALESCE(NULLIF(trim(p_primary_color), ''), '#10B981'), COALESCE(NULLIF(trim(p_timezone), ''), 'America/Chicago'), '{}'::jsonb)
  RETURNING * INTO created;
  PERFORM public.write_audit_event(created.id, 'location.create', 'locations', created.id, NULL, to_jsonb(created));
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.super_admin_invite_location_admin(p_location_id UUID, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE target_user UUID; created_id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super-admin access required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.locations WHERE id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;
  SELECT id INTO target_user FROM auth.users WHERE lower(email) = lower(trim(p_email)) ORDER BY created_at LIMIT 1;
  IF target_user IS NULL THEN
    RAISE EXCEPTION 'No auth user exists for %. Ask them to create/sign in to an account first, then retry.', trim(p_email) USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.location_admins (user_id, location_id, role)
  VALUES (target_user, p_location_id, 'admin')
  ON CONFLICT (user_id, location_id) DO UPDATE SET role = 'admin'
  RETURNING id INTO created_id;
  PERFORM public.write_audit_event(p_location_id, 'location_admin.invite', 'location_admins', created_id, NULL, jsonb_build_object('user_id', target_user, 'role', 'admin'));
  RETURN jsonb_build_object('id', created_id, 'user_id', target_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.super_admin_update_location(p_location_id UUID, p_payload JSONB)
RETURNS public.locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE before_row public.locations%ROWTYPE; after_row public.locations%ROWTYPE; next_features JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super-admin access required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO before_row FROM public.locations WHERE id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;
  next_features := COALESCE(p_payload->'features', before_row.features);
  IF jsonb_typeof(next_features) <> 'object' THEN RAISE EXCEPTION 'features must be a JSON object'; END IF;
  UPDATE public.locations SET
    name = COALESCE(NULLIF(trim(p_payload->>'name'), ''), name),
    app_name = COALESCE(NULLIF(trim(p_payload->>'name'), ''), app_name),
    primary_color = COALESCE(NULLIF(trim(p_payload->>'primary_color'), ''), primary_color),
    logo_url = CASE WHEN p_payload ? 'logo_url' THEN NULLIF(trim(p_payload->>'logo_url'), '') ELSE logo_url END,
    logo_icon_url = CASE WHEN p_payload ? 'logo_icon_url' THEN NULLIF(trim(p_payload->>'logo_icon_url'), '') ELSE logo_icon_url END,
    timezone = COALESCE(NULLIF(trim(p_payload->>'timezone'), ''), timezone),
    features = next_features
  WHERE id = p_location_id RETURNING * INTO after_row;
  PERFORM public.write_audit_event(p_location_id, 'location.update', 'locations', p_location_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_league_feature_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.features IS DISTINCT FROM OLD.features THEN
    PERFORM public.write_audit_event(NEW.location_id, 'league.features.update', 'league_config', NEW.id, jsonb_build_object('features', OLD.features), jsonb_build_object('features', NEW.features));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS league_feature_audit ON public.league_config;
CREATE TRIGGER league_feature_audit AFTER UPDATE OF features ON public.league_config
FOR EACH ROW EXECUTE FUNCTION public.audit_league_feature_change();

-- Existing sub mutations are RPC-only. Enforce the effective league/location flag there.
CREATE OR REPLACE FUNCTION public.enforce_sub_feature()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE event_league UUID;
BEGIN
  SELECT league_id INTO event_league FROM public.events WHERE id = NEW.event_id;
  PERFORM public.require_feature_enabled(NEW.location_id, event_league, 'subs');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS subs_feature_guard ON public.subs;
CREATE TRIGGER subs_feature_guard BEFORE INSERT OR UPDATE ON public.subs
FOR EACH ROW EXECUTE FUNCTION public.enforce_sub_feature();

CREATE OR REPLACE FUNCTION public.enforce_social_feature()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_player UUID; actor_location UUID;
BEGIN
  IF TG_TABLE_NAME = 'follows' THEN
    actor_player := CASE WHEN TG_OP = 'DELETE' THEN OLD.follower_id ELSE NEW.follower_id END;
  ELSE
    actor_player := NEW.sender_id;
  END IF;
  SELECT location_id INTO actor_location FROM public.players WHERE id = actor_player;
  PERFORM public.require_feature_enabled(actor_location, NULL, 'friends');
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS follows_feature_guard ON public.follows;
CREATE TRIGGER follows_feature_guard BEFORE INSERT OR DELETE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.enforce_social_feature();
DROP TRIGGER IF EXISTS messages_feature_guard ON public.messages;
CREATE TRIGGER messages_feature_guard BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.enforce_social_feature();

CREATE OR REPLACE FUNCTION public.enforce_events_feature()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE row_location UUID;
BEGIN
  row_location := CASE WHEN TG_OP = 'DELETE' THEN OLD.location_id ELSE NEW.location_id END;
  PERFORM public.require_feature_enabled(row_location, NULL, 'events');
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS event_signups_feature_guard ON public.event_signups;
CREATE TRIGGER event_signups_feature_guard BEFORE INSERT OR DELETE ON public.event_signups FOR EACH ROW EXECUTE FUNCTION public.enforce_events_feature();

DO $$
DECLARE signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.super_admin_create_location(text,text,text,text)',
    'public.super_admin_invite_location_admin(uuid,text)',
    'public.super_admin_update_location(uuid,jsonb)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || signature || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || signature || ' TO authenticated';
  END LOOP;
END $$;
