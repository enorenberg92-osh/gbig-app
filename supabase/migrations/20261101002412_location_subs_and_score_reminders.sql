BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- Private targeting must not let another player read device keys or bind a
-- device to a different account. Capability-based subscribe_push remains the
-- sole client write path and always derives user_id from the current session.
DROP POLICY IF EXISTS "push_subscriptions: location members all" ON public.push_subscriptions;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.push_subscriptions TO authenticated;
CREATE POLICY push_subscriptions_account_read ON public.push_subscriptions FOR SELECT TO authenticated
USING ((user_id=(SELECT auth.uid()) AND public.is_in_location(location_id)) OR public.is_admin_of_location(location_id));

-- Account messages are separate from public, location-wide broadcast alerts.
CREATE TABLE public.account_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('sub_request', 'score_reminder')),
  title text NOT NULL,
  body text NOT NULL,
  url text NOT NULL,
  source_key text NOT NULL,
  event_id uuid REFERENCES public.events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(user_id, source_key)
);
CREATE INDEX account_notifications_inbox ON public.account_notifications(user_id, location_id, created_at DESC);
CREATE INDEX account_notifications_event ON public.account_notifications(event_id);
CREATE INDEX account_notifications_location ON public.account_notifications(location_id);
ALTER TABLE public.account_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_notifications_own ON public.account_notifications FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) AND public.is_in_location(location_id)
  AND (kind <> 'sub_request' OR public.is_admin_of_location(location_id)));
REVOKE ALL ON public.account_notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.account_notifications TO authenticated;

-- Delivery state (including device endpoints) is never exposed through the API.
CREATE TABLE private.notification_outbox (
  notification_id uuid PRIMARY KEY REFERENCES public.account_notifications(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','no_devices','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  delivered_endpoints text[] NOT NULL DEFAULT '{}',
  last_error text
);
ALTER TABLE private.notification_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX notification_outbox_due ON private.notification_outbox(next_attempt_at) WHERE state IN ('pending','processing');

CREATE TABLE public.score_reminder_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  league_id uuid NOT NULL REFERENCES public.league_config(id),
  timezone text NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  local_time time NOT NULL,
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_recipient_count integer NOT NULL DEFAULT 0,
  last_unlinked_count integer NOT NULL DEFAULT 0
);
CREATE INDEX score_reminder_schedules_location ON public.score_reminder_schedules(location_id, created_at DESC);
CREATE INDEX score_reminder_schedules_due ON public.score_reminder_schedules(next_run_at) WHERE enabled;
CREATE UNIQUE INDEX score_reminder_one_enabled ON public.score_reminder_schedules(league_id) WHERE enabled;
CREATE INDEX score_reminder_schedules_league ON public.score_reminder_schedules(league_id);
CREATE INDEX score_reminder_schedules_creator ON public.score_reminder_schedules(created_by);
ALTER TABLE public.score_reminder_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY score_reminder_schedules_admin ON public.score_reminder_schedules FOR SELECT TO authenticated
USING (public.is_admin_of_location(location_id));
REVOKE ALL ON public.score_reminder_schedules FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.score_reminder_schedules TO authenticated;

CREATE FUNCTION private.enqueue_account_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.notification_outbox(notification_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_notification_enqueue AFTER INSERT ON public.account_notifications
FOR EACH ROW EXECUTE FUNCTION private.enqueue_account_push();

CREATE FUNCTION private.validate_sub_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.events%ROWTYPE;
BEGIN
  -- The event lock serializes competing requests/assignments for a roster slot.
  SELECT * INTO e FROM public.events WHERE id=NEW.event_id FOR UPDATE;
  IF NOT FOUND OR NEW.location_id IS DISTINCT FROM e.location_id THEN RAISE EXCEPTION 'Invalid substitute location'; END IF;
  IF TG_OP='INSERT' AND (e.status <> 'open' OR COALESCE(e.is_bye,false)) THEN RAISE EXCEPTION 'Choose an open playing week'; END IF;
  IF NEW.status NOT IN ('pending','approved','denied') THEN RAISE EXCEPTION 'Invalid sub status'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_at WHERE event_id=e.id AND player_id=NEW.player_id AND location_id=e.location_id) THEN
    RAISE EXCEPTION 'Choose a player on this week''s team roster';
  END IF;
  IF NULLIF(trim(NEW.sub_first_name),'') IS NULL OR NULLIF(trim(NEW.sub_last_name),'') IS NULL
    OR NEW.sub_handicap IS NULL OR NEW.sub_handicap <> trunc(NEW.sub_handicap) OR NEW.sub_handicap NOT BETWEEN -2 AND 40 THEN
    RAISE EXCEPTION 'Enter the substitute''s first name, last name, and a whole-number handicap from -2 to 40';
  END IF;
  IF NEW.sub_player_id IS NOT NULL AND (NEW.sub_player_id=NEW.player_id OR NOT EXISTS (
    SELECT 1 FROM public.players WHERE id=NEW.sub_player_id AND location_id=e.location_id AND is_sub=true
  )) THEN RAISE EXCEPTION 'Choose a substitute profile from this location'; END IF;
  IF NEW.status IN ('pending','approved') AND EXISTS (
    SELECT 1 FROM public.subs s WHERE s.event_id=e.id AND s.player_id=NEW.player_id AND s.id<>NEW.id AND s.status IN ('pending','approved')
  ) THEN RAISE EXCEPTION 'This player already has a pending or approved substitute for this week'; END IF;
  IF NEW.status='approved' AND NEW.sub_player_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.subs s WHERE s.event_id=e.id AND s.sub_player_id=NEW.sub_player_id AND s.id<>NEW.id AND s.status='approved'
  ) THEN RAISE EXCEPTION 'This substitute is already assigned for this week'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_sub_assignment BEFORE INSERT OR UPDATE OF status, sub_player_id ON public.subs
FOR EACH ROW EXECUTE FUNCTION private.validate_sub_assignment();

CREATE FUNCTION private.notify_sub_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status='pending' THEN
    INSERT INTO public.account_notifications(location_id,user_id,kind,title,body,url,source_key,event_id)
    SELECT NEW.location_id,a.user_id,'sub_request','Sub requested',
      p.name || ' requested ' || NEW.sub_first_name || ' ' || NEW.sub_last_name || ' for ' || COALESCE(e.name,'Week '||e.week_number) || '. Review the request in Subs.',
      '/league/admin/subs','sub:'||NEW.id,e.id
    FROM public.location_admins a JOIN public.players p ON p.id=NEW.player_id JOIN public.events e ON e.id=NEW.event_id
    WHERE a.location_id=NEW.location_id
    ON CONFLICT (user_id,source_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notify_sub_request AFTER INSERT ON public.subs FOR EACH ROW EXECUTE FUNCTION private.notify_sub_request();

CREATE FUNCTION public.admin_add_sub(p_event_id uuid,p_player_id uuid,p_sub jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.events%ROWTYPE; s public.players%ROWTYPE; new_id uuid; h numeric;
BEGIN
  SELECT * INTO e FROM public.events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Week not found'; END IF;
  PERFORM public.require_location_admin(e.location_id);
  IF e.status<>'open' OR COALESCE(e.is_bye,false) THEN RAISE EXCEPTION 'Choose an open playing week'; END IF;
  IF EXISTS (SELECT 1 FROM public.scores WHERE event_id=e.id AND player_id=p_player_id AND entry_type='played' AND status<>'rejected') THEN
    RAISE EXCEPTION 'This player already has a score for this week';
  END IF;
  IF NULLIF(p_sub->>'sub_player_id','') IS NOT NULL THEN
    SELECT * INTO s FROM public.players WHERE id=(p_sub->>'sub_player_id')::uuid AND location_id=e.location_id AND is_sub=true;
    IF NOT FOUND THEN RAISE EXCEPTION 'Substitute profile not found at this location'; END IF;
    p_sub := jsonb_build_object('sub_player_id',s.id,'sub_first_name',s.first_name,'sub_last_name',s.last_name,'sub_email',s.email,'sub_phone',s.phone,'sub_handicap',s.handicap);
  END IF;
  h := NULLIF(p_sub->>'sub_handicap','')::numeric;
  INSERT INTO public.subs(event_id,player_id,sub_first_name,sub_last_name,sub_email,sub_phone,sub_handicap,sub_player_id,status,location_id)
  VALUES(e.id,p_player_id,trim(p_sub->>'sub_first_name'),trim(p_sub->>'sub_last_name'),NULLIF(trim(p_sub->>'sub_email'),''),NULLIF(trim(p_sub->>'sub_phone'),''),h,NULLIF(p_sub->>'sub_player_id','')::uuid,'approved',e.location_id)
  RETURNING id INTO new_id;
  PERFORM public.admin_set_sub_status(new_id,'approved');
  PERFORM public.write_audit_event(e.location_id,'sub.admin_add','subs',new_id,NULL,jsonb_build_object('event_id',e.id,'player_id',p_player_id));
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.mark_account_notification_read(p_id uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.account_notifications SET read_at=COALESCE(read_at,now()) WHERE id=p_id AND user_id=(SELECT auth.uid());
$$;
GRANT UPDATE(read_at) ON public.account_notifications TO authenticated;
CREATE POLICY account_notifications_mark_read ON public.account_notifications FOR UPDATE TO authenticated
USING (user_id=(SELECT auth.uid()) AND public.is_in_location(location_id))
WITH CHECK (user_id=(SELECT auth.uid()) AND public.is_in_location(location_id));

CREATE FUNCTION private.next_weekly_reminder(p_after timestamptz,p_timezone text,p_weekday integer,p_time time) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE local_day date; result timestamptz;
BEGIN
  local_day := (p_after AT TIME ZONE p_timezone)::date;
  local_day := local_day + ((p_weekday-extract(dow FROM local_day)::integer+7)%7);
  result := (local_day+p_time) AT TIME ZONE p_timezone;
  IF result<=p_after THEN result := (local_day+7+p_time) AT TIME ZONE p_timezone; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.admin_schedule_score_reminder(p_league_id uuid,p_config jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.league_config%ROWTYPE; tz text; d integer; t time; next_run timestamptz; new_id uuid;
BEGIN
  SELECT * INTO l FROM public.league_config WHERE id=p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(l.location_id);
  IF NOT COALESCE(l.is_working,false) THEN RAISE EXCEPTION 'Choose the working league'; END IF;
  tz := COALESCE(NULLIF(p_config->>'timezone',''),'America/Chicago');
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN RAISE EXCEPTION 'Choose a valid time zone'; END IF;
  d := (p_config->>'weekday')::integer; t := (p_config->>'local_time')::time;
  IF d IS NULL OR d NOT BETWEEN 0 AND 6 OR t IS NULL THEN RAISE EXCEPTION 'Choose a weekday and time'; END IF;
  next_run := private.next_weekly_reminder(now(),tz,d,t);
  -- Replacing the current schedule is atomic; retries cannot leave two active.
  PERFORM pg_advisory_xact_lock(hashtext('score-reminders:'||l.id));
  UPDATE public.score_reminder_schedules SET enabled=false WHERE league_id=l.id AND enabled;
  INSERT INTO public.score_reminder_schedules(location_id,league_id,timezone,weekday,local_time,next_run_at,created_by)
  VALUES(l.location_id,l.id,tz,d,t,next_run,auth.uid()) RETURNING id INTO new_id;
  PERFORM public.write_audit_event(l.location_id,'score_reminder.schedule','score_reminder_schedules',new_id,NULL,p_config);
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.admin_cancel_score_reminder(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.score_reminder_schedules%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.score_reminder_schedules WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder not found'; END IF;
  PERFORM public.require_location_admin(s.location_id);
  UPDATE public.score_reminder_schedules SET enabled=false WHERE id=p_id;
  PERFORM public.write_audit_event(s.location_id,'score_reminder.cancel','score_reminder_schedules',p_id,NULL,NULL);
END;
$$;

-- Only the worker can materialize due reminders. Recompute the audience here,
-- never from a client-supplied player list or a snapshot taken at schedule time.
CREATE FUNCTION public.service_process_score_reminders() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.score_reminder_schedules%ROWTYPE; event_key uuid; sent integer; unlinked integer; processed integer:=0;
BEGIN
  FOR s IN SELECT * FROM public.score_reminder_schedules WHERE enabled AND next_run_at<=now() ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    event_key := NULL; sent:=0; unlinked:=0;
    -- Revoked admins, archived leagues, closed weeks and byes never send.
    IF EXISTS(SELECT 1 FROM public.location_admins WHERE user_id=s.created_by AND location_id=s.location_id)
      AND EXISTS(SELECT 1 FROM public.league_config WHERE id=s.league_id AND is_working=true) THEN
      SELECT e.id INTO event_key FROM public.events e WHERE e.league_id=s.league_id AND e.location_id=s.location_id
        AND e.status='open' AND NOT COALESCE(e.is_bye,false)
        AND COALESCE(e.start_date,e.event_date,current_date)<=(now() AT TIME ZONE s.timezone)::date
        ORDER BY e.week_number LIMIT 1 FOR SHARE;
      IF event_key IS NOT NULL THEN
        INSERT INTO public.account_notifications(location_id,user_id,kind,title,body,url,source_key,event_id)
        SELECT DISTINCT s.location_id,p.user_id,'score_reminder','Please enter your score',
          'Your score for '||COALESCE(e.name,'Week '||e.week_number)||' is still missing. Please enter it in the app.',
          '/league/score-entry','score:'||s.id||':'||s.next_run_at||':'||event_key,event_key
        FROM public.roster_at r JOIN public.players p ON p.id=r.player_id JOIN public.events e ON e.id=r.event_id
        WHERE r.event_id=event_key AND r.location_id=s.location_id AND p.user_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM public.scores sc WHERE sc.event_id=r.event_id AND sc.player_id=r.player_id AND sc.entry_type='played' AND sc.status IN ('pending','verified'))
        ON CONFLICT(user_id,source_key) DO NOTHING;
        GET DIAGNOSTICS sent=ROW_COUNT;
        SELECT count(*) INTO unlinked FROM public.roster_at r JOIN public.players p ON p.id=r.player_id
        WHERE r.event_id=event_key AND p.user_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM public.scores sc WHERE sc.event_id=r.event_id AND sc.player_id=r.player_id AND sc.entry_type='played' AND sc.status IN ('pending','verified'));
      END IF;
    END IF;
    UPDATE public.score_reminder_schedules SET last_run_at=now(),last_recipient_count=sent,last_unlinked_count=unlinked,
      enabled=(EXISTS(SELECT 1 FROM public.location_admins WHERE user_id=s.created_by AND location_id=s.location_id)
        AND EXISTS(SELECT 1 FROM public.league_config WHERE id=s.league_id AND is_working=true)),
      next_run_at=private.next_weekly_reminder(now(),s.timezone,s.weekday,s.local_time)
    WHERE id=s.id;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END;
$$;

CREATE FUNCTION public.service_claim_account_pushes() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  -- A short-lived lease allows safe recovery after an interrupted worker.
  WITH due AS (
    SELECT notification_id FROM private.notification_outbox
    WHERE (state='pending' AND next_attempt_at<=now()) OR (state='processing' AND leased_until<now())
    ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE private.notification_outbox o SET state='processing',attempts=attempts+1,lease_token=gen_random_uuid(),leased_until=now()+interval '5 minutes'
    FROM due WHERE o.notification_id=due.notification_id RETURNING o.*
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(n)||jsonb_build_object('lease_token',c.lease_token,'attempts',c.attempts,'delivered_endpoints',c.delivered_endpoints)),'[]') INTO result
  FROM claimed c JOIN public.account_notifications n ON n.id=c.notification_id;
  RETURN result;
END;
$$;

CREATE FUNCTION public.service_finish_account_push(p_id uuid,p_lease uuid,p_state text,p_delivered text[],p_error text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_state NOT IN ('sent','no_devices','pending','skipped') THEN RAISE EXCEPTION 'Invalid delivery state'; END IF;
  UPDATE private.notification_outbox SET state=CASE WHEN p_state='pending' AND attempts>=5 THEN 'failed' ELSE p_state END,
    delivered_endpoints=p_delivered,last_error=left(p_error,300),lease_token=NULL,leased_until=NULL,
    next_attempt_at=now()+make_interval(mins=>least(60,power(2,attempts)::integer))
  WHERE notification_id=p_id AND lease_token=p_lease AND state='processing';
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_add_sub(uuid,uuid,jsonb),public.mark_account_notification_read(uuid),
  public.admin_schedule_score_reminder(uuid,jsonb),public.admin_cancel_score_reminder(uuid),
  public.service_process_score_reminders(),public.service_claim_account_pushes(),public.service_finish_account_push(uuid,uuid,text,text[],text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_sub(uuid,uuid,jsonb),public.mark_account_notification_read(uuid),
  public.admin_schedule_score_reminder(uuid,jsonb),public.admin_cancel_score_reminder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_process_score_reminders(),public.service_claim_account_pushes(),
  public.service_finish_account_push(uuid,uuid,text,text[],text) TO service_role;
GRANT SELECT ON public.account_notifications TO service_role;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.account_notifications;
  END IF;
END $$;

COMMIT;
