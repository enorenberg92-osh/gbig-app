import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
let db
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12,'0')
const q = n => `'${id(n)}'`
const migration = name => readFileSync(new URL('../../supabase/migrations/'+name, import.meta.url),'utf8')
const fn = (file,name) => migration(file).match(new RegExp('CREATE OR REPLACE FUNCTION public\\.'+name+'\\([\\s\\S]*?\\$\\$;'))[0]
async function as(role, actor, sql, params=[]) {
  await db.exec('savepoint call; set local role '+role)
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor == null ? '' : id(actor)])
  try { return (await db.query(sql, params)).rows }
  catch(e) { await db.exec('rollback to savepoint call'); throw e }
  finally { await db.exec('release savepoint call; reset role') }
}
const sub = (extra={}) => ({ sub_first_name:'Sam',sub_last_name:'Sub',sub_email:'sam@example.invalid',sub_phone:'555-0100',sub_handicap:8,...extra })
const request = (extra={}, actor=101) => as('authenticated',actor,'select request_sub($1,$2) as id',[id(41),sub(extra)])
const add = (player=11, extra={}, actor=1) => as('authenticated',actor,'select admin_add_sub($1,$2,$3) as id',[id(41),id(player),sub(extra)])
const schedule = (actor=1, config={}) => as('authenticated',actor,'select admin_schedule_score_reminder($1,$2) as id',[id(3),{weekday:0,local_time:'18:00',timezone:'America/Chicago',...config}])
const process = () => as('service_role',null,'select service_process_score_reminders()')
const all = table => db.query('select * from '+table).then(r=>r.rows)
beforeAll(async()=>{
  db=new PGlite()
  await db.exec(readFileSync(new URL('../../scripts/database-fixture.sql',import.meta.url),'utf8'))
  await db.exec(`create role anon; create role service_role bypassrls; create table auth.users(id uuid primary key);
    alter table players alter column id set default gen_random_uuid();
    alter table players add first_name text, add last_name text, add email text, add phone text, add is_sub boolean default false;
    create table subs(id uuid primary key default gen_random_uuid(),location_id uuid,event_id uuid,player_id uuid,sub_first_name text,sub_last_name text,sub_email text,sub_phone text,sub_handicap numeric,sub_player_id uuid,status text,created_at timestamptz default now());
    create table push_subscriptions(id uuid primary key default gen_random_uuid(),location_id uuid,user_id uuid,endpoint text);
    alter table push_subscriptions enable row level security;
    grant usage on schema public,auth to authenticated,anon,service_role;
    create function public.is_in_location(venue uuid) returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.location_admins where user_id=auth.uid() and location_id=venue) or exists(select 1 from public.players where user_id=auth.uid() and location_id=venue)
    $$;`)
  await db.exec(fn('enable_rls_phase1.sql','is_admin_of_location'))
  await db.exec(migration('202607100003_phase1_league_rosters.sql').match(/CREATE OR REPLACE VIEW public\.roster_at[\s\S]*?;/)[0])
  for(const name of ['redact_audit_payload','write_audit_event']) await db.exec(fn('202607100001_phase1_audit_foundation.sql',name))
  for(const name of ['require_location_admin','request_sub','admin_set_sub_status']) await db.exec(fn('202607100004_phase1_mutation_rpcs.sql',name))
  await db.exec('revoke all on function request_sub(uuid,jsonb),admin_set_sub_status(uuid,text) from public; grant execute on function request_sub(uuid,jsonb),admin_set_sub_status(uuid,text) to authenticated;')
  await db.exec(migration('20261101002412_location_subs_and_score_reminders.sql'))
  await db.exec(`insert into locations values(${q(1)}),(${q(2)});
    insert into auth.users values(${q(1)}),(${q(2)}),(${q(3)}),(${q(101)}),(${q(102)}),(${q(103)});
    insert into location_admins values(${q(1)},${q(1)}),(${q(2)},${q(2)}),(${q(3)},${q(1)});
    insert into league_config(id,location_id,name,is_working) values(${q(3)},${q(1)},'Fall',true),(${q(4)},${q(2)},'Other',true);
    insert into teams(id,location_id,league_id,name) values(${q(21)},${q(1)},${q(3)},'Team One');
    insert into players(id,user_id,location_id,name,first_name,last_name,handicap,is_sub) values
      (${q(11)},${q(101)},${q(1)},'Alex Player','Alex','Player',2,false),
      (${q(12)},${q(102)},${q(1)},'Blair Player','Blair','Player',4,false),
      (${q(13)},null,${q(1)},'No Login','No','Login',5,false),
      (${q(14)},${q(103)},${q(2)},'Other Sub','Other','Sub',6,true),
      (${q(15)},null,${q(1)},'Known Sub','Known','Sub',9,true);
    insert into team_memberships(team_id,player_id,location_id,league_id,effective_from) values
      (${q(21)},${q(11)},${q(1)},${q(3)},'2026-01-01'),(${q(21)},${q(12)},${q(1)},${q(3)},'2026-01-01'),(${q(21)},${q(13)},${q(1)},${q(3)},'2026-01-01');
    insert into events(id,location_id,league_id,name,status,start_date,week_number) values(${q(41)},${q(1)},${q(3)},'Week 2','open',current_date-1,2);`)
},30000)
beforeEach(async()=>{await db.exec('begin')})
afterEach(async()=>{await db.exec('rollback')})
afterAll(async()=>{await db?.close()})
it('enqueues one private message for each admin of the requesting location',async()=>{
  await request()
  expect((await all('account_notifications')).map(n=>n.user_id).sort()).toEqual([id(1),id(3)])
  expect(await all('private.notification_outbox')).toHaveLength(2)
  expect((await as('authenticated',1,'select * from account_notifications'))).toHaveLength(1)
  expect((await as('authenticated',2,'select * from account_notifications'))).toHaveLength(0)
  expect((await as('authenticated',101,'select * from account_notifications'))).toHaveLength(0)
})
it('keeps account data private and allows only read state to change',async()=>{
  await request(); const n=(await all('account_notifications'))[0]
  await expect(as('anon',null,'select * from account_notifications')).rejects.toThrow('permission denied')
  await expect(as('authenticated',1,"update account_notifications set title='spoof' where id=$1",[n.id])).rejects.toThrow('permission denied')
  await as('authenticated',n.user_id===id(1)?1:3,'select mark_account_notification_read($1)',[n.id])
  expect((await all('account_notifications')).find(x=>x.id===n.id).read_at).not.toBeNull()
  await expect(as('authenticated',1,'select * from private.notification_outbox')).rejects.toThrow('permission denied')
})
it('does not expose or allow a player to reassign another account device',async()=>{
  await db.exec(`insert into push_subscriptions(location_id,user_id,endpoint) values(${q(1)},${q(101)},'own'),(${q(1)},${q(102)},'private-other'),(${q(2)},${q(103)},'other-venue')`)
  expect((await as('authenticated',101,'select endpoint from push_subscriptions')).map(s=>s.endpoint)).toEqual(['own'])
  expect((await as('authenticated',1,'select endpoint from push_subscriptions')).map(s=>s.endpoint).sort()).toEqual(['own','private-other'])
  await expect(as('authenticated',101,'update push_subscriptions set user_id=$1',[id(1)])).rejects.toThrow('permission denied')
})
it('adds a new substitute atomically and creates its approved profile',async()=>{
  const [{id:key}]=await add()
  const assignment=(await all('subs')).find(s=>s.id===key)
  expect(assignment.status).toBe('approved')
  expect((await all('players')).find(p=>p.id===assignment.sub_player_id)).toMatchObject({is_sub:true,location_id:id(1),handicap:'8'})
  expect(await all('account_notifications')).toHaveLength(0)
  await expect(add()).rejects.toThrow('already has')
})
it('uses a known sub profile and rejects cross-location, self and non-roster assignments',async()=>{
  await expect(add(11,{},2)).rejects.toThrow('Admin access required')
  await expect(add(11,{},101)).rejects.toThrow('Admin access required')
  await expect(add(11,{sub_player_id:id(14)})).rejects.toThrow('not found')
  await expect(add(14)).rejects.toThrow('team roster')
  await expect(add(11,{sub_player_id:id(11)})).rejects.toThrow('not found')
  await add(11,{sub_player_id:id(15),sub_handicap:40,sub_first_name:'Spoof'})
  expect((await all('subs'))[0]).toMatchObject({sub_player_id:id(15),sub_first_name:'Known',sub_handicap:'9'})
  await expect(add(12,{sub_player_id:id(15)})).rejects.toThrow('already assigned')
})
it('rejects a duplicate player request, invalid handicap, and closed week',async()=>{
  await expect(add(11,{sub_handicap:4.5})).rejects.toThrow('whole-number')
  expect(await all('subs')).toHaveLength(0)
  await request()
  await expect(request()).rejects.toThrow('already has')
  await db.exec("update events set status='closed'")
  await expect(add(12)).rejects.toThrow('open playing week')
})
it('replaces the weekly schedule without duplicate enabled schedules and enforces location admins',async()=>{
  await expect(schedule(2)).rejects.toThrow('Admin access required')
  await expect(schedule(101)).rejects.toThrow('Admin access required')
  await expect(schedule(1,{timezone:'invalid'})).rejects.toThrow('time zone')
  await schedule(); await schedule(1,{weekday:2})
  expect((await all('score_reminder_schedules')).filter(s=>s.enabled)).toHaveLength(1)
  const [{id:key}]=(await all('score_reminder_schedules')).filter(s=>s.enabled)
  await expect(as('authenticated',2,'select admin_cancel_score_reminder($1)',[key])).rejects.toThrow('Admin access required')
  await as('authenticated',1,'select admin_cancel_score_reminder($1)',[key])
  expect((await all('score_reminder_schedules')).filter(s=>s.enabled)).toHaveLength(0)
})
it('calculates local weekly times across DST instead of adding 168 hours',async()=>{
  const [{next}]=await db.query("select private.next_weekly_reminder('2026-10-31T12:00Z','America/Chicago',0,'18:00') as next").then(r=>r.rows)
  expect(next.toISOString()).toBe('2026-11-02T00:00:00.000Z')
})
async function due(){await schedule(); await db.exec("update score_reminder_schedules set next_run_at=now()-interval '1 minute'")}
it('rechecks scores at send time, counts unlinked players, and advances to the next week only once',async()=>{
  await due()
  await db.exec(`insert into scores(event_id,player_id,location_id,entry_type,status,sub_played) values(${q(41)},${q(11)},${q(1)},'played','pending',true)`)
  await process(); await process()
  expect((await all('account_notifications')).map(n=>n.user_id)).toEqual([id(102)])
  expect((await all('score_reminder_schedules'))[0]).toMatchObject({enabled:true,last_recipient_count:1,last_unlinked_count:1})
  expect(new Date((await all('score_reminder_schedules'))[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
})
it('does not count rejected scores or penalties as entered golf',async()=>{
  await due(); await db.exec(`insert into scores(event_id,player_id,entry_type,status) values(${q(41)},${q(11)},'played','rejected'),(${q(41)},${q(12)},'penalty','verified')`)
  await process(); expect(await all('account_notifications')).toHaveLength(2)
})
it.each(['closed','bye','future','archived','revoked'])('skips %s weeks or schedules',async scenario=>{
  await due()
  if(scenario==='closed') await db.exec("update events set status='closed'")
  if(scenario==='bye') await db.exec('update events set is_bye=true')
  if(scenario==='future') await db.exec('update events set start_date=current_date+10')
  if(scenario==='archived') await db.exec('update league_config set is_working=false')
  if(scenario==='revoked') await db.exec('delete from location_admins where user_id='+q(1))
  await process(); expect(await all('account_notifications')).toHaveLength(0)
})
it('worker RPCs are unavailable to clients, use leases, and reject stale completion',async()=>{
  await expect(as('authenticated',1,'select service_process_score_reminders()')).rejects.toThrow('permission denied')
  await expect(as('anon',null,'select service_claim_account_pushes()')).rejects.toThrow('permission denied')
  await request()
  const [{items}]=await as('service_role',null,'select service_claim_account_pushes() as items')
  expect(items).toHaveLength(2)
  expect((await as('service_role',null,'select service_claim_account_pushes() as items'))[0].items).toEqual([])
  await as('service_role',null,'select service_finish_account_push($1,$2,$3,$4)',[items[0].id,id(999),'sent',[]])
  expect((await all('private.notification_outbox')).every(o=>o.state==='processing')).toBe(true)
  await as('service_role',null,'select service_finish_account_push($1,$2,$3,$4)',[items[0].id,items[0].lease_token,'sent',[]])
  expect((await all('private.notification_outbox')).filter(o=>o.state==='sent')).toHaveLength(1)
})
