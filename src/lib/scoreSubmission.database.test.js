import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

let db
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const q = n => "'" + id(n) + "'"
const migration = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const fn = (file, name) => migration(file).match(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\$\\$;'))[0]
const entry = (player, score = 4, extra = {}) => ({ player_id: id(player), hole_scores: Array(9).fill(score), ...extra })
async function submit(entries, actor = 101, event = 41) {
  await db.exec('set role authenticated; set "request.jwt.claim.sub"=' + q(actor))
  try { return (await db.query('select submit_scores($1,$2) as result', [id(event), JSON.stringify(entries)])).rows[0].result }
  finally { await db.exec('reset role') }
}
const rows = async () => (await db.query('select * from scores order by player_id')).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(readFileSync(new URL('../../scripts/database-fixture.sql', import.meta.url), 'utf8'))
  await db.exec('create role anon;')
  await db.exec(fn('enable_rls_phase1.sql', 'is_admin_of_location'))
  await db.exec(migration('202607100003_phase1_league_rosters.sql').match(/CREATE OR REPLACE VIEW public\.roster_at[\s\S]*?;/)[0])
  for (const name of ['jsonb_int_array_valid', 'jsonb_int_array_sum', 'int_array_valid', 'int_array_sum', 'validate_score_row']) {
    await db.exec(fn('202607100002_phase1_score_and_course_constraints.sql', name))
  }
  await db.exec(fn('202607180007_phase4_hole_stats.sql', 'hole_stats_valid'))
  for (const name of ['redact_audit_payload', 'write_audit_event']) await db.exec(fn('202607100001_phase1_audit_foundation.sql', name))
  for (const name of ['require_location_admin', 'phase1_apply_no_show_policy', 'admin_upsert_score']) await db.exec(fn('202607100004_phase1_mutation_rpcs.sql', name))
  await db.exec(fn('202607180005_phase3_special_events.sql', 'compute_event_results'))
  await db.exec(migration('20261023180948_missed_penalty_net_par_plus_seven.sql'))
  await db.exec(migration('20261023180948_missed_penalty_net_par_plus_seven.sql'))
  const rules = '20261021120000_official_scores_handicap_overrides.sql'
  for (const name of ['apply_player_handicap', 'submit_scores']) await db.exec(fn(rules, name))
  await db.exec('revoke all on function submit_scores(uuid,jsonb) from public; grant execute on function submit_scores(uuid,jsonb) to authenticated;')
  await db.exec('create trigger validate_scores before insert or update on scores for each row execute function validate_score_row(); grant usage on schema public,auth to authenticated,anon;')
  await db.exec(migration('20261025193144_admin_score_limits_and_min_handicap.sql'))
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('reset role; truncate scores,handicap_history,events,players,teams,team_memberships,courses,locations,league_config,audit_events cascade;' +
    'insert into locations values(' + q(1) + '),(' + q(2) + ');' +
    'insert into teams values(' + q(21) + ',' + q(1) + ',' + q(3) + ",'Partners'),(" + q(22) + ',' + q(1) + ',' + q(3) + ",'Other team');" +
    'insert into players values(' + [q(11), q(101), q(1), "'Alex'", 2, q(21)].join(',') + '),(' + [q(12), q(102), q(1), "'Blair'", 4, q(21)].join(',') + '),(' + [q(13), q(103), q(2), "'Other venue'", 3, 'null'].join(',') + '),(' + [q(14), q(104), q(1), "'Other team'", 3, q(22)].join(',') + ');' +
    'insert into courses values(' + q(31) + ',' + q(1) + ",9,'[4,4,4,4,4,4,4,4,4]',36,null);" +
    'insert into events(id,location_id,league_id,course_id,status,start_date) values(' + [q(41),q(1),q(3),q(31),"'open'","'2026-10-01'"].join(',') + ');' +
    'insert into team_memberships values(' + [q(21),q(11),q(1),q(3),"'2026-01-01'",'null'].join(',') + '),(' + [q(21),q(12),q(1),q(3),"'2026-01-01'",'null'].join(',') + '),(' + [q(22),q(14),q(1),q(3),"'2026-01-01'",'null'].join(',') + ');')
})

it('lets one partner submit, then the other later, preserving the first card and handicap snapshot', async () => {
  expect((await submit([entry(11)])).inserted).toBe(1)
  const first = (await rows())[0]
  expect(first).toMatchObject({ player_id: id(11), gross_total: 36, net_total: 34, handicap_used: 2, status: 'verified' })
  await db.exec('update players set handicap=8 where id=' + q(11))
  expect((await submit([entry(12, 5)], 102)).inserted).toBe(1)
  expect((await rows())[0]).toEqual(first)
  expect((await rows())[1]).toMatchObject({ gross_total: 45, net_total: 41, handicap_used: 4, status: 'verified' })
  expect((await db.query("select after_data->'submitted_player_ids' as ids from audit_events where action='score.submit' order by created_at")).rows.map(row => row.ids)).toEqual([[id(11)], [id(12)]])
})
it('still allows both cards together and safely retries a mixed existing/new batch', async () => {
  await submit([entry(11)])
  const first = (await rows())[0]
  expect((await submit([entry(11, 9), entry(12, 5)])).inserted).toBe(1)
  expect((await rows())[0]).toEqual(first)
  expect((await submit([entry(11), entry(12)])).already_submitted).toBe(true)
  expect(await rows()).toHaveLength(2)
})
it('allows a teammate to record the absent partner and preserves optional stats', async () => {
  const stats = Array.from({ length: 9 }, () => ({ putts: 2, fir: false, gir: true }))
  await submit([entry(12, 4, { hole_stats: stats })])
  expect((await rows())[0]).toMatchObject({ player_id: id(12), hole_stats: stats })
})
it.each([[], null, {}, [entry(11), entry(11)], [entry(11), entry(12), entry(14)]])('rejects empty, malformed, duplicate and oversized batches: %j', async entries => {
  await expect(submit(entries)).rejects.toThrow(/array|selected teammate/)
  expect(await rows()).toHaveLength(0)
})
it('rejects another team or venue, a non-rostered caller, and anonymous access', async () => {
  await expect(submit([entry(14)])).rejects.toThrow('not on your event roster')
  await expect(submit([entry(11)], 103)).rejects.toThrow('No player profile')
  await db.exec('delete from team_memberships where player_id=' + q(11))
  await expect(submit([entry(12)])).rejects.toThrow('not rostered')
  await db.exec('set role anon')
  await expect(db.query('select submit_scores($1,$2)', [id(41), JSON.stringify([entry(12)])])).rejects.toThrow('permission denied')
  await db.exec('reset role')
})
it('rejects incomplete/invalid cards atomically, without saving the valid partner', async () => {
  for (const holes of [[4], Array(9).fill(null), Array(9).fill(0), Array(9).fill(4.5)]) {
    await expect(submit([entry(11), entry(12, 4, { hole_scores: holes })])).rejects.toThrow(/Scores must include|hole_scores must contain/)
    expect(await rows()).toHaveLength(0)
  }
})
it('keeps the first submission when a retry arrives after approval; rejected cards can be re-entered', async () => {
  await submit([entry(11)])
  await db.exec("update scores set status='verified'")
  const verified = (await rows())[0]
  expect((await submit([entry(11, 8)])).inserted).toBe(0)
  expect((await rows())[0]).toEqual(verified)
  await db.exec("update scores set status='rejected'")
  expect((await submit([entry(11, 5)])).inserted).toBe(1)
  expect((await rows()).filter(row => row.status !== 'rejected')).toHaveLength(1)
})
it('keeps the normal round deadline: no second partner submission after publishing', async () => {
  await submit([entry(11)])
  await db.exec("update events set status='closed'")
  await expect(submit([entry(12)], 102)).rejects.toThrow('no longer open')
  expect(await rows()).toHaveLength(1)
})
it('makes a submitted score official and averages in the registered handicap (4 shoots +8 -> 5)', async () => {
  await submit([entry(12, 5, { hole_scores: [5, 5, 5, 5, 5, 5, 5, 5, 4] })], 102)
  expect((await rows())[0]).toMatchObject({ gross_total: 44, handicap_used: 4, net_total: 40, status: 'verified' })
  expect(Number((await db.query('select handicap from players where id=' + q(12))).rows[0].handicap)).toBe(5)
})

async function prepareCloseout() {
  await db.exec('insert into location_admins values(' + q(100) + ',' + q(1) + ');' +
    'insert into league_config(id,location_id,name,num_weeks,is_working) values(' + q(3) + ',' + q(1) + ",'Fall',12,true);" +
    'delete from team_memberships where team_id=' + q(22))
}
async function asAdmin(expression) {
  await db.exec('set role authenticated; set "request.jwt.claim.sub"=' + q(100))
  try { return (await db.query('select ' + expression + ' as result')).rows[0].result }
  finally { await db.exec('reset role') }
}
it.each([[9,35,42],[9,36,43],[9,37,44],[18,72,79]])('closes a %i-hole par-%i round with individual net penalties of %i for positive and plus handicaps', async (holes,par,net) => {
  await prepareCloseout()
  const pars=Array(holes).fill(4); pars[0]+=par-holes*4
  await db.query('update courses set num_holes=$1,hole_pars=$2,total_par=$3', [holes,JSON.stringify(pars),par])
  await db.exec('update players set handicap=12 where id=' + q(11) + '; update players set handicap=-2 where id=' + q(12))
  expect((await asAdmin('publish_week(' + q(41) + ')')).penalties_added).toBe(2)
  expect(await rows()).toMatchObject([
    {player_id:id(11),net_total:net,handicap_used:12,entry_type:'missed_penalty',gross_total:null,hole_scores:null},
    {player_id:id(12),net_total:net,handicap_used:-2,entry_type:'missed_penalty',gross_total:null,hole_scores:null},
  ])
  expect((await asAdmin('publish_week(' + q(41) + ')')).already_closed).toBe(true)
  expect(await rows()).toHaveLength(2)
})
it('penalizes only the missing individual and allows a late played correction to supersede that penalty', async () => {
  await prepareCloseout()
  await submit([entry(12)])
  const partner=(await rows())[0]
  expect((await asAdmin('publish_week(' + q(41) + ')')).penalties_added).toBe(1)
  expect((await rows())[0]).toMatchObject({player_id:id(11),net_total:43,entry_type:'missed_penalty'})
  expect((await rows())[1]).toEqual(partner)
  await asAdmin('admin_upsert_score(' + q(41) + ",'" + JSON.stringify([entry(11)]) + "'::jsonb)")
  expect((await rows()).every(row=>row.entry_type==='played')).toBe(true)
  expect((await rows())[0].net_total).toBe(34)
  expect((await db.query('select status from events where id=' + q(41))).rows[0].status).toBe('closed')
})
it('preserves closeout authorization and pending-score guards', async () => {
  await prepareCloseout()
  await submit([entry(11)])
  await db.exec("update scores set status='pending'; set role authenticated; set \"request.jwt.claim.sub\"=" + q(101))
  await expect(db.query('select publish_week(' + q(41) + ')')).rejects.toThrow('Admin access')
  await db.exec('reset role')
  await expect(asAdmin('publish_week(' + q(41) + ')')).rejects.toThrow('pending')
  expect((await rows()).filter(row=>row.entry_type==='missed_penalty')).toHaveLength(0)
  expect((await db.query('select status from events where id=' + q(41))).rows[0].status).toBe('open')
})

it.each([9,18])('caps player-entered %i-hole cards at each hole’s double par with consistent totals', async holes => {
  const pars = Array.from({length:holes},(_,i)=>[3,4,5][i%3])
  await db.query('update courses set num_holes=$1,hole_pars=$2,total_par=$3', [holes,JSON.stringify(pars),pars.reduce((a,b)=>a+b,0)])
  await submit([entry(11,4,{hole_scores:Array(holes).fill(15)})])
  const score=(await rows())[0], gross=pars.reduce((a,b)=>a+b*2,0)
  expect(score).toMatchObject({hole_scores:pars.map(par=>par*2),gross_total:gross,net_total:gross-2,handicap_used:2})
})
it('lets admins save one teammate, then the other, and correct just one without changing the partner', async()=>{
  await prepareCloseout()
  const save=entries=>asAdmin('admin_upsert_score('+q(41)+",'"+JSON.stringify(entries)+"'::jsonb)")
  await save([entry(11,15,{handicap_used:2})])
  expect(await rows()).toHaveLength(1)
  expect((await rows())[0]).toMatchObject({hole_scores:Array(9).fill(8),gross_total:72,net_total:70})
  const first=(await rows())[0]
  await save([entry(12,5,{handicap_used:4})])
  expect((await rows())[0]).toEqual(first)
  const partner=(await rows())[1]
  await save([entry(11,4,{handicap_used:2})])
  expect((await rows())[1]).toEqual(partner)
  expect((await rows())[0].gross_total).toBe(36)
})
it('saves a league minimum, applies it with and without rounds, and preserves locked players, history and other venues', async()=>{
  await prepareCloseout()
  await db.exec('update players set starting_handicap=handicap; update players set handicap_locked=true where id='+q(14))
  await submit([entry(11,3)])
  const historical=(await rows())[0]
  await asAdmin('admin_set_min_handicap('+q(3)+',6)')
  expect((await db.query('select min_handicap from league_config where id='+q(3))).rows[0].min_handicap).toBe(6)
  const handicaps=(await db.query('select id,handicap from players order by id')).rows.map(p=>Number(p.handicap))
  expect(handicaps).toEqual([6,6,3,3])
  expect((await rows())[0]).toEqual(historical)
  await submit([entry(12,3)],102)
  expect(Number((await db.query('select handicap from players where id='+q(12))).rows[0].handicap)).toBe(6)
  await asAdmin('admin_set_min_handicap('+q(3)+',-2)')
  expect(Number((await db.query('select handicap from players where id='+q(12))).rows[0].handicap)).toBe(-2)
})
it('rejects invalid and unauthorized minimum changes atomically', async()=>{
  await prepareCloseout()
  for(const value of ['null','-3','28']) await expect(asAdmin('admin_set_min_handicap('+q(3)+','+value+')')).rejects.toThrow('Minimum handicap')
  await db.exec('set role authenticated; set "request.jwt.claim.sub"='+q(101))
  await expect(db.query('select admin_set_min_handicap('+q(3)+',6)')).rejects.toThrow('Admin access')
  await db.exec('reset role; set role anon')
  await expect(db.query('select admin_set_min_handicap('+q(3)+',6)')).rejects.toThrow('permission denied')
  await db.exec('reset role')
  expect((await db.query('select min_handicap from league_config where id='+q(3))).rows[0].min_handicap).toBe(-2)
})
