BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- These two Vault secrets are provisioned at deployment, never committed:
-- notification_worker_url and notification_worker_secret.
CREATE FUNCTION private.invoke_account_notification_worker() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE endpoint text; secret text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.notification_outbox WHERE
    (state='pending' AND next_attempt_at<=now()) OR (state='processing' AND leased_until<now())) THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name='notification_worker_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name='notification_worker_secret';
  IF endpoint IS NULL OR secret IS NULL THEN RETURN NULL; END IF;
  RETURN net.http_post(url=>endpoint,body=>'{}'::jsonb,
    headers=>jsonb_build_object('Content-Type','application/json','x-notification-secret',secret),timeout_milliseconds=>10000);
END;
$$;
CREATE FUNCTION private.wake_account_notification_worker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.invoke_account_notification_worker();
  RETURN NULL;
END;
$$;
CREATE TRIGGER wake_account_notification_worker AFTER INSERT ON public.account_notifications
FOR EACH STATEMENT EXECUTE FUNCTION private.wake_account_notification_worker();
REVOKE ALL ON FUNCTION private.invoke_account_notification_worker(),private.wake_account_notification_worker() FROM PUBLIC,anon,authenticated;
SELECT cron.schedule('gbig-account-notifications','* * * * *',
  'SELECT public.service_process_score_reminders(); SELECT private.invoke_account_notification_worker();');
COMMIT;
