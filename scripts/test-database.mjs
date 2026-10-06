import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

// Deliberately fixed loopback endpoint; never reads production connection env.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = process.env.GBIG_TEST_PG_BIN || 'C:/Users/19205/scoop/apps/postgresql/current/bin'
const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
if (!existsSync(exe('psql'))) throw new Error('Set GBIG_TEST_PG_BIN to your local PostgreSQL bin directory.')
const db = `gbig_contract_${Date.now()}`
const connection = ['-h', '127.0.0.1', '-p', '55439', '-U', 'postgres']
function run(name, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(exe(name), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', chunk => out += chunk)
    child.stderr.on('data', chunk => err += chunk)
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())))
    child.stdin.end(input)
  })
}
const sql = text => run('psql', [...connection, '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text)
const migration = name => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')
function fn(file, name) {
  const match = migration(file).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`))
  if (!match) throw new Error(`Missing source function ${name}`)
  return match[0]
}
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const quote = n => `'${id(n)}'`
const call = (user, expression) => sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '${id(user)}'; SELECT ${expression}; COMMIT;`)
const entries = JSON.stringify([{ player_id: id(11), hole_scores: Array(9).fill(4) }, { player_id: id(12), hole_scores: Array(9).fill(5) }])
const submit = () => call(101, `public.submit_scores(${quote(41)}, '${entries}'::jsonb)`)
const publish = () => call(100, `public.publish_week(${quote(41)})`)
async function reset() {
  await sql(`TRUNCATE scores, events, players, teams, team_memberships, courses, league_config, location_admins, locations, audit_events CASCADE;
  INSERT INTO locations VALUES (${quote(1)}), (${quote(2)});
  INSERT INTO location_admins VALUES (${quote(100)},${quote(1)});
  INSERT INTO league_config VALUES (${quote(3)},${quote(1)},'Fall',12,true), (${quote(4)},${quote(2)},'Other venue',12,true);
  INSERT INTO teams VALUES (${quote(21)},${quote(1)},${quote(3)},'Test team');
  INSERT INTO players VALUES (${quote(11)},${quote(101)},${quote(1)},'Alex',2,${quote(21)}), (${quote(12)},${quote(102)},${quote(1)},'Blair',4,${quote(21)}), (${quote(13)},${quote(103)},${quote(2)},'Other venue player',3,NULL);
  INSERT INTO courses VALUES (${quote(31)},${quote(1)},9,'[4,4,4,4,4,4,4,4,4]',36,NULL);
  INSERT INTO events(id,location_id,league_id,course_id,status,week_number,start_date) VALUES (${quote(41)},${quote(1)},${quote(3)},${quote(31)},'open',1,'2026-10-01'), (${quote(42)},${quote(1)},${quote(3)},${quote(31)},'draft',2,'2026-10-08'), (${quote(43)},${quote(2)},${quote(4)},${quote(31)},'open',1,'2026-10-01');
  INSERT INTO team_memberships VALUES (${quote(21)},${quote(11)},${quote(1)},${quote(3)},'2026-01-01',NULL),(${quote(21)},${quote(12)},${quote(1)},${quote(3)},'2026-01-01',NULL);`)
}

await run('createdb', [...connection, db])
let passed = 0
try {
  await sql(readFileSync(path.join(root,'scripts/database-fixture.sql'),'utf8'))
  const sources = [
    ['enable_rls_phase1.sql', ['is_admin_of_location','is_in_location']],
    ['202607100001_phase1_audit_foundation.sql', ['redact_audit_payload','write_audit_event']],
    ['202607100002_phase1_score_and_course_constraints.sql', ['jsonb_int_array_valid','jsonb_int_array_sum','int_array_valid','int_array_sum','validate_score_row']],
    ['202607100004_phase1_mutation_rpcs.sql', ['require_location_admin','phase1_apply_no_show_policy','admin_review_score','admin_upsert_score']],
    ['202607180005_phase3_special_events.sql', ['compute_event_results']],
    ['202607180007_phase4_hole_stats.sql', ['hole_stats_valid','submit_scores']],
    ['202607180001_phase3_bulk_approve.sql', ['admin_bulk_approve_scores']],
    ['202607300003_penalty_par_plus_handicap.sql', ['publish_week']],
  ]
  const roster = migration('202607100003_phase1_league_rosters.sql').match(/CREATE OR REPLACE VIEW public\.roster_at[\s\S]*?;/)[0]
  await sql(roster)
  for (const [file,names] of sources) for (const name of names) await sql(fn(file,name))
  await sql(`CREATE TRIGGER scores_validate_payload BEFORE INSERT OR UPDATE ON scores FOR EACH ROW EXECUTE FUNCTION validate_score_row();
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT ON events TO authenticated;
    ALTER TABLE events ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_location_read ON events FOR SELECT TO authenticated USING (public.is_in_location(location_id));`)
  // Repeat the new migration to check its idempotency, not the legacy chain.
  await sql(migration('202609060001_closeout_consistency.sql'))
  await sql(migration('202609060001_closeout_consistency.sql'))
  await sql(migration('202610060002_publication_guards.sql'))
  const tests = [
    ['invalid course or incomplete roster cannot be published', async () => {
      await sql(`UPDATE courses SET total_par=35 WHERE id=${quote(31)}`)
      await assert.rejects(publish(),/complete pars/)
      await sql(`UPDATE courses SET total_par=36 WHERE id=${quote(31)}; DELETE FROM team_memberships WHERE player_id=${quote(12)}`)
      await assert.rejects(publish(),/two different/)
      assert.equal(await sql('SELECT count(*) FROM scores'),'0')
    }],
    ['closed results cannot be deleted out from under finalized standings', async () => {
      await publish()
      const scoreId=await sql(`SELECT id FROM scores WHERE player_id=${quote(11)}`)
      await assert.rejects(call(100,`admin_delete_score('${scoreId}')`),/closed round/)
      assert.equal(await sql('SELECT count(*) FROM scores'),'2')
    }],
    ['two simultaneous submissions insert one team only', async () => {
      const results = await Promise.all([submit(), submit()])
      assert.deepEqual(results.map(v => JSON.parse(v).inserted).sort(), [0,2])
      assert.equal(await sql('SELECT count(*) FROM scores'), '2')
    }],
    ['submit versus publish never leaves played and penalty together', async () => {
      const results = await Promise.allSettled([submit(), publish()])
      assert.equal(results.filter(r => r.status === 'rejected').length,1)
      assert.equal(await sql("SELECT count(*) FROM scores s JOIN scores p ON p.event_id=s.event_id AND p.player_id=s.player_id WHERE s.entry_type='played' AND p.entry_type='missed_penalty'"),'0')
    }],
    ['pending scores block publishing atomically', async () => {
      await submit(); await assert.rejects(publish(), /pending/)
      assert.equal(await sql(`SELECT status FROM events WHERE id=${quote(41)}`),'open')
      assert.equal(await sql("SELECT count(*) FROM scores WHERE entry_type='missed_penalty'"),'0')
    }],
    ['penalty includes par and handicap; repeated publish is a no-op', async () => {
      await publish()
      assert.equal(await sql(`SELECT net_total FROM scores WHERE player_id=${quote(11)}`),'45')
      assert.equal(await sql(`SELECT status FROM events WHERE id=${quote(42)}`),'open')
      assert.equal(JSON.parse(await publish()).already_closed,true)
      assert.equal(await sql('SELECT count(*) FROM scores'),'2')
    }],
    ['review rejection allows resubmission; approval then publish succeeds', async () => {
      await submit()
      const ids = (await sql('SELECT id FROM scores ORDER BY player_id')).split(/\r?\n/)
      for (const scoreId of ids) await call(100, `admin_review_score('${scoreId}','rejected')`)
      assert.equal(JSON.parse(await submit()).inserted,2)
      await call(100,`admin_bulk_approve_scores(${quote(41)})`)
      await publish()
      assert.equal(await sql("SELECT count(*) FROM scores WHERE status='verified' AND entry_type='played'"),'2')
    }],
    ['players cannot publish and another venue cannot submit', async () => {
      await assert.rejects(call(101,`publish_week(${quote(41)})`),/Admin access/)
      await assert.rejects(call(103,`submit_scores(${quote(41)}, '${entries}')`),/No player profile/)
      assert.equal(await call(101,`count(*) FROM events WHERE location_id=${quote(2)}`),'0')
    }],
    ['invalid/null/string/fractional hole values are rejected', async () => {
      for (const value of ['null','{}','[null]','["4"]','[4.5]','[2147483648]']) assert.equal(await sql(`SELECT jsonb_int_array_valid('${value}',1,1,20)`),'f')
      const invalid=JSON.stringify([{player_id:id(11),hole_scores:Array(9).fill(null)},{player_id:id(12),hole_scores:Array(9).fill(4)}])
      await assert.rejects(call(101,`submit_scores(${quote(41)}, '${invalid}')`),/Scores must/)
      assert.equal(await sql('SELECT count(*) FROM scores'),'0')
    }],
    ['a closed round cannot be rejected through the review queue', async () => {
      await submit(); await call(100,`admin_bulk_approve_scores(${quote(41)})`); await publish()
      const scoreId=await sql(`SELECT id FROM scores WHERE player_id=${quote(11)}`)
      await assert.rejects(call(100,`admin_review_score('${scoreId}','rejected')`),/closed round/)
    }],
    ['late admin correction supersedes a penalty without reopening', async () => {
      await publish(); await call(100,`admin_upsert_score(${quote(41)}, '${entries}')`)
      assert.equal(await sql("SELECT count(*) FROM scores WHERE entry_type='missed_penalty'"),'0')
      assert.equal(await sql(`SELECT status FROM events WHERE id=${quote(41)}`),'closed')
    }],
  ]
  for (const [name,test] of tests) { await reset(); await test(); passed++; console.log(`PASS ${name}`) }
  console.log(`${passed} PostgreSQL contract checks passed. Fixture schema; full migration/RLS replay remains separate.`)
} finally {
  // Only this process's freshly created, timestamped synthetic database.
  await run('dropdb', [...connection, db])
}
