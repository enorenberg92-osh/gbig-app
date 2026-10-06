import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const report=JSON.parse(fs.readFileSync(path.join(root,'artifacts/season-rehearsal.json'),'utf8'))
const template=fs.readFileSync(path.join(root,'scripts/season-view.template.html'),'utf8')
// Retain every score and standings row, while removing repeated labels/UUIDs.
const players=[...new Set(report.snapshots.flatMap(s=>s.rounds.map(r=>r.player)))].sort()
const teams=[...new Set(report.snapshots.flatMap(s=>s.rounds.map(r=>r.team)))].sort()
const pIndex=new Map(players.map((p,i)=>[p,i])),tIndex=new Map(teams.map((t,i)=>[t,i]))
const compact={weeks:report.weeks,teams:report.teamsPerVenue,players:report.playersPerVenue,checks:report.assertions,names:players,teamNames:teams,venues:report.venues,
  snapshots:report.snapshots.map(s=>({venue:s.venue,week:s.week,startHole:s.startHole,
    rounds:s.rounds.map(r=>[pIndex.get(r.player),tIndex.get(r.team),r.type==='missed_penalty'?1:0,r.subPlayed?1:0,r.gross,r.handicap,r.net,r.expectedNet,r.holes]),
    skins:s.skins.map(h=>[h.hole,h.low,h.tied,h.winner?pIndex.get(h.winner):null,h.lowPlayers.map(p=>pIndex.get(p))]),
    standings:s.standings.map(r=>[tIndex.get(r.team),r.rank,r.total,r.gross,r.rounds,Number(r.average)]),
    weekly:s.weeklyStandings.map(r=>[tIndex.get(r.team),r.rank,r.total,r.gross,r.rounds,Number(r.average)]),
    handicaps:s.handicaps.map((h,i)=>[i,h.handicap])}))}
const output=template.replace('__SEASON_DATA__',JSON.stringify(compact).replaceAll('<','\\u003c'))
if(Buffer.byteLength(output)>1_000_000)throw new Error('Season view exceeds inline size limit')
const target=process.argv[2] || path.join(root,'artifacts/season-rehearsal.html')
fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);console.log(target)
