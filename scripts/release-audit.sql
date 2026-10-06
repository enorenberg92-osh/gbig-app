-- Read-only release backup and integrity snapshot; no personal fields returned.
SELECT jsonb_build_object(
  'functions', (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('jsonb_int_array_valid','admin_review_score','admin_upsert_score','recalculate_player_handicap','publish_week','admin_delete_score')),
  'scores', (SELECT jsonb_build_object('count',count(*),'digest',md5(string_agg(to_jsonb(s)::text,'' ORDER BY id))) FROM public.scores s),
  'players', (SELECT jsonb_build_object('count',count(*),'digest',md5(string_agg(to_jsonb(p)::text,'' ORDER BY id))) FROM public.players p),
  'events', (SELECT jsonb_build_object('count',count(*),'digest',md5(string_agg(to_jsonb(e)::text,'' ORDER BY id))) FROM public.events e),
  'migrations', (SELECT jsonb_agg(to_jsonb(m)) FROM supabase_migrations.schema_migrations m),
  'history_columns', (SELECT jsonb_agg(jsonb_build_object('name',column_name,'type',data_type)) FROM information_schema.columns WHERE table_schema='supabase_migrations' AND table_name='schema_migrations'),
  'mismatched_gross', (SELECT count(*) FROM public.scores WHERE entry_type='played' AND gross_total IS DISTINCT FROM (SELECT sum(x) FROM unnest(hole_scores) x)),
  'mismatched_net', (SELECT count(*) FROM public.scores WHERE entry_type='played' AND net_total IS DISTINCT FROM gross_total-handicap_used)
) AS release_audit;
