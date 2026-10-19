import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

let db
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const q = n => "'" + id(n) + "'"
const context = (actor = 1, player = 10, email = 'correct@example.invalid') =>
  'select service_player_login_context(' + q(actor) + ',' + q(player) + ",'" + email + "') as data"
const begin = (request = 30, actor = 1) => 'select service_begin_player_login_update(' +
  [q(request), q(actor), q(10), q(20), "'old@example.invalid'", "'old@example.invalid'", "'correct@example.invalid'"].join(',') + ') as data'
const finish = (request = 30) => 'select service_finish_player_login_update(' + q(request) + ',' + q(1) + ') as data'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; create schema auth;" +
    "create table auth.users(id uuid primary key,email text,email_change text);" +
    "create table locations(id uuid primary key,name text);" +
    "create table players(id uuid primary key,name text,email text,user_id uuid,location_id uuid,team_id uuid,handicap integer);" +
    "create table location_admins(user_id uuid,location_id uuid); create table super_admins(user_id uuid);" +
    "create table audit_events(actor_id uuid,location_id uuid,action text,entity text,entity_id uuid,before_data jsonb,after_data jsonb);" +
    "create function redact_audit_payload(p jsonb) returns jsonb language sql as $$ select p - 'email' $$;" +
    "grant usage on schema public,auth to service_role; grant all on all tables in schema public to service_role;" +
    'insert into locations values(' + q(100) + ",'Appleton'),(" + q(101) + ",'Green Bay');" +
    'insert into location_admins values(' + q(1) + ',' + q(100) + ');'
  )
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261019224333_player_login_updates.sql', import.meta.url), 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })

async function reset() {
  await db.exec('reset role; truncate players,auth.users,player_login_updates,audit_events cascade;' +
    'insert into auth.users values(' + q(20) + ",'old@example.invalid','');" +
    'insert into players values(' + q(10) + ",'Golfer','old@example.invalid'," + q(20) + ',' + q(100) + ',' + q(200) + ',12);' +
    'set role service_role;')
}
// Only the synthetic test owner simulates the external Auth API's write.
async function simulateAuthApiEmailChange() {
  await db.exec("reset role; update auth.users set email='correct@example.invalid' where id=" + q(20) + '; set role service_role;')
}
describe('login correction database authorization and recovery', () => {
  it('denies client access to every service RPC and private request table', async () => {
    await reset()
    await db.exec('set role authenticated')
    await expect(db.query(context())).rejects.toThrow(/permission denied/)
    await expect(db.query(begin())).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from player_login_updates')).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
  })
  it('rejects another venue admin before reading the login context', async () => {
    await reset()
    await expect(db.query(context(2))).rejects.toThrow('Not authorized')
    expect((await db.query('select count(*)::int as count from player_login_updates')).rows[0].count).toBe(0)
  })
  it('can read the required Auth columns but cannot edit Auth with SQL', async () => {
    await reset()
    expect((await db.query(context())).rows[0].data.player.id).toBe(id(10))
    await expect(db.query("update auth.users set email='incorrect@example.invalid' where id=" + q(20))).rejects.toThrow('permission denied')
  })
  it('blocks roster-only email changes for linked accounts while allowing name corrections', async () => {
    await reset()
    await expect(db.query("update players set email='elsewhere@example.invalid' where id=" + q(10))).rejects.toThrow('Manage Login')
    await db.query("update players set name='Correct Name' where id=" + q(10))
    expect((await db.query('select name,email from players')).rows[0]).toEqual({ name: 'Correct Name', email: 'old@example.invalid' })
  })
  it('serializes an in-progress account, rejects competing requests, and blocks roster/link edits', async () => {
    await reset()
    await db.query(begin())
    await expect(db.query(begin(31))).rejects.toThrow(/conflict|progress/)
    await expect(db.query("update players set email='elsewhere@example.invalid' where id=" + q(10))).rejects.toThrow('Manage Login')
    await expect(db.query('update players set user_id=null where id=' + q(10))).rejects.toThrow('unfinished')
    await expect(db.query('delete from players where id=' + q(10))).rejects.toThrow('unfinished')
    expect((await db.query(begin())).rows[0].data.status).toBe('applying')
  })
  it('stops stale roster changes and duplicate/pending Auth addresses', async () => {
    await reset()
    await db.query('update players set user_id=null where id=' + q(10))
    await expect(db.query(begin())).rejects.toThrow('Player changed')
    await db.query('update players set user_id=' + q(20) + ' where id=' + q(10))
    await db.exec('reset role; insert into auth.users values(' + q(21) + ",'other@example.invalid','correct@example.invalid'); set role service_role;")
    await expect(db.query(begin())).rejects.toThrow('conflict')
  })
  it('blocks an Auth login shared with a Green Bay roster profile', async () => {
    await reset()
    await db.query('insert into players(id,name,user_id,location_id) values(' + q(11) + ",'Other profile'," + q(20) + ',' + q(101) + ')')
    await expect(db.query(begin())).rejects.toThrow('conflict')
  })
  it('requires verified Auth completion, then changes only the existing roster email and audits it', async () => {
    await reset()
    const before = (await db.query('select * from players')).rows[0]
    await db.query(begin())
    await expect(db.query(finish())).rejects.toThrow('Auth email')
    await simulateAuthApiEmailChange()
    expect((await db.query(finish())).rows[0].data.status).toBe('complete')
    const after = (await db.query('select * from players')).rows[0]
    expect(after).toEqual({ ...before, email: 'correct@example.invalid' })
    expect((await db.query("select count(*)::int as count from audit_events where action='player.login_email.completed'")).rows[0].count).toBe(1)
    expect((await db.query(finish())).rows[0].data.status).toBe('complete')
  })
  it('keeps a partial correction locked for review and preserves the original profile', async () => {
    await reset()
    await db.query(begin())
    await simulateAuthApiEmailChange()
    await db.query('select service_fail_player_login_update(' + q(30) + ',' + q(1) + ",'roster_update_failed')")
    expect((await db.query('select status from player_login_updates')).rows[0].status).toBe('needs_review')
    expect((await db.query('select email from players')).rows[0].email).toBe('old@example.invalid')
    await expect(db.query(begin(31))).rejects.toThrow()
  })
})
