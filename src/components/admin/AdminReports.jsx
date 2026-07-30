import React, { useState, useEffect } from 'react'
import { Printer, Download, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { calcSkins } from '../../lib/skinsUtils'
import { compareEffectiveScores } from '../../lib/roundUtils'
import { Button, Toast } from '../ui'

// ─────────────────────────────────────────────────────────────────────────────
//  AdminReports — Phase 5.3. Week recap + printable standings + money list,
//  all through browser print (print CSS in index.css); CSV export via Blob.
// ─────────────────────────────────────────────────────────────────────────────

function downloadCsv(filename, rows) {
  // rows: array of arrays; first row = header.
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function AdminReports() {
  const { locationId, appName } = useLocation()
  const [league, setLeague]   = useState(null)
  const [events, setEvents]   = useState([])
  const [players, setPlayers] = useState([])
  const [teams, setTeams]     = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast]     = useState(null)

  const [recapEvent, setRecapEvent] = useState('')
  const [report, setReport]         = useState(null)  // { kind, ...data }

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    let lg
    try { lg = await loadWorkingLeague(supabase, locationId) }
    catch (e) { showToast(e.message, 'error'); setLoading(false); return }
    setLeague(lg)
    const [ev, pl, tm] = await Promise.all([
      supabase.from('events').select('id, name, week_number, status, course_id, start_date')
        .eq('location_id', locationId).eq('league_id', lg.id).neq('is_bye', true).order('week_number'),
      supabase.from('players').select('id, name, first_name, last_name, email, handicap, in_skins, is_sub, team_id')
        .eq('location_id', locationId).order('name'),
      supabase.from('teams').select('id, name, flight_id').eq('location_id', locationId).eq('league_id', lg.id).order('created_at'),
    ])
    setEvents(ev.data || [])
    setPlayers(pl.data || [])
    setTeams(tm.data || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const playerName = id => players.find(p => p.id === id)?.name || '?'
  const teamName = id => teams.find(t => t.id === id)?.name || '?'
  const closedEvents = events.filter(e => e.status === 'closed')

  // ── Season standings through a given week (rank by team net) ───────────────
  async function standingsThrough(maxWeek) {
    const ids = closedEvents.filter(e => maxWeek == null || (e.week_number ?? 0) <= maxWeek).map(e => e.id)
    if (!ids.length) return []
    const { data: scoreRows } = await supabase.from('scores')
      .select('player_id, team_id, event_id, gross_total, net_total, entry_type, status, created_at')
      .in('event_id', ids).eq('location_id', locationId).eq('status', 'verified')
    const byTeam = {}
    const seen = {} // one effective score per player per event
    ;(scoreRows || []).sort(compareEffectiveScores).forEach(s => {
      const key = `${s.event_id}:${s.player_id}`
      if (seen[key] || !s.team_id) return
      seen[key] = true
      if (!byTeam[s.team_id]) byTeam[s.team_id] = { gross: 0, net: 0, rounds: 0 }
      byTeam[s.team_id].gross += s.gross_total || 0
      byTeam[s.team_id].net += s.net_total || 0
      byTeam[s.team_id].rounds++
    })
    return teams
      .filter(t => byTeam[t.id])
      .map(t => ({ teamId: t.id, name: t.name, ...byTeam[t.id] }))
      .sort((a, b) => a.net - b.net)
  }

  // ── Week recap ──────────────────────────────────────────────────────────────
  async function buildRecap() {
    const evt = events.find(e => e.id === recapEvent)
    if (!evt) return
    const [{ data: scoreRows }, { data: courseRow }, { data: matchupRows }] = await Promise.all([
      supabase.from('scores').select('player_id, team_id, gross_total, net_total, entry_type, status, hole_scores, created_at')
        .eq('event_id', evt.id).eq('location_id', locationId).eq('status', 'verified'),
      evt.course_id
        ? supabase.from('courses').select('name, num_holes, total_par').eq('id', evt.course_id).eq('location_id', locationId).single()
        : Promise.resolve({ data: null }),
      supabase.from('matchups').select('*').eq('event_id', evt.id).eq('location_id', locationId).eq('status', 'scored'),
    ])

    // Team results for the night
    const byTeam = {}
    const seen = {}
    ;(scoreRows || []).sort(compareEffectiveScores).forEach(s => {
      const key = s.player_id
      if (seen[key] || !s.team_id) return
      seen[key] = true
      if (!byTeam[s.team_id]) byTeam[s.team_id] = { gross: 0, net: 0, players: [] }
      byTeam[s.team_id].gross += s.gross_total || 0
      byTeam[s.team_id].net += s.net_total || 0
      byTeam[s.team_id].players.push({
        name: playerName(s.player_id),
        gross: s.gross_total, net: s.net_total,
        missed: s.entry_type === 'missed_penalty',
      })
    })
    const results = teams.filter(t => byTeam[t.id])
      .map(t => ({ name: t.name, ...byTeam[t.id] }))
      .sort((a, b) => a.net - b.net)

    // Skins
    const inSkins = new Set(players.filter(p => p.in_skins).map(p => p.id))
    const scoreMap = {}
    ;(scoreRows || []).forEach(s => {
      if (s.entry_type === 'played' && inSkins.has(s.player_id) && Array.isArray(s.hole_scores)) {
        scoreMap[s.player_id] = s.hole_scores
      }
    })
    const skinsMap = calcSkins(scoreMap, courseRow?.num_holes || 9)
    const skins = Object.entries(skinsMap)
      .filter(([, pid]) => pid)
      .map(([hole, pid]) => ({ hole, name: playerName(pid) }))

    // Standings movement vs prior week
    const [now, prior] = await Promise.all([
      standingsThrough(evt.week_number),
      standingsThrough((evt.week_number ?? 1) - 1),
    ])
    const priorRank = {}
    prior.forEach((r, i) => { priorRank[r.teamId] = i + 1 })
    const movement = now.map((r, i) => ({
      ...r, rank: i + 1,
      delta: priorRank[r.teamId] ? priorRank[r.teamId] - (i + 1) : null,
    }))

    const matchResults = (matchupRows || []).map(m => ({
      home: m.home_team_id ? teamName(m.home_team_id) : playerName(m.home_player_id),
      away: m.away_team_id ? teamName(m.away_team_id) : playerName(m.away_player_id),
      ph: Number(m.points_home), pa: Number(m.points_away),
      noShow: m.result?.no_show,
    }))

    setReport({ kind: 'recap', evt, course: courseRow, results, skins, movement, matchResults })
  }

  async function buildStandings() {
    const rows = await standingsThrough(null)
    setReport({ kind: 'standings', rows })
  }

  // ── Attendance: players × closed weeks (P played, S sub covered, M missed) ─
  async function buildAttendance() {
    const ids = closedEvents.map(e => e.id)
    if (!ids.length) { showToast('No closed weeks yet.', 'error'); return }
    const [{ data: scoreRows }, { data: subRows }] = await Promise.all([
      supabase.from('scores').select('player_id, event_id, entry_type, sub_played')
        .in('event_id', ids).eq('location_id', locationId).eq('status', 'verified'),
      supabase.from('subs').select('player_id, event_id').in('event_id', ids)
        .eq('location_id', locationId).eq('status', 'approved'),
    ])
    const cell = {}
    ;(scoreRows || []).forEach(s => {
      const key = `${s.player_id}:${s.event_id}`
      if (s.entry_type === 'missed_penalty') { cell[key] = cell[key] || 'M' }
      else if (s.entry_type === 'played') { cell[key] = s.sub_played ? 'S' : 'P' }
    })
    ;(subRows || []).forEach(s => {
      const key = `${s.player_id}:${s.event_id}`
      if (cell[key] === 'P' || !cell[key]) cell[key] = 'S'
    })
    const rows = players.filter(p => !p.is_sub).map(p => ({
      name: p.name,
      cells: closedEvents.map(e => cell[`${p.id}:${e.id}`] || ''),
      played: closedEvents.filter(e => cell[`${p.id}:${e.id}`] === 'P').length,
    }))
    setReport({ kind: 'attendance', weeks: closedEvents, rows })
  }

  async function buildMoney() {
    const { data: entries } = await supabase.from('ledger').select('*')
      .eq('location_id', locationId).eq('league_id', league.id).order('created_at')
    const balances = {}
    ;(entries || []).forEach(e => {
      const name = e.player_id ? playerName(e.player_id) : teamName(e.team_id)
      balances[name] = (balances[name] || 0) + Number(e.amount)
    })
    const rows = Object.entries(balances).map(([name, amt]) => ({ name, amt })).sort((a, b) => b.amt - a.amt)
    setReport({ kind: 'money', rows, entries: entries || [] })
  }

  // ── CSV exports ─────────────────────────────────────────────────────────────
  function exportPlayers() {
    downloadCsv('players.csv', [
      ['Name', 'First', 'Last', 'Email', 'Handicap', 'Team', 'In skins', 'Sub'],
      ...players.map(p => [p.name, p.first_name, p.last_name, p.email, p.handicap, teamName(p.team_id) === '?' ? '' : teamName(p.team_id), p.in_skins ? 'yes' : '', p.is_sub ? 'yes' : '']),
    ])
  }

  async function exportScores() {
    const ids = events.map(e => e.id)
    if (!ids.length) return
    const { data: scoreRows } = await supabase.from('scores')
      .select('player_id, team_id, event_id, gross_total, net_total, handicap_used, entry_type, status, sub_played, hole_scores')
      .in('event_id', ids).eq('location_id', locationId)
    const evtById = {}
    events.forEach(e => { evtById[e.id] = e })
    downloadCsv('scores.csv', [
      ['Week', 'Event', 'Player', 'Team', 'Gross', 'Net', 'Hcp used', 'Type', 'Status', 'Sub played', 'Hole scores'],
      ...(scoreRows || []).map(s => {
        const e = evtById[s.event_id] || {}
        return [e.week_number, e.name, playerName(s.player_id), s.team_id ? teamName(s.team_id) : '',
          s.gross_total, s.net_total, s.handicap_used, s.entry_type, s.status,
          s.sub_played ? 'yes' : '', Array.isArray(s.hole_scores) ? s.hole_scores.join(' ') : '']
      }),
    ])
  }

  async function exportStandings() {
    const rows = await standingsThrough(null)
    downloadCsv('standings.csv', [
      ['Rank', 'Team', 'Rounds', 'Gross', 'Net'],
      ...rows.map((r, i) => [i + 1, r.name, r.rounds, r.gross, r.net]),
    ])
  }

  async function exportLedger() {
    const { data: entries } = await supabase.from('ledger').select('*')
      .eq('location_id', locationId).eq('league_id', league.id).order('created_at')
    downloadCsv('ledger.csv', [
      ['Date', 'Who', 'Type', 'Amount', 'Note'],
      ...(entries || []).map(e => [
        e.created_at?.slice(0, 10), e.player_id ? playerName(e.player_id) : teamName(e.team_id),
        e.type, e.amount, e.note,
      ]),
    ])
  }

  if (loading) return <div style={st.loading}>Loading…</div>

  return (
    <div style={st.container}>
      <Toast toast={toast} />

      {/* Builders */}
      <div style={{ ...st.card }} className="no-print">
        <h3 style={st.cardTitle}>Reports</h3>
        <div style={st.row}>
          <select style={{ ...st.input, flex: 1 }} value={recapEvent} onChange={e => setRecapEvent(e.target.value)}>
            <option value="">— closed week —</option>
            {closedEvents.map(e => (
              <option key={e.id} value={e.id}>{e.week_number != null ? `Wk ${e.week_number} — ` : ''}{e.name}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={buildRecap} disabled={!recapEvent}>Week recap</Button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" onClick={buildStandings}>Standings report</Button>
          <Button variant="secondary" size="sm" onClick={buildMoney}>Money list</Button>
          <Button variant="secondary" size="sm" onClick={buildAttendance}>Attendance grid</Button>
          {report && (
            <Button variant="primary" size="sm" icon={<Printer size={14} strokeWidth={2.25} />} onClick={() => window.print()}>
              Print
            </Button>
          )}
        </div>
      </div>

      {/* CSV exports */}
      <div style={st.card} className="no-print">
        <h3 style={st.cardTitle}>CSV Export</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[['Players', exportPlayers], ['Scores', exportScores], ['Standings', exportStandings], ['Ledger', exportLedger]].map(([label, fn]) => (
            <Button key={label} variant="secondary" size="sm" icon={<Download size={13} strokeWidth={2.25} />} onClick={fn}>
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Rendered report (print area) */}
      {report && (
        <div style={st.card} className="print-area">
          <div style={st.reportHeader}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{appName || 'League'}</div>
            <div style={{ fontSize: 12, color: '#555' }}>
              {league?.name}
              {report.kind === 'recap' && ` — ${report.evt.week_number != null ? `Week ${report.evt.week_number}: ` : ''}${report.evt.name}`}
              {report.kind === 'standings' && ' — Season Standings'}
              {report.kind === 'money' && ' — Money List'}
              {report.kind === 'attendance' && ' — Attendance'}
            </div>
          </div>

          {report.kind === 'recap' && (
            <>
              <h4 style={st.h4}>Results{report.course ? ` — ${report.course.name} (Par ${report.course.total_par})` : ''}</h4>
              <table style={st.table}>
                <thead><tr>{['#', 'Team', 'Players', 'Gross', 'Net'].map(h => <th key={h} style={st.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {report.results.map((r, i) => (
                    <tr key={r.name}>
                      <td style={st.td}>{i + 1}</td>
                      <td style={st.td}>{r.name}</td>
                      <td style={st.td}>{r.players.map(p => `${p.name}${p.missed ? ' (missed)' : ''} ${p.gross ?? ''}`).join(', ')}</td>
                      <td style={st.td}>{r.gross}</td>
                      <td style={{ ...st.td, fontWeight: 700 }}>{r.net}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {report.matchResults.length > 0 && (
                <>
                  <h4 style={st.h4}>Matches</h4>
                  <table style={st.table}>
                    <tbody>
                      {report.matchResults.map((m, i) => (
                        <tr key={i}>
                          <td style={st.td}>{m.home} vs {m.away}</td>
                          <td style={{ ...st.td, fontWeight: 700 }}>{m.ph}–{m.pa}{m.noShow ? ' (no-show)' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h4 style={st.h4}>Skins</h4>
              {report.skins.length === 0
                ? <p style={{ fontSize: 12 }}>No skins won.</p>
                : (
                  <table style={st.table}>
                    <tbody>
                      {report.skins.map(s => (
                        <tr key={s.hole}><td style={st.td}>Hole {s.hole}</td><td style={{ ...st.td, fontWeight: 700 }}>{s.name}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}

              <h4 style={st.h4}>Standings After This Week</h4>
              <table style={st.table}>
                <thead><tr>{['#', 'Team', 'Net', 'Move'].map(h => <th key={h} style={st.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {report.movement.map(r => (
                    <tr key={r.teamId}>
                      <td style={st.td}>{r.rank}</td>
                      <td style={st.td}>{r.name}</td>
                      <td style={st.td}>{r.net}</td>
                      <td style={{ ...st.td, fontWeight: 700 }}>
                        {r.delta == null || r.delta === 0 ? '—' : r.delta > 0 ? `▲${r.delta}` : `▼${-r.delta}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {report.kind === 'standings' && (
            <table style={st.table}>
              <thead><tr>{['#', 'Team', 'Rounds', 'Gross', 'Net'].map(h => <th key={h} style={st.th}>{h}</th>)}</tr></thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={r.teamId}>
                    <td style={st.td}>{i + 1}</td>
                    <td style={st.td}>{r.name}</td>
                    <td style={st.td}>{r.rounds}</td>
                    <td style={st.td}>{r.gross}</td>
                    <td style={{ ...st.td, fontWeight: 700 }}>{r.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {report.kind === 'attendance' && (
            <>
              <p style={{ fontSize: 10, margin: '2px 0 6px' }}>P = played · S = sub covered · M = missed (penalty)</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={st.table}>
                  <thead>
                    <tr>
                      <th style={st.th}>Player</th>
                      {report.weeks.map(w => <th key={w.id} style={{ ...st.th, textAlign: 'center' }}>W{w.week_number ?? '?'}</th>)}
                      <th style={{ ...st.th, textAlign: 'center' }}>Played</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map(r => (
                      <tr key={r.name}>
                        <td style={st.td}>{r.name}</td>
                        {r.cells.map((c, i) => (
                          <td key={i} style={{ ...st.td, textAlign: 'center', fontWeight: 700,
                            color: c === 'P' ? '#1a7a3a' : c === 'S' ? '#b45309' : c === 'M' ? '#c02020' : '#bbb' }}>
                            {c || '·'}
                          </td>
                        ))}
                        <td style={{ ...st.td, textAlign: 'center', fontWeight: 700 }}>{r.played}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {report.kind === 'money' && (
            <>
              <h4 style={st.h4}>Balances</h4>
              <table style={st.table}>
                <thead><tr>{['Who', 'Balance'].map(h => <th key={h} style={st.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {report.rows.map(r => (
                    <tr key={r.name}>
                      <td style={st.td}>{r.name}</td>
                      <td style={{ ...st.td, fontWeight: 700 }}>{r.amt > 0 ? '+' : ''}{r.amt.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4 style={st.h4}>All Entries</h4>
              <table style={st.table}>
                <thead><tr>{['Date', 'Who', 'Type', 'Amount', 'Note'].map(h => <th key={h} style={st.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {report.entries.map(e => (
                    <tr key={e.id}>
                      <td style={st.td}>{e.created_at?.slice(0, 10)}</td>
                      <td style={st.td}>{e.player_id ? playerName(e.player_id) : teamName(e.team_id)}</td>
                      <td style={st.td}>{e.type}</td>
                      <td style={st.td}>{Number(e.amount).toFixed(2)}</td>
                      <td style={st.td}>{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {!report && (
        <div style={{ ...st.card, textAlign: 'center', color: 'var(--gray-400)', fontSize: 13 }} className="no-print">
          <FileText size={30} strokeWidth={1.5} style={{ margin: '0 auto 8px' }} />
          Build a report above, then print it.
        </div>
      )}
    </div>
  )
}

const st = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column', gap: 10 },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  input: { padding: '9px 11px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '13px', background: 'var(--gray-100)', color: 'var(--black)' },
  reportHeader: { borderBottom: '2px solid #333', paddingBottom: 8, marginBottom: 4 },
  h4: { fontSize: 13, fontWeight: 800, margin: '10px 0 4px', textTransform: 'uppercase', letterSpacing: '0.4px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1.5px solid #333', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.4px' },
  td: { padding: '4px 6px', borderBottom: '1px solid #ddd' },
}
