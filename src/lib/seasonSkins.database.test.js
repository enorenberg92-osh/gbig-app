import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

let db
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const q = n => "'" + id(n) + "'"
const enrollment = async (league, player = 100) =>
  (await db.query('select enrolled from league_skins_enrollments where league_id=$1 and player_id=$2', [id(league), id(player)])).rows[0]?.enrolled

// Savepoints keep expected authorization failures from aborting the test's
// surrounding transaction. These roles act only against an in-memory database.
async function asRole(role, actor, sql, params = []) {
  await db.exec('savepoint client_call; set local role ' + role)
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actor == null ? '' : id(actor)])
  try {
    return await db.query(sql, params)
  } catch (error) {
    await db.exec('rollback to savepoint client_call')
    throw error
  } finally {
    await db.exec('release savepoint client_call; reset role')
  }
}
const setEnrollment = (league, player, enrolled, actor = 1) => asRole('authenticated', actor,
  'select admin_set_skins_enrollment($1,$2,$3) as enrolled', [id(league), id(player), enrolled])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create table locations(id uuid primary key);
    create table league_config(id uuid primary key,location_id uuid references locations,is_working boolean);
    create table players(id uuid primary key,location_id uuid references locations,league_id uuid,in_skins boolean,is_sub boolean default false);
    create table teams(league_id uuid,player1_id uuid,player2_id uuid);
    create table team_memberships(league_id uuid,player_id uuid);
    create table events(id uuid primary key,league_id uuid);
    create table scores(event_id uuid,status text);
    create table location_members(user_id uuid,location_id uuid,is_admin boolean);
    create table audit_events(location_id uuid,action text,entity text,entity_id uuid,before_data jsonb,after_data jsonb);
    create function public.is_in_location(venue uuid) returns boolean
      language sql stable security definer set search_path=public as $$
      select exists(select 1 from location_members where user_id=auth.uid() and location_id=venue)
    $$;
    create function public.require_location_admin(venue uuid) returns void
      language plpgsql security definer set search_path=public as $$
      begin
        if auth.uid() is null or not exists(select 1 from location_members where user_id=auth.uid() and location_id=venue and is_admin) then
          raise exception 'Admin access required' using errcode='42501';
        end if;
      end
    $$;
    create function public.write_audit_event(venue uuid,action_value text,entity_value text,entity_key uuid,before_value jsonb,after_value jsonb)
      returns void language sql as $$
      insert into audit_events values(venue,action_value,entity_value,entity_key,before_value,after_value)
    $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
  `)
  await db.exec(
    'insert into locations values(' + q(50) + '),(' + q(51) + ');' +
    'insert into league_config values(' + q(10) + ',' + q(50) + ',true),(' + q(11) + ',' + q(50) + ',false),(' + q(12) + ',' + q(50) + ',false),(' + q(20) + ',' + q(51) + ',true);' +
    'insert into players(id,location_id,league_id,in_skins) values(' + q(100) + ',' + q(50) + ',' + q(10) + ',true),(' + q(101) + ',' + q(50) + ',' + q(10) + ',false),(' + q(102) + ',' + q(51) + ',' + q(20) + ',true);' +
    'insert into team_memberships values(' + q(10) + ',' + q(100) + '),(' + q(11) + ',' + q(100) + '),(' + q(12) + ',' + q(100) + '),(' + q(20) + ',' + q(102) + ');' +
    'insert into teams values(' + q(10) + ',' + q(100) + ',' + q(101) + ');' +
    'insert into events values(' + q(30) + ',' + q(11) + '); insert into scores values(' + q(30) + ",'verified');" +
    'insert into location_members values(' + q(1) + ',' + q(50) + ',true),(' + q(2) + ',' + q(50) + ',false),(' + q(3) + ',' + q(51) + ',true);'
  )
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261023181241_season_skins_enrollment.sql', import.meta.url), 'utf8'))
}, 30000)

afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback; reset role') })

it('seeds legacy selections for current and played seasons while leaving planned seasons unchecked', async () => {
  expect(await enrollment(10)).toBe(true)
  expect(await enrollment(11)).toBe(true)
  expect(await enrollment(12)).toBe(false)
  expect(await enrollment(10, 101)).toBe(false)
  expect((await db.query('select count(*)::int as count from league_skins_enrollments where league_id=$1 and player_id=$2', [id(10), id(100)])).rows[0].count).toBe(1)
})

it('allows members to read only their own venue enrollment', async () => {
  const own = await asRole('authenticated', 2, 'select location_id from league_skins_enrollments')
  expect(own.rows.length).toBeGreaterThan(0)
  expect(own.rows.every(row => row.location_id === id(50))).toBe(true)
  const other = await asRole('authenticated', 3, 'select location_id from league_skins_enrollments')
  expect(other.rows).toEqual([{ location_id: id(51) }])
  await expect(asRole('anon', null, 'select * from league_skins_enrollments')).rejects.toThrow('permission denied')
})

it('denies direct client writes and anonymous enrollment RPC calls', async () => {
  for (const sql of [
    'insert into league_skins_enrollments(league_id,player_id,location_id,enrolled) values(' + q(10) + ',' + q(101) + ',' + q(50) + ',true)',
    'update league_skins_enrollments set enrolled=false',
    'delete from league_skins_enrollments',
  ]) await expect(asRole('authenticated', 1, sql)).rejects.toThrow('permission denied')
  await expect(asRole('anon', null, 'select admin_set_skins_enrollment($1,$2,true)', [id(10), id(100)])).rejects.toThrow('permission denied')
})

it('audits admin enrollment and successful false returns, retaining location authorization', async () => {
  expect((await setEnrollment(10, 101, true)).rows[0].enrolled).toBe(true)
  expect((await setEnrollment(10, 101, false)).rows[0].enrolled).toBe(false)
  expect(await enrollment(10, 101)).toBe(false)
  expect((await db.query('select in_skins from players where id=$1', [id(101)])).rows[0].in_skins).toBe(false)
  expect((await db.query('select count(*)::int as count from audit_events')).rows[0].count).toBe(2)
  await expect(setEnrollment(10, 100, false, 2)).rejects.toThrow('Admin access required')
  await expect(setEnrollment(20, 102, false)).rejects.toThrow('Admin access required')
  await expect(setEnrollment(10, 102, true)).rejects.toThrow('Player not found in this venue')
  await expect(setEnrollment(10, 100, null)).rejects.toThrow('Choose whether')
  expect(await enrollment(10)).toBe(true)
  expect(await enrollment(20, 102)).toBe(true)
})

it('rejects cross-venue rows even from a role with direct table privileges', async () => {
  await expect(asRole('service_role', null,
    'insert into league_skins_enrollments(league_id,player_id,location_id,enrolled) values($1,$2,$3,true)',
    [id(10), id(102), id(50)])).rejects.toThrow('same venue')
})

it('keeps a new season empty until explicitly enrolled, including unchanged legacy true profile updates', async () => {
  await db.exec('update league_config set is_working=false where id=' + q(10) + '; insert into league_config values(' + q(13) + ',' + q(50) + ',true);')
  expect(await enrollment(13)).toBeUndefined()
  expect((await db.query('select in_skins from players where id=$1', [id(100)])).rows[0].in_skins).toBe(true)
  // The existing profile RPC writes its in_skins payload even when the raw
  // value equals the old season's flag. The real UPDATE OF trigger must run.
  await db.query('update players set in_skins=true where id=$1', [id(100)])
  expect(await enrollment(13)).toBe(true)
  expect(await enrollment(10)).toBe(true)
})

it('adds unchecked regular profiles to the working season without auto-adding substitute profiles', async () => {
  await db.exec('insert into players(id,location_id,in_skins) values(' + q(103) + ',' + q(50) + ',false);' +
    'insert into players(id,location_id,in_skins,is_sub) values(' + q(104) + ',' + q(50) + ',true,true);')
  expect(await enrollment(10, 103)).toBe(false)
  expect(await enrollment(10, 104)).toBeUndefined()
})

it('changes historical enrollment without mutating the current season or legacy flag', async () => {
  expect((await setEnrollment(11, 100, false)).rows[0].enrolled).toBe(false)
  expect(await enrollment(11)).toBe(false)
  expect(await enrollment(10)).toBe(true)
  expect((await db.query('select in_skins from players where id=$1', [id(100)])).rows[0].in_skins).toBe(true)
})
