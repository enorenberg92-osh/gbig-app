import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

// A disposable PostgreSQL engine. This script never reads a connection URL.
const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let passed = 0
async function check(name, action) { await action(); console.log(`PASS ${name}`); passed++ }
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE locations(id uuid PRIMARY KEY, slug text UNIQUE);
    CREATE TABLE league_config(id uuid PRIMARY KEY);
    CREATE TABLE events(id uuid PRIMARY KEY);
    INSERT INTO locations VALUES ('${id(1)}','gbig'),('${id(2)}','appleton');
    INSERT INTO auth.users VALUES ('${id(3)}');
    INSERT INTO league_config VALUES ('${id(4)}'); INSERT INTO events VALUES ('${id(5)}');
  `)
  await db.exec(readFileSync(new URL('../docs/proposed-sql/weekly-email.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../supabase/migrations/20261016212050_gmail_email.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../supabase/migrations/20261016233945_multi_recipient_email.sql', import.meta.url), 'utf8'))
  const { rows: senders } = await db.query('SELECT * FROM weekly_email_senders ORDER BY email')
  const sender = senders.find(s => s.location_id === id(1))
  await check('both venue defaults are disabled and grant no account access', async () => {
    assert.equal(senders.length, 2)
    assert.ok(senders.every(s => s.enabled === false && s.is_default))
    assert.equal((await db.query('SELECT count(*)::int AS n FROM weekly_email_sender_users')).rows[0].n, 0)
  })
  await check('all four tables have RLS and deny every browser role', async () => {
    const { rows } = await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('weekly_email_senders','weekly_email_sender_users','weekly_email_campaigns','weekly_email_direct_quota')")
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true)
      for (const role of ['anon', 'authenticated']) {
        for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const result = await db.query('SELECT has_table_privilege($1, $2, $3) AS permitted', [role, row.relname, permission])
          assert.equal(result.rows[0].permitted, false)
        }
      }
    }
  })
  await check('the endpoint service role can read but cannot manage sender grants', async () => {
    for (const table of ['weekly_email_senders', 'weekly_email_sender_users']) {
      assert.equal((await db.query("SELECT has_table_privilege('service_role',$1,'SELECT') AS allowed", [table])).rows[0].allowed, true)
      for (const permission of ['INSERT', 'UPDATE', 'DELETE']) {
        assert.equal((await db.query("SELECT has_table_privilege('service_role',$1,$2) AS allowed", [table, permission])).rows[0].allowed, false)
      }
    }
  })
  await check('Gmail refresh tokens and OAuth state deny all browser access and have RLS', async () => {
    for (const table of ['gmail_email_connections', 'gmail_email_oauth_states']) {
      assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE relname=$1', [table])).rows[0].relrowsecurity, true)
      for (const role of ['anon', 'authenticated']) for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, permission])).rows[0].allowed, false)
      }
      for (const permission of ['SELECT', 'INSERT', 'UPDATE']) assert.equal((await db.query("SELECT has_table_privilege('service_role',$1,$2) AS allowed", [table, permission])).rows[0].allowed, true)
    }
  })
  await check('OAuth state consumption is single-use and expired states cannot be consumed', async () => {
    await db.query("INSERT INTO gmail_email_oauth_states(state_hash,sender_id,user_id,verifier_ciphertext,return_origin,expires_at) VALUES ('test-hash',$1,$2,'v1.test.encrypted','https://gbig-app.vercel.app',now()+interval '10 minutes')", [sender.id, id(3)])
    const consume = () => db.query("UPDATE gmail_email_oauth_states SET consumed_at=now() WHERE state_hash='test-hash' AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash")
    const results = await Promise.all([consume(), consume()])
    assert.equal(results.reduce((count, result) => count + result.rows.length, 0), 1)
    await db.query("UPDATE gmail_email_oauth_states SET consumed_at=NULL,expires_at=now()-interval '1 minute'")
    assert.equal((await consume()).rows.length, 0)
  })
  await check('a second default sender for the same venue is rejected', async () => {
    await assert.rejects(db.query('INSERT INTO weekly_email_senders(location_id,display_name,email,reply_to,is_default) VALUES ($1,$2,$3,$3,true)', [id(1), 'Other', 'other@example.com']))
  })
  const insert = (campaignId, locationId = id(1), recipients = [{ email: 'person@example.com', status: 'pending' }]) => db.query(`
    INSERT INTO weekly_email_campaigns(id,mode,compose_id,location_id,created_by,sender_id,sender,reply_to,subject,body,recipients)
    VALUES ($1,'direct',$1,$2,$3,$4,'Trent <trent@greenbayindoorgolf.com>','trent@greenbayindoorgolf.com','Test','Private message',$5::jsonb)`,
    [campaignId, locationId, id(3), sender.id, JSON.stringify(recipients)])
  const audience = n => Array.from({ length: n }, (_, i) => ({ email: `person${i}@example.com`, status: 'pending' }))
  await check('direct campaigns allow 1–50 recipients and require the correct venue and direct scope', async () => {
    await insert(id(10))
    await assert.rejects(insert(id(11), id(2)))
    await insert(id(12), id(1), audience(2))
    await insert(id(13), id(1), audience(50))
    await assert.rejects(insert(id(14), id(1), audience(51)))
    await assert.rejects(insert(id(15), id(1), []))
    await assert.rejects(db.query('UPDATE weekly_email_campaigns SET event_id=$1 WHERE id=$2', [id(5), id(10)]))
  })
  await check('two lease claims have exactly one winner and stale tokens cannot write', async () => {
    const claim = token => db.query("UPDATE weekly_email_campaigns SET lease_token=$1,lease_until=now()+interval '3 minutes' WHERE id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING id", [token, id(10)])
    const results = await Promise.all([claim(id(20)), claim(id(21))])
    assert.equal(results.reduce((n, result) => n + result.rows.length, 0), 1)
    const stale = await db.query('UPDATE weekly_email_campaigns SET body=$1 WHERE id=$2 AND lease_token=$3 RETURNING id', ['Must not replace', id(10), id(99)])
    assert.equal(stale.rows.length, 0)
  })
  await check('direct allowance slots reject concurrent duplicates and slots above 49', async () => {
    await insert(id(30)); await insert(id(31)); await insert(id(32))
    const reserve = campaign => db.query('INSERT INTO weekly_email_direct_quota(quota_day,location_id,user_id,slot,campaign_id) VALUES (CURRENT_DATE,$1,$2,0,$3)', [id(1), id(3), campaign])
    const results = await Promise.allSettled([reserve(id(30)), reserve(id(31))])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    await assert.rejects(db.query('INSERT INTO weekly_email_direct_quota(quota_day,location_id,user_id,slot,campaign_id) VALUES (CURRENT_DATE,$1,$2,50,$3)', [id(1), id(3), id(32)]))
  })
  await check('quota derives recipient cost from the saved campaign and enforces 50 total', async () => {
    await insert(id(40), id(1), audience(30)); await insert(id(41), id(1), audience(20)); await insert(id(42))
    const reserve = (campaign, slot) => db.query("INSERT INTO weekly_email_direct_quota(quota_day,location_id,user_id,slot,campaign_id,recipient_count) VALUES ('2026-10-01',$1,$2,$3,$4,1)", [id(1), id(3), slot, campaign])
    await reserve(id(40), 0)
    assert.equal((await db.query("SELECT recipient_count FROM weekly_email_direct_quota WHERE campaign_id=$1", [id(40)])).rows[0].recipient_count, 30)
    await assert.rejects(reserve(id(40), 1), /unique/i)
    await reserve(id(41), 1)
    await assert.rejects(reserve(id(42), 2), /DIRECT_EMAIL_DAILY_LIMIT/)
    assert.equal((await db.query("SELECT SUM(recipient_count)::int AS n FROM weekly_email_direct_quota WHERE quota_day='2026-10-01'")).rows[0].n, 50)
    await assert.rejects(db.query("INSERT INTO weekly_email_direct_quota(quota_day,location_id,user_id,slot,campaign_id) VALUES ('2026-10-02',$1,$2,0,$3)", [id(2), id(3), id(40)]), /DIRECT_EMAIL_CAMPAIGN_NOT_FOUND/)
    for (const role of ['anon', 'authenticated']) assert.equal((await db.query("SELECT has_function_privilege($1,'public.enforce_direct_email_allowance()','EXECUTE') AS allowed", [role])).rows[0].allowed, false)
  })
  console.log(`${passed} PostgreSQL email checks passed. No production connection or email provider used.`)
} finally { await db.close() }
