import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { readFileSync } from 'node:fs'

let db
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const q = n => "'" + id(n) + "'"
const migration = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const fix = migration('20261023215020_clean_team_reassignment.sql')
const fn = (file, name) => migration(file).match(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\$\\$;'))[0]
async function call(sql, params, actor = 1, role = 'authenticated') {
  await db.exec('set role ' + role)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor ? id(actor) : ''])
  try { return await db.query(sql, params) }
  finally { await db.exec('reset role') }
}
const save = async (team, players, league = 10, actor = 1) =>
  (await call('select admin_save_team($1,$2,$3,$4) as id', [team, id(league), 'Team', JSON.stringify(players.map(id))], actor)).rows[0].id
const label = async player => (await db.query('select team_id from players where id=$1', [id(player)])).rows[0].team_id
const memberships = async () => (await db.query('select * from team_memberships order by team_id,player_id,effective_from')).rows

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create extension btree_gist;
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create table locations(id uuid primary key);
    create table league_config(id uuid primary key,location_id uuid references locations,start_date date);
    create table teams(id uuid primary key default gen_random_uuid(),location_id uuid references locations,
      league_id uuid references league_config,name text,player1_id uuid,player2_id uuid);
    create table players(id uuid primary key,location_id uuid references locations,team_id uuid references teams);
    create table team_memberships(id uuid primary key default gen_random_uuid(),location_id uuid references locations,
      league_id uuid references league_config,player_id uuid references players,team_id uuid references teams on delete cascade,
      effective_from date not null,effective_to date,check(effective_to is null or effective_to>=effective_from),
      exclude using gist(player_id with =,league_id with =,
        daterange(effective_from,coalesce(effective_to+1,'infinity'::date),'[)') with &&) deferrable initially deferred);
    create unique index one_active on team_memberships(player_id,league_id) where effective_to is null;
    create table scores(id uuid primary key,player_id uuid,team_id uuid,gross_total integer);
    create table location_admins(user_id uuid,location_id uuid);
    create table audit_events(location_id uuid,action text,entity text,entity_id uuid,before_data jsonb,after_data jsonb);
    create function is_admin_of_location(venue uuid) returns boolean language sql stable security definer set search_path=public as $$
      select exists(select 1 from location_admins where user_id=auth.uid() and location_id=venue)
    $$;
    create function write_audit_event(venue uuid,act text,entity_value text,entity_key uuid,before_value jsonb,after_value jsonb)
      returns void language sql as $$ insert into audit_events values(venue,act,entity_value,entity_key,before_value,after_value) $$;
    grant usage on schema public,auth to anon,authenticated;
  `)
  const base = '202607100004_phase1_mutation_rpcs.sql'
  for (const name of ['require_location_admin', 'admin_delete_team']) await db.exec(fn(base, name))
  const rosters = '202607100003_phase1_league_rosters.sql'
  for (const name of ['enforce_team_size_two', 'guard_legacy_roster_columns']) await db.exec(fn(rosters, name))
  await db.exec(`
    create constraint trigger team_size after insert or update or delete on team_memberships
      deferrable initially deferred for each row execute function enforce_team_size_two();
    create trigger guard_teams before insert or update on teams for each row execute function guard_legacy_roster_columns();
    create trigger guard_players before update on players for each row execute function guard_legacy_roster_columns();
  `)
  await db.exec(migration('202607180010_phase5_roster_swap.sql'))
  await db.exec(fix)
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec(`reset role; truncate team_memberships,players,teams,scores,league_config,locations,location_admins,audit_events cascade;
    insert into locations values(${q(50)}),(${q(51)});
    insert into league_config values(${q(10)},${q(50)},'2026-10-01'),(${q(11)},${q(50)},'2027-01-01'),(${q(20)},${q(51)},'2026-10-01');
    insert into location_admins values(${q(1)},${q(50)}),(${q(3)},${q(51)});
    insert into players(id,location_id) values${[100,101,102,103,104,105].map(n => `(${q(n)},${q(50)})`).join(',')},(${q(200)},${q(51)});
  `)
})

it('releases a replaced player and immediately assigns them to another team', async () => {
  const first = await save(null, [100,101])
  await db.query('insert into scores values($1,$2,$3,36)', [id(500),id(100),first])
  const scoreBefore = (await db.query('select * from scores')).rows
  const unchangedPartner = (await memberships()).find(row => row.player_id === id(101))
  await save(first, [102,101])
  expect(await label(100)).toBeNull()
  expect((await memberships()).some(row => row.player_id === id(100))).toBe(false)
  expect((await memberships()).find(row => row.player_id === id(101))).toEqual(unchangedPartner)
  const second = await save(null, [100,103])
  expect(await label(100)).toBe(second)
  expect((await db.query('select * from scores')).rows).toEqual(scoreBefore)
})

it('preserves dated history when a swapped-out player joins another team and a team is renamed', async () => {
  const first = await save(null, [100,101])
  await call('select admin_swap_team_member($1,$2,$3,$4)', [first,id(100),id(102),'2026-10-15'])
  const historyBefore = await memberships()
  await save(first, [102,101])
  expect(await memberships()).toEqual(historyBefore)
  const second = await save(null, [100,103])
  const playerHistory = (await memberships()).filter(row => row.player_id === id(100))
  expect(playerHistory).toHaveLength(2)
  expect(playerHistory.find(row => row.team_id === first).effective_to.toISOString()).toMatch(/^2026-10-14/)
  expect(playerHistory.find(row => row.team_id === second).effective_from.toISOString()).toMatch(/^2026-10-15/)
})

it('keeps assigned players protected and failed edits atomic', async () => {
  const first = await save(null, [100,101])
  const second = await save(null, [102,103])
  const before = await memberships()
  await expect(save(second, [100,103])).rejects.toThrow('already on another team')
  expect(await memberships()).toEqual(before)
  expect(await label(100)).toBe(first)
})

it('allows assignment in another season without treating the old season as a conflict', async () => {
  const old = await save(null, [100,101])
  const next = await save(null, [100,101],11)
  expect(old).not.toBe(next)
  expect((await memberships()).filter(row => row.player_id === id(100))).toHaveLength(2)
})

it('releases both players after deleting a team', async () => {
  const team = await save(null, [100,101])
  await call('select admin_delete_team($1)', [team])
  expect(await label(100)).toBeNull()
  expect(await label(101)).toBeNull()
  expect(await memberships()).toHaveLength(0)
  expect(await save(null, [100,101])).toBeTruthy()
})

it('repairs abandoned labels once, preserving valid assignments and scores', async () => {
  const team = await save(null, [100,101])
  await db.exec("begin; select set_config('app.roster_write','on',true); update players set team_id=" + "'" + team + "' where id=" + q(102) + '; commit;')
  await db.query('insert into scores values($1,$2,$3,36)', [id(500),id(102),team])
  const before = await memberships()
  const scores = (await db.query('select * from scores')).rows
  await db.exec(fix)
  await db.exec(fix)
  expect(await label(102)).toBeNull()
  expect(await label(100)).toBe(team)
  expect(await memberships()).toEqual(before)
  expect((await db.query('select * from scores')).rows).toEqual(scores)
  expect((await db.query("select * from audit_events where action='roster.stale_team_label_clear'")).rows).toHaveLength(1)
})

it('rejects non-admins, other-venue players, malformed rosters and anonymous calls', async () => {
  await expect(save(null,[100,101],10,2)).rejects.toThrow('Admin access required')
  await expect(save(null,[100,101],10,3)).rejects.toThrow('Admin access required')
  await expect(save(null,[100,200])).rejects.toThrow('Both players must belong')
  await expect(save(null,[100,100])).rejects.toThrow('different')
  await expect(save(null,[100])).rejects.toThrow('exactly two')
  await expect(call('select admin_save_team(null,$1,$2,$3)',[id(10),'Team','null'])).rejects.toThrow('exactly two')
  await expect(call('select admin_save_team(null,$1,$2,$3)',[id(10),'Team',JSON.stringify([id(100),id(101)])],null,'anon')).rejects.toThrow('permission denied')
  expect(await memberships()).toHaveLength(0)
})
