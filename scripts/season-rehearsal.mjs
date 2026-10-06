import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { aggregateSeason } from '../src/lib/seasonStandings.js'
import { calcSkins } from '../src/lib/skinsUtils.js'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const bin=process.env.GBIG_TEST_PG_BIN || 'C:/Users/19205/scoop/apps/postgresql/current/bin'
const db=`gbig_season_${Date.now()}`, connection=['-h','127.0.0.1','-p','55439','-U','postgres']
function run(name,args,input=''){return new Promise((resolve,reject)=>{const child=spawn(path.join(bin,name+'.exe'),args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err.trim())));child.stdin.end(input)})}
const sql=s=>run('psql',[...connection,'-d',db,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],s)
const source=file=>fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8')
const fn=(file,name)=>source(file).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`))[0]
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`, q=n=>`'${id(n)}'`
const json=x=>`'${JSON.stringify(x)}'::jsonb`
const call=(user,expression)=>sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL "request.jwt.claim.sub"=${q(user)};SELECT ${expression};COMMIT;`)
const rows=async table=>JSON.parse(await sql(`SELECT COALESCE(json_agg(t),'[]') FROM (${table}) t`))
let assertions=0
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);assertions++}
// Independent rule oracle: never calls the product handicap helper.
function handicap(history){if(!history.length)return null;const recent=history.slice(-12).map(r=>r.diff).sort((a,b)=>a-b);if(recent.length>=4)recent.pop();if(history.slice(-12).length>=5)recent.shift();return Math.max(-2,Math.min(27,Math.floor(recent.reduce((a,b)=>a+b,0)/recent.length*.9)))}
const teamCount=Number(process.env.GBIG_SEASON_TEAMS || 150)
const locations=process.argv.includes('--both')?[{name:'Green Bay',n:1},{name:'Appleton',n:2}]:[{name:'Green Bay',n:1}]
const venues=locations.map(v=>({...v,admin:100+v.n,league:200+v.n,course:300+v.n,players:Array.from({length:teamCount*2},(_,i)=>({id:1000*v.n+i,user:10000*v.n+i,name:`Golfer ${String(i+1).padStart(3,'0')}`,handicap:(i%30)-2,history:[],team:Math.floor(i/2)})),teams:Array.from({length:teamCount},(_,i)=>({id:4000*v.n+i,name:`Team ${String(i+1).padStart(3,'0')}`}))}))
const expected=new Map(), checkLog=[], weekState=new Map()
const recordKey=(event,player)=>`${id(event)}:${id(player)}`
const holes=(v,week,i)=>Array.from({length:9},(_,h)=>h%3!==2&&i===(week*17+h*31)%(teamCount*2)?2:3+((i*3+week*5+h*2+v.n)%5))
function remember(event,v,p,scores,type='played',sub=false,hcp=p.handicap){const gross=scores?.reduce((a,b)=>a+b,0)??null;expected.set(recordKey(event,p.id),{event_id:id(event),player_id:id(p.id),team_id:id(v.teams[p.team].id),gross_total:gross,net_total:type==='missed_penalty'?36+hcp+7:gross-hcp,handicap_used:hcp,entry_type:type,sub_played:sub,hole_scores:scores});if(type==='played'&&!sub)p.history.push({event,diff:gross-36})}
await run('createdb',[...connection,db])
try{
 await sql(fs.readFileSync(path.join(root,'scripts/database-fixture.sql'),'utf8'))
 await sql(`ALTER TABLE players ADD COLUMN handicap_locked boolean DEFAULT false;ALTER TABLE courses ADD COLUMN start_hole int DEFAULT 1;CREATE TABLE handicap_history(player_id uuid,handicap numeric,scores_used int,location_id uuid,created_at timestamptz DEFAULT now());`)
 await sql(source('202607100003_phase1_league_rosters.sql').match(/CREATE OR REPLACE VIEW public\.roster_at[\s\S]*?;/)[0])
 for(const [file,names] of [
 ['enable_rls_phase1.sql',['is_admin_of_location','is_in_location']],['202607100001_phase1_audit_foundation.sql',['redact_audit_payload','write_audit_event']],['202607100002_phase1_score_and_course_constraints.sql',['jsonb_int_array_valid','jsonb_int_array_sum','int_array_valid','int_array_sum','validate_score_row']],['202607100004_phase1_mutation_rpcs.sql',['require_location_admin','phase1_apply_no_show_policy']],['202607180005_phase3_special_events.sql',['compute_event_results']],['202607180007_phase4_hole_stats.sql',['hole_stats_valid','submit_scores','recalculate_player_handicap']],['202607180001_phase3_bulk_approve.sql',['admin_bulk_approve_scores']],['202607300003_penalty_par_plus_handicap.sql',['publish_week']]])for(const name of names)await sql(fn(file,name))
 await sql(`CREATE TRIGGER scores_validate_payload BEFORE INSERT OR UPDATE ON scores FOR EACH ROW EXECUTE FUNCTION validate_score_row();GRANT USAGE ON SCHEMA public,auth TO authenticated;`)
 await sql(source('202609060001_closeout_consistency.sql'))
 await sql(source('202610060001_season_handicap_order.sql'))
 await sql(source('202610060002_publication_guards.sql'))
 let seed=''
 for(const v of venues){seed+=`INSERT INTO locations VALUES(${q(v.n)});INSERT INTO location_admins VALUES(${q(v.admin)},${q(v.n)});INSERT INTO league_config VALUES(${q(v.league)},${q(v.n)},'Fall 2026',12,true);INSERT INTO courses VALUES(${q(v.course)},${q(v.n)},9,'[4,4,4,4,4,4,4,4,4]',36,null,1);INSERT INTO courses VALUES(${q(v.course+10)},${q(v.n)},9,'[4,4,4,4,4,4,4,4,4]',36,null,10);`
 for(const t of v.teams)seed+=`INSERT INTO teams VALUES(${q(t.id)},${q(v.n)},${q(v.league)},'${t.name}');`
 for(const p of v.players)seed+=`INSERT INTO players(id,user_id,location_id,name,handicap,team_id) VALUES(${q(p.id)},${q(p.user)},${q(v.n)},'${p.name}',${p.handicap},${q(v.teams[p.team].id)});INSERT INTO team_memberships VALUES(${q(v.teams[p.team].id)},${q(p.id)},${q(v.n)},${q(v.league)},'2026-10-19',null);`
 for(let w=1;w<=12;w++){const date=new Date(Date.UTC(2026,9,19+(w-1)*7)).toISOString().slice(0,10);seed+=`INSERT INTO events(id,location_id,league_id,course_id,name,status,week_number,start_date) VALUES(${q(v.n*100000+w)},${q(v.n)},${q(v.league)},${q(w%2?v.course:v.course+10)},'Week ${w}','${w===1?'open':'draft'}',${w},'${date}');`}
 seed+=`INSERT INTO events(id,location_id,league_id,course_id,name,status,week_number,start_date,is_bye) VALUES(${q(v.n*100000+99)},${q(v.n)},${q(v.league)},${q(v.course)},'Bye','draft',6,'2026-11-26',true);`
 }
 await sql(seed)
 for(let week=1;week<=12;week++)for(const v of venues){
  const event=v.n*100000+week
  equal(await sql(`SELECT status FROM events WHERE id=${q(event)}`),'open','The next playable week opens')
  if(week===7){for(const idx of [0,2]){const p=v.players[idx];const newTeam=idx===0?1:0;await sql(`UPDATE team_memberships SET effective_to='2026-11-29' WHERE player_id=${q(p.id)};INSERT INTO team_memberships VALUES(${q(v.teams[newTeam].id)},${q(p.id)},${q(v.n)},${q(v.league)},'2026-11-30',null);UPDATE players SET team_id=${q(v.teams[newTeam].id)} WHERE id=${q(p.id)};`);p.team=newTeam}}
  const missing=week===3?[0]:week===10?[14,15]:[]
  let submissions='';const expectedInsertions=[]
  for(let team=0;team<teamCount;team++){
   const members=v.players.filter(p=>p.team===team), active=members.filter(p=>!missing.includes(v.players.indexOf(p)))
   const entries=active.map(p=>({player_id:id(p.id),hole_scores:holes(v,week,v.players.indexOf(p))}))
   if(!entries.length)continue
   if(active.length===2){submissions+=`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL "request.jwt.claim.sub"=${q(active[0].user)};SELECT submit_scores(${q(event)},${json(entries)});COMMIT;BEGIN;SET LOCAL ROLE authenticated;SET LOCAL "request.jwt.claim.sub"=${q(active[0].user)};SELECT submit_scores(${q(event)},${json(entries)});COMMIT;`;expectedInsertions.push(2,0)
   }else await call(v.admin,`admin_upsert_score(${q(event)},${json(entries)})`)
   active.forEach((p,i)=>remember(event,v,p,entries[i].hole_scores))
  }
  const submitted=(await sql(submissions)).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line).inserted)
  equal(submitted,expectedInsertions,'All team submissions insert twice, all separate-transaction retries insert zero')
  if(week===4){const members=v.players.filter(p=>p.team===1),entries=members.map(p=>({player_id:id(p.id),hole_scores:holes(v,week,v.players.indexOf(p))}));const [s]=await rows(`SELECT id FROM scores WHERE event_id=${q(event)} AND player_id=${q(members[0].id)} AND status='pending'`);await call(v.admin,`admin_review_score('${s.id}','rejected')`);equal(JSON.parse(await call(members[0].user,`submit_scores(${q(event)},${json(entries)})`)).inserted,1,'Half-team rejection safely resubmits only rejected player')}
  // Test the ordinary player cannot close the round.
  await assert.rejects(call(v.players[0].user,`publish_week(${q(event)})`),/Admin access/);assertions++
  await assert.rejects(call(v.admin,`publish_week(${q(event)})`),/pending/);assertions++
  await call(v.admin,`admin_bulk_approve_scores(${q(event)})`)
  // Substitute covered a regular player; mirrored history must not count twice.
  if(week===6){const p=v.players[4],subId=9000+v.n,subHcp=6,card=Array(9).fill(5);await sql(`INSERT INTO players(id,location_id,name,handicap) VALUES(${q(subId)},${q(v.n)},'Test substitute',6)`);await call(v.admin,`admin_upsert_score(${q(event)},${json([{player_id:id(p.id),hole_scores:card,handicap_used:subHcp,sub_played:true},{player_id:id(subId),hole_scores:card,handicap_used:subHcp}])})`);p.history=p.history.filter(r=>r.event!==event);remember(event,v,p,card,'played',true,subHcp)}
  missing.forEach(i=>remember(event,v,v.players[i],null,'missed_penalty'))
  const published=JSON.parse(await call(v.admin,`publish_week(${q(event)})`))
  equal(published.penalties_added,missing.length,'Exactly the missing players get penalties')
  equal(published.next_event_id,week===12?null:id(event+1),'Bye weeks are skipped and final week opens no extra round')
  equal(JSON.parse(await call(v.admin,`publish_week(${q(event)})`)).already_closed,true,'Repeat closeout is harmless')
  // Correction uses the stored handicap, preserving the original round basis.
  if(week===8){const old=v.n*100000+2,p=v.players[3],card=Array(9).fill(4),before=expected.get(recordKey(old,p.id));await call(v.admin,`admin_upsert_score(${q(old)},${json([{player_id:id(p.id),hole_scores:card,handicap_used:before.handicap_used}])})`);p.history=p.history.filter(r=>r.event!==old);const gross=36;const hist={event:old,diff:0};p.history.push(hist);p.history.sort((a,b)=>a.event-b.event);expected.set(recordKey(old,p.id),{...before,hole_scores:card,gross_total:gross,net_total:gross-before.handicap_used})}
  await call(v.admin,`recalculate_player_handicap(${q(v.players[0].id)})`)
  await sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL "request.jwt.claim.sub"=${q(v.admin)};${v.players.map(p=>`SELECT recalculate_player_handicap(${q(p.id)});`).join('')}COMMIT;`);for(const p of v.players){const predicted=handicap(p.history);if(predicted!==null)p.handicap=predicted}
  const actualPlayers=await rows(`SELECT id,handicap FROM players WHERE location_id=${q(v.n)} AND user_id IS NOT NULL`)
  for(const p of v.players)equal(Number(actualPlayers.find(a=>a.id===id(p.id)).handicap),p.handicap,'Database handicap matches independent discard/90% calculation')
  equal(await sql(`SELECT count(*) FROM scores WHERE event_id=${q(event)} AND status='pending'`),'0','No scores remain unreviewed after closeout')
  weekState.set(`${v.n}:${week}`,v.players.map(p=>({player:id(p.id),handicap:p.handicap})))
  checkLog.push({venue:v.name,week,checks:'passed'})
  console.log(`PASS ${v.name} week ${week}: submissions, review, penalties, advance, handicap`)
 }
 // Every effective roster score must match the independent expected ledger.
 const actual=await rows(`SELECT * FROM scores WHERE status='verified' ORDER BY event_id,player_id`),roster=await rows('SELECT event_id,player_id,team_id FROM roster_at'),teams=venues.flatMap(v=>v.teams.map(t=>({...t,id:id(t.id)})))
 for(const [key,e] of expected){const a=actual.find(s=>`${s.event_id}:${s.player_id}`===key);assert.ok(a,`Missing ${key}`);assertions++;for(const field of ['gross_total','net_total','handicap_used','entry_type','sub_played','hole_scores','team_id'])equal(a[field],e[field],`Round ${key}: ${field}`)}
 const snapshots=[]
 for(const v of venues)for(let week=1;week<=12;week++){
  const eventId=id(v.n*100000+week),eligible=actual.filter(s=>s.event_id<=eventId&&s.location_id===id(v.n)),eligibleRoster=roster.filter(r=>r.event_id<=eventId&&eligible.some(s=>s.event_id===r.event_id))
  const result=aggregateSeason(eligible,teams,eligibleRoster).sort((a,b)=>a.teamNet-b.teamNet)
  const oracle=new Map()
  for(const e of expected.values())if(e.event_id<=eventId&&e.event_id.startsWith(id(v.n*100000).slice(0,-6))&&Number(e.event_id.slice(-12))>=v.n*100000&&Number(e.event_id.slice(-12))<v.n*100000+100){oracle.set(e.team_id,(oracle.get(e.team_id)||0)+e.net_total)}
  for(const row of result)equal(row.teamNet,oracle.get(row.teamId),'Season standings retain historical team attribution and exclude sub mirror')
  const weekScores=actual.filter(s=>s.event_id===eventId&&roster.some(r=>r.event_id===s.event_id&&r.player_id===s.player_id))
  const cards=Object.fromEntries(weekScores.filter(s=>s.entry_type==='played').map(s=>[s.player_id,s.hole_scores]))
  const awarded=calcSkins(cards,9),skins=[]
  for(let h=0;h<9;h++){
    const candidates=weekScores.filter(s=>s.entry_type==='played').map(s=>({player:s.player_id,score:s.hole_scores[h]})).sort((a,b)=>a.score-b.score)
    const low=candidates[0]?.score,lowPlayers=candidates.filter(s=>s.score===low)
    const winner=lowPlayers.length===1?lowPlayers[0].player:null
    equal(awarded[h+1],winner,'Skins winner/tie matches independent sorted score oracle')
    skins.push({hole:(week%2?1:10)+h,low,tied:lowPlayers.length,winner:winner? v.players.find(p=>id(p.id)===winner)?.name:null,reason:winner?'Unique lowest gross score':'Tied lowest score — no skin',lowPlayers:lowPlayers.map(p=>v.players.find(vp=>id(vp.id)===p.player)?.name)})
  }
  const weekly=aggregateSeason(weekScores,teams,roster.filter(r=>r.event_id===eventId)).sort((a,b)=>a.teamNet-b.teamNet)
  // Match the app's displayed order: lowest net, then team name for equal totals.
  const ranked=values=>[...values].sort((a,b)=>a.teamNet-b.teamNet||a.teamName.localeCompare(b.teamName)).map((r,i)=>({team:r.teamName,teamId:r.teamId,rank:i+1,total:r.teamNet,gross:r.teamGross,rounds:r.rounds,average:r.avgNet}))
  snapshots.push({venue:v.name,week,startHole:week%2?1:10,rounds:weekScores.map(s=>({player:v.players.find(p=>id(p.id)===s.player_id)?.name,team:v.teams.find(t=>id(t.id)===s.team_id)?.name,type:s.entry_type,subPlayed:s.sub_played,gross:s.gross_total,handicap:s.handicap_used,net:s.net_total,expectedNet:expected.get(`${s.event_id}:${s.player_id}`).net_total,holes:s.hole_scores})),skins,weeklyStandings:ranked(weekly),standings:ranked(result),handicaps:weekState.get(`${v.n}:${week}`)})
 }
 // Switch working league to winter; recent history must include winter Week 1.
 for(const v of venues){const winter=v.league+10,event=v.n*100000+101;await sql(`UPDATE league_config SET is_working=false WHERE id=${q(v.league)};INSERT INTO league_config VALUES(${q(winter)},${q(v.n)},'Winter 2027',12,true);INSERT INTO events(id,location_id,league_id,course_id,status,week_number,start_date) VALUES(${q(event)},${q(v.n)},${q(winter)},${q(v.course)},'open',1,'2027-01-18');`)
  await sql(v.teams.map(t=>`INSERT INTO teams VALUES(${q(t.id+1000)},${q(v.n)},${q(winter)},'${t.name}');`).join('')+v.players.map(p=>`INSERT INTO team_memberships VALUES(${q(v.teams[p.team].id+1000)},${q(p.id)},${q(v.n)},${q(winter)},'2027-01-18',null);`).join(''));
  await call(v.admin,`admin_upsert_score(${q(event)},${json(v.players.map(p=>({player_id:id(p.id),hole_scores:Array(9).fill(8)})))})`);
  await sql(`BEGIN;SET LOCAL ROLE authenticated;SET LOCAL "request.jwt.claim.sub"=${q(v.admin)};${v.players.map(p=>`SELECT recalculate_player_handicap(${q(p.id)});`).join('')}COMMIT;`);
  const winterPlayers=await rows(`SELECT id,handicap FROM players WHERE location_id=${q(v.n)} AND user_id IS NOT NULL`);
  for(const p of v.players){p.history.push({event,diff:36});equal(Number(winterPlayers.find(a=>a.id===id(p.id)).handicap),handicap(p.history),'Winter week one feeds latest twelve rounds')}
  await call(v.admin,`publish_week(${q(event)})`)
  equal(await sql(`SELECT count(*) FROM events WHERE league_id=${q(v.league)} AND status='open'`),'0','Fall remains closed after winter begins')
 }
 const report={generated:new Date().toISOString(),scope:'Synthetic PostgreSQL function rehearsal; not production or full schema/RLS replay',venues:venues.map(v=>v.name),weeks:12,teamsPerVenue:teamCount,playersPerVenue:teamCount*2,verifiedRosterRounds:expected.size,assertions,skinsRule:'All roster golfers entered; unique lowest gross wins; tied lows cancel; no carryovers; substitute coverage counted once; cash pool unspecified',scenarios:['duplicate retry','partial rejection and resubmission','single missing player','whole team absent','substitute mirror','historical team swap','late correction','bye skip','final-week stop','fall-to-winter handicap history','player permission'],snapshots,checks:checkLog}
 fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/season-rehearsal.json'),JSON.stringify(report,null,2));console.log(`PASS entire season: ${expected.size} roster rounds, ${assertions} reconciliations; fall-to-winter checks passed`)
}finally{await run('dropdb',[...connection,db])}
