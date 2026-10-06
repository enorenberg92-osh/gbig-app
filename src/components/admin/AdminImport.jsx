import React, { useEffect, useRef, useState } from 'react'
import { Upload, RefreshCw, CheckCircle2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast } from '../ui'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { parseRosterCSV } from '../../lib/rosterImport'
import { finishLeagueRegistrations, loadLeagueRegistrations, registrationSummary } from '../../lib/leagueRegistration'
import './AdminImport.css'

export default function AdminImport({ leagueId, leagueName }) {
  const { locationId, appName } = useLocation()
  const [rows,setRows] = useState([]), [selected,setSelected] = useState(new Set())
  const [fileName,setFileName] = useState(''), [warnings,setWarnings] = useState([])
  const [verified,setVerified] = useState(false), [rosterVerified,setRosterVerified] = useState(false)
  const [busy,setBusy] = useState(false), [progress,setProgress] = useState('')
  const [error,setError] = useState(''), [results,setResults] = useState(null)
  const [jobs,setJobs] = useState([]), [queueError,setQueueError] = useState(''), [toast,setToast] = useState(null)
  const fileRef = useRef(), mounted = useRef(true), scopeRef = useRef('')
  scopeRef.current=`${locationId}:${leagueId}`
  const isCurrent=()=>mounted.current&&scopeRef.current===`${locationId}:${leagueId}`
  useEffect(() => { mounted.current=true; return () => {mounted.current=false} },[])
  useEffect(() => { setJobs([]);setQueueError('');loadJobs().catch(()=>{});setRows([]);setSelected(new Set());setVerified(false);setRosterVerified(false);setResults(null);setBusy(false);setProgress('');setFileName('');setWarnings([]);setError('');if(fileRef.current)fileRef.current.value='' },[leagueId,locationId])
  async function loadJobs() {
    try { const loaded=await loadLeagueRegistrations(supabase,leagueId,locationId); if(isCurrent()){setJobs(loaded);setQueueError('')} return loaded }
    catch(e){if(isCurrent())setQueueError(mutationErrorMessage(e,'finish league registration'));throw e}
  }
  function showToast(msg,type='success'){if(isCurrent())setToast({msg,type})}
  async function handleFile(event) {
    const file=event.target.files?.[0]
    if(!file)return
    setFileName(file.name);setVerified(false);setResults(null)
    try {
      const parsed=parseRosterCSV(await file.text())
      setRows(parsed.rows);setWarnings(parsed.warnings);setError(parsed.error || '')
      setSelected(new Set(parsed.rows.flatMap((row,i)=>row.issues.length?[]:[i])))
    } catch(e){setError('The file could not be read. Export the roster as CSV and try again.');setRows([])}
  }
  function toggleRow(index){setSelected(prev=>{const next=new Set(prev);next.has(index)?next.delete(index):next.add(index);return next})}
  function clear(){setRows([]);setSelected(new Set());setResults(null);setError('');setWarnings([]);setFileName('');setVerified(false);if(fileRef.current)fileRef.current.value=''}
  async function finish(ids) {
    await finishLeagueRegistrations(supabase,leagueId,ids,(done,total)=>{if(isCurrent())setProgress(`Preparing app access and welcome emails: ${done} of ${total} golfers`)})
  }
  async function handleImport() {
    if(!leagueId||!verified||!selected.size)return
    setBusy(true);setError('');const successes=[],failures=[],retryIds=[]
    try {
      const chosen=rows.filter((_,i)=>selected.has(i))
      for(let i=0;i<chosen.length;i++) {
        const row=chosen[i]
        if(isCurrent())setProgress(`Saving partnership ${i+1} of ${chosen.length}`)
        const {data,error:rpcError}=await supabase.functions.invoke('register-import-team',{body:{league_id:leagueId,payload:{team_name:row.teamName,day:row.day,time:row.time,players:[row.p1,row.p2].map(p=>({name:p.fullName,first_name:p.firstName,last_name:p.lastName,email:p.email||null,handicap:p.handicap,phone:p.phone}))}}})
        if(rpcError||data?.error) {
          let message=data?.error
          if(!message&&rpcError?.context?.json)try{message=(await rpcError.context.json()).error}catch{}
          failures.push({team:row.teamName,message:message||mutationErrorMessage(rpcError,'import this partnership')})
        } else { successes.push({team:row.teamName,reused:data.reused});if(data.onboarding_error)retryIds.push(...data.player_ids) }
      }
      if(isCurrent())setResults({successes,failures})
      if(retryIds.length)await finish(retryIds)
      showToast(`${successes.length} partnerships saved. Check registration status below.`,failures.length?'error':'success')
    } catch(e){if(isCurrent()){setResults({successes,failures});setError(`Saved partnerships remain on the roster. ${e.message} Use Retry pending registrations below.`)}}
    finally {try{await loadJobs()}catch{}if(isCurrent()){setBusy(false);setProgress('')}}
  }
  async function registerRoster() {
    if(!leagueId||!rosterVerified)return
    setBusy(true);setError('')
    try {
      const {error:rpcError}=await supabase.rpc('admin_queue_league_onboarding',{p_league_id:leagueId})
      if(rpcError)throw rpcError
      const queued=await loadJobs()
      await finish(queued.filter(j=>j.account_status!=='ready'||!['sent','review'].includes(j.email_status)).map(j=>j.player_id))
    } catch(e){if(isCurrent())setError(mutationErrorMessage(e,'finish league registration'))}
    finally {try{await loadJobs()}catch{}if(isCurrent()){setBusy(false);setProgress('')}}
  }
  const summary=registrationSummary(jobs)
  const validIndices=rows.flatMap((r,i)=>r.issues.length?[]:[i])
  return <div className="league-import">
    <Toast toast={toast}/>
    <header><h2>Import and welcome league players</h2><p>{appName}{leagueName?` · ${leagueName}`:''}</p></header>
    {!leagueId&&<p className="import-error" role="alert">Choose a working session in Leagues first.</p>}
    <section className="import-panel">
      <h3>Start with your verified roster</h3>
      <p>Upload a CSV, check the partnerships, then import. App accounts are prepared automatically and each golfer receives a welcome email when email sending is connected.</p>
      <p>New app accounts use the golfer’s email and <strong>password</strong>, all lowercase. Existing app passwords stay the same.</p>
      <label className="import-upload"><Upload size={24}/><span>{fileName||'Choose roster CSV'}</span><input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} disabled={busy||!leagueId}/></label>
      <details><summary>Which columns can I use?</summary><p>One row per partnership: Player 1 Name, Player 1 Email, Player 1 Handicap, Player 2 Name, Player 2 Email, Player 2 Handicap. Day, Time, and phone columns are optional.</p><p>One row per golfer: First Name, Last Name, Email, Index, and Team ID. Use the same team ID for both partners. Existing website signup CSVs also work.</p><p>Handicaps are whole-number 9-hole league handicaps. Export Excel or the roster tab in Google Sheets as CSV before uploading.</p></details>
    </section>
    {error&&<p className="import-error" role="alert">{error}</p>}
    {warnings.map((warning,i)=><p className="import-note" key={i}>{warning}</p>)}
    {rows.length>0&&!results&&<section className="import-panel">
      <div className="import-preview-heading"><h3>Check {rows.length} partnerships</h3><Button variant="ghost" disabled={busy} onClick={()=>setSelected(selected.size===validIndices.length?new Set():new Set(validIndices))}>{selected.size===validIndices.length?'Deselect all':'Select valid partnerships'}</Button></div>
      {rows.map((row,index)=><div className="import-partnership" key={index}>
        <label className="import-pair-choice"><input type="checkbox" checked={selected.has(index)} onChange={()=>toggleRow(index)} disabled={busy||row.issues.length>0}/><strong>{row.teamName||`Row ${row.rowNumber}`}</strong>{row.slot&&<span>{row.slot}</span>}</label>
        {[row.p1,row.p2].map((p,i)=><div className="import-player" key={i}><span>{p.fullName||'Partner missing'}</span><span>{p.email||'No email'}</span><span>HCP {p.handicap??'missing'}</span></div>)}
        {row.issues.map((issue,i)=><p className="import-row-error" key={i}>{issue}</p>)}
        {row.warnings.map((warning,i)=><p className="import-row-note" key={i}>{warning}</p>)}
      </div>)}
      <label className="import-confirm"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)} disabled={busy}/><span>I have checked these golfers, partnerships, emails, and 9-hole handicaps for <strong>{leagueName||'this session'}</strong>. Send their welcome emails.</span></label>
      <div className="import-actions"><Button disabled={!verified||!selected.size||!leagueId} loading={busy} loadingText="Registering…" onClick={handleImport}>Import and register {selected.size} teams</Button><Button variant="secondary" disabled={busy} onClick={clear}>Clear file</Button></div>
    </section>}
    {progress&&<p className="import-progress" role="status" aria-live="polite">{progress}</p>}
    {results&&<section className="import-panel"><h3>Partnership results</h3><p><CheckCircle2 size={17}/> {results.successes.length} saved · {results.failures.length} need attention</p><p>Importing an existing partnership again reuses its roster entries.</p>{results.failures.map((f,i)=><p className="import-row-error" key={i}><strong>{f.team}:</strong> {f.message}</p>)}<Button variant="secondary" disabled={busy} onClick={clear}>Choose another file</Button></section>}
    <section className="import-panel">
      <h3>App access and welcome emails</h3>
      {queueError?<p className="import-error" role="alert">{queueError}</p>:<>
        {summary.total>0?<><p><strong>{summary.ready} of {summary.total}</strong> golfers have app access. <strong>{summary.sent}</strong> welcome emails sent.</p>{summary.waiting>0&&<p className="import-note">{summary.waiting} welcome emails are waiting for the email service to be connected. Their app accounts are ready.</p>}{summary.needsEmail>0&&<p className="import-note">{summary.needsEmail} golfers need a valid email in Players &amp; Teams before they can sign in.</p>}{jobs.filter(j=>j.account_error||['error','review'].includes(j.email_status)).map(j=><p className="import-row-error" key={j.id}><strong>{j.player?.name||'Golfer'}:</strong> {j.account_error||j.email_error}</p>)}</>:<p>No registrations have been queued for this session yet.</p>}
        <p>If players are already on the roster, register everyone here in one step. Completed welcomes are skipped.</p>
        <label className="import-confirm"><input type="checkbox" checked={rosterVerified} onChange={e=>setRosterVerified(e.target.checked)} disabled={busy}/><span>The current {leagueName||'league'} roster has been verified and is ready to welcome.</span></label>
        <Button variant="secondary" icon={<RefreshCw size={16}/>} disabled={!rosterVerified||!leagueId} loading={busy} loadingText="Registering…" onClick={registerRoster}>{summary.total?'Retry pending registrations':'Register verified roster'}</Button>
      </>}
    </section>
  </div>
}
