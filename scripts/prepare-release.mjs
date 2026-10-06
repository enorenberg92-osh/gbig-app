import fs from 'node:fs'
import crypto from 'node:crypto'

const files = ['202609060001_closeout_consistency.sql','202610060001_season_handicap_order.sql','202610060002_publication_guards.sql']
const backup = JSON.parse(fs.readFileSync('artifacts/release-before.json','utf8').replace(/^\uFEFF/,'')).rows[0].release_audit
if (backup.functions.length !== 6 || backup.mismatched_gross || backup.mismatched_net) throw new Error('Release backup did not pass preflight.')
const migrations = files.map(file => {
  const source = fs.readFileSync(`supabase/migrations/${file}`,'utf8')
  const body = source.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'')
  return {file,version:file.split('_')[0],name:file.replace(/^\d+_|\.sql$/g,''),source,body,hash:crypto.createHash('sha256').update(source).digest('hex')}
})
const latest = [...backup.migrations.map(m => m.version)].sort().at(-1)
const quote = value => "'" + value.replaceAll("'","''") + "'"
const versions = migrations.map(m=>quote(m.version)).join(',')
const release = `BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('gbig-launch-release'));
DO $preflight$
BEGIN
 IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (${versions})) THEN
   RAISE EXCEPTION 'Release migration already recorded; inspect before retry';
 END IF;
 IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM ${quote(latest)} THEN
   RAISE EXCEPTION 'Migration history changed after backup; take a new snapshot';
 END IF;
END;
$preflight$;
${migrations.map(m => `${m.body}\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (${quote(m.version)},${quote(m.name)},ARRAY[${quote(m.body)}]);`).join('\n')}
COMMIT;
SELECT 'Three launch migrations applied atomically' AS release_status;
`
fs.writeFileSync('artifacts/apply-release.sql',release)
fs.writeFileSync('artifacts/rollback-release.sql',`BEGIN;\n${backup.functions.map(f=>f.definition+';').join('\n')}\nDELETE FROM supabase_migrations.schema_migrations WHERE version IN (${versions});\nCOMMIT;\n`)
fs.writeFileSync('artifacts/release-source-hashes.json',JSON.stringify(migrations.map(({file,hash})=>({file,hash})),null,2))
console.log('Prepared atomic release and function rollback for three migrations. No rows will be modified.')
