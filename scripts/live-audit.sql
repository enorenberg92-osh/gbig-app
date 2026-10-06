-- Read-only launch audit. No personal contact fields or mutation.
SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable)) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('scores','events','players','teams','courses','league_config','team_memberships','handicap_history')),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'definition',pg_get_constraintdef(c.oid))) FROM pg_constraint c WHERE c.connamespace='public'::regnamespace),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('submit_scores','publish_week','admin_review_score','admin_upsert_score','admin_delete_score','recalculate_player_handicap','compute_event_results','is_admin_of_location','require_location_admin')),
 'policies',(SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename IN ('events','scores','players','teams','team_memberships')),
 'leagues',(SELECT jsonb_agg(jsonb_build_object('id',id,'location_id',location_id,'name',name,'num_weeks',num_weeks,'is_working',is_working)) FROM public.league_config),
 'events',(SELECT jsonb_agg(jsonb_build_object('id',id,'league_id',league_id,'status',status,'week',week_number,'format',format,'course_id',course_id)) FROM public.events),
 'counts',jsonb_build_object('players',(SELECT count(*) FROM players),'teams',(SELECT count(*) FROM teams),'scores',(SELECT count(*) FROM scores),'pending',(SELECT count(*) FROM scores WHERE status='pending')),
 'mismatched_gross',(SELECT count(*) FROM scores WHERE entry_type='played' AND gross_total IS DISTINCT FROM (SELECT sum(x) FROM unnest(hole_scores) x)),
 'mismatched_net',(SELECT count(*) FROM scores WHERE entry_type='played' AND net_total IS DISTINCT FROM gross_total-handicap_used)
) AS audit;
