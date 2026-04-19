import React, { useState, useEffect } from 'react'
import {
  Users, Handshake, Calendar, Zap,
  CheckCircle2, Square, Check, Clipboard, Mail, Lock,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'

const STEPS = [
  { id: 'scores',  label: 'Review scores', num: 1 },
  { id: 'skins',   label: 'Skins',         num: 2 },
  { id: 'results', label: 'Results',        num: 3 },
  { id: 'email',   label: 'Weekly email',  num: 4 },
  { id: 'publish', label: 'Lock & publish', num: 5 },
]

function generateEmail(evt, scores, teams, players, skins, appName = 'Golf League App') {
  const evtName = evt.name || evt.title || `Event ${evt.week_number || ''}`
  const date = evt.start_date
    ? new Date(evt.start_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : ''

  // Build player→team map (scores may only have player_id, not team_id)
  const plrTeamMap = {}
  teams.forEach(t => {
    if (t.player1_id) plrTeamMap[t.player1_id] = t
    if (t.player2_id) plrTeamMap[t.player2_id] = t
  })
  const byTeam = {}
  scores.forEach(s => {
    const team = s.team_id ? teams.find(t => t.id === s.team_id) : plrTeamMap[s.player_id]
    if (!team) return
    if (!byTeam[team.id]) byTeam[team.id] = { team, gross: 0, net: 0 }
    byTeam[team.id].gross += s.gross_total || 0
    byTeam[team.id].net   += s.net_total   || 0
  })
  const sorted = Object.values(byTeam).sort((a, b) => a.net - b.net)
  const top3 = sorted.slice(0, 3).map((r, i) =>
    `  ${i + 1}. ${r.team.name || 'Unknown'} — Net ${r.net} / Gross ${r.gross}`
  ).join('\n')

  const skinLines = skins.length > 0
    ? skins.map(sk => `  Hole ${sk.hole}: ${sk.playerName}`).join('\n')
    : '  No skins this week'

  return `Hi everyone,

Great playing this week! Here's your recap for ${evtName}${date ? ` — ${date}` : ''}.

TOP FINISHERS
${top3 || '  Results pending'}

SKINS WINNERS
${skinLines}

See the full standings and your player profile in the ${appName}.

See you next week!
— ${appName}`
}

export default function AdminDashboard({ onWeekClosed = () => {} }) {
  const { locationId, appName } = useLocation()
  const [stats, setStats]           = useState({ players: 0, events: 0, teams: 0 })
  const [openEvent, setOpenEvent]   = useState(null)
  const [scores, setScores]         = useState([])
  const [teams, setTeams]           = useState([])
  const [players, setPlayers]       = useState([])
  const [skins, setSkins]           = useState([])
  const [activeStep, setActiveStep] = useState('scores')
  const [emailBody, setEmailBody]   = useState('')
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished]   = useState(false)
  const [copied, setCopied]         = useState(false)
  const [loading, setLoading]       = useState(true)
  const [dialog, setDialog]         = useState(null)
  // track which steps have been manually acknowledged
  const [acked, setAcked] = useState({ scores: false, skins: false, results: false, email: false })

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    setLoading(true)
    const [
      { count: playerCount },
      { count: eventCount },
      { count: teamCount },
      { data: openEvts },
      { data: tms },
      { data: plrs },
    ] = await Promise.all([
      supabase.from('players').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
      supabase.from('events').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
      supabase.from('teams').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
      supabase.from('events').select('*').eq('location_id', locationId).eq('status', 'open').order('week_number', { ascending: true }).limit(1),
      supabase.from('teams').select('id, name, player1_id, player2_id').eq('location_id', locationId),
      supabase.from('players').select('id, name, first_name, last_name, email, in_skins').eq('location_id', locationId),
    ])

    setStats({ players: playerCount || 0, events: eventCount || 0, teams: teamCount || 0 })
    setTeams(tms || [])
    setPlayers(plrs || [])

    const evt = openEvts?.[0] || null
    setOpenEvent(evt)
    setPublished(false)
    setAcked({ scores: false, skins: false, results: false, email: false })

    if (evt) {
      // Load scores + course info for skins calculation
      const [{ data: scrs }, evtDetail] = await Promise.all([
        supabase.from('scores').select('*').eq('event_id', evt.id).eq('location_id', locationId),
        supabase.from('events').select('*, courses(id, name, hole_pars)').eq('id', evt.id).eq('location_id', locationId).single(),
      ])
      const s = scrs || []
      setScores(s)

      // ── Calculate skins from hole_scores (same logic as AdminSkins tab) ──
      const skinsPlayerIds = new Set((plrs || []).filter(p => p.in_skins).map(p => p.id))
      const skinsScores    = s.filter(sc => skinsPlayerIds.has(sc.player_id))
      const holePars       = evtDetail?.data?.courses?.hole_pars || null

      const computed = []
      for (let h = 0; h < 9; h++) {
        const entries = skinsScores
          .filter(sc => Array.isArray(sc.hole_scores) && sc.hole_scores[h] != null)
          .map(sc => ({ playerId: sc.player_id, score: sc.hole_scores[h] }))
        if (entries.length === 0) continue
        const min     = Math.min(...entries.map(e => e.score))
        const winners = entries.filter(e => e.score === min)
        if (winners.length === 1) {
          const player = (plrs || []).find(p => p.id === winners[0].playerId)
          const name   = player ? (player.first_name ? `${player.first_name} ${player.last_name || ''}`.trim() : player.name) : 'Unknown'
          const par    = holePars ? holePars[h] : null
          computed.push({ hole: h + 1, playerName: name, playerId: winners[0].playerId, score: min, par })
        }
      }
      setSkins(computed)
      setEmailBody(generateEmail(evt, s, tms || [], plrs || [], computed, appName))
    }

    setLoading(false)
  }

  function handlePublish() {
    if (!openEvent) return
    setDialog({
      message: 'Close out this event? Scores will be locked and season standings updated.',
      confirmLabel: 'Lock & Publish',
      destructive: false,
      onConfirm: () => doPublish(),
    })
  }

  async function doPublish() {
    setPublishing(true)

    // Close the current event
    const { error } = await supabase.from('events').update({ status: 'closed' }).eq('id', openEvent.id)
    if (error) { alert('Error: ' + error.message); setPublishing(false); return }

    // Find the next event in sequence (next week_number, not a bye, currently draft)
    const { data: nextEvents } = await supabase
      .from('events')
      .select('id, name, week_number, is_bye, status')
      .eq('location_id', locationId)
      .neq('is_bye', true)
      .eq('status', 'draft')
      .gt('week_number', openEvent.week_number ?? 0)
      .order('week_number', { ascending: true })
      .limit(1)

    let nextEventId = null
    if (nextEvents?.length) {
      const next = nextEvents[0]
      // Auto-open the next event
      await supabase.from('events').update({ status: 'open' }).eq('id', next.id)
      nextEventId = next.id
    }

    setPublishing(false)
    setPublished(true)
    onWeekClosed(nextEventId)  // tell AdminPanel the new active event
  }

  function ack(step, next) {
    setAcked(prev => ({ ...prev, [step]: true }))
    if (next) setActiveStep(next)
  }

  function copyEmail() {
    navigator.clipboard.writeText(emailBody)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
    setAcked(prev => ({ ...prev, email: true }))
  }

  if (loading) return <div style={s.loading}>Loading…</div>

  // ── derived state ──────────────────────────────────────────────────────────
  // Build player → team map so we can look up a team from a player_id
  // (scores submitted by players only have player_id, not team_id)
  const playerTeamMap = {}
  teams.forEach(t => {
    if (t.player1_id) playerTeamMap[t.player1_id] = t
    if (t.player2_id) playerTeamMap[t.player2_id] = t
  })

  // Group scores by team, using team_id if present, otherwise player_id lookup
  const scoresByTeam = {}
  scores.forEach(s => {
    const team = s.team_id ? teams.find(t => t.id === s.team_id) : playerTeamMap[s.player_id]
    if (!team) return
    if (!scoresByTeam[team.id]) scoresByTeam[team.id] = { team, scores: [] }
    scoresByTeam[team.id].scores.push(s)
  })

  // Build leaderboard: one row per team, combined gross + net
  const leaderboard = Object.values(scoresByTeam).map(({ team, scores: ts }) => ({
    team,
    totalGross: ts.reduce((a, s) => a + (s.gross_total || 0), 0),
    totalNet:   ts.reduce((a, s) => a + (s.net_total   || 0), 0),
  })).sort((a, b) => a.totalNet - b.totalNet)

  const expectedScores  = teams.length
  const submittedScores = Object.keys(scoresByTeam).length   // count teams, not rows
  const scoresOk  = submittedScores >= expectedScores && expectedScores > 0
  const skinsOk   = skins.length > 0
  const emailOk   = emailBody.trim().length > 10

  const stepDone = {
    scores:  scoresOk  || acked.scores,
    skins:   skinsOk   || acked.skins,
    results: acked.results,
    email:   emailOk   && acked.email,
    publish: published,
  }

  const emailPlayerList = players.filter(p => p.email).map(p => p.email).join(',')
  const emailSubject    = encodeURIComponent(`${openEvent?.name || 'League Update'} — Results`)
  const emailBodyEncoded = encodeURIComponent(emailBody)

  const eventLabel = openEvent
    ? (openEvent.name || openEvent.title || `Event ${openEvent.week_number || ''}`)
    : ''

  const eventSub = openEvent ? [
    openEvent.week_number ? `Week ${openEvent.week_number}` : null,
    openEvent.start_date
      ? `Week of ${new Date(openEvent.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : null,
  ].filter(Boolean).join(' · ') : ''

  return (
    <div style={s.page}>
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* ── Stat strip ─────────────────────────────────────────────────────── */}
      <div style={s.statGrid}>
        {[
          { label: 'Players',       value: stats.players, Icon: Users },
          { label: 'Teams',         value: stats.teams,   Icon: Handshake },
          { label: 'Total Events',  value: stats.events,  Icon: Calendar },
          { label: 'Active Round',  value: openEvent ? 1 : 0, Icon: Zap },
        ].map(({ label, value, Icon }) => (
          <div key={label} style={s.statCard}>
            <span style={s.statIcon}>
              <Icon size={20} strokeWidth={2} color="var(--green)" />
            </span>
            <span style={s.statValue}>{value}</span>
            <span style={s.statLabel}>{label}</span>
          </div>
        ))}
      </div>

      {/* ── No active event ─────────────────────────────────────────────────── */}
      {!openEvent ? (
        <div style={s.noEvent}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '10px' }}>
            <CheckCircle2 size={44} strokeWidth={1.75} color="var(--green)" />
          </div>
          <div style={s.noEventTitle}>No active event</div>
          <div style={s.noEventSub}>All events are closed. Create a new event in the Schedule tab to start tracking scores.</div>
        </div>
      ) : (

      /* ── Closeout card ─────────────────────────────────────────────────── */
      <div style={s.card}>

        {/* Event header */}
        <div style={s.closeoutHeader}>
          <div>
            <div style={s.closeoutTitle}>{eventLabel} — Close out</div>
            {eventSub && <div style={s.closeoutSub}>{eventSub}</div>}
          </div>
          <span style={s.openBadge}>Open</span>
        </div>

        {/* Step tab bar */}
        <div style={s.stepBar}>
          {STEPS.map(({ id, label, num }) => {
            const done   = stepDone[id]
            const active = activeStep === id
            return (
              <button
                key={id}
                style={{
                  ...s.stepTab,
                  color:        active ? 'var(--green-dark)' : done ? 'var(--green)' : 'var(--gray-400)',
                  fontWeight:   active ? 700 : 500,
                  borderBottom: active ? '2.5px solid var(--green)' : '2.5px solid transparent',
                  background:   active ? '#fff' : 'transparent',
                }}
                onClick={() => setActiveStep(id)}
              >
                <span style={{
                  ...s.stepNum,
                  background: done ? 'var(--green)' : active ? 'var(--green-dark)' : '#ccc',
                }}>
                  {done ? <Check size={13} strokeWidth={3} color="#fff" /> : num}
                </span>
                <span style={s.stepLabel}>{label}</span>
              </button>
            )
          })}
        </div>

        {/* ── Step content ──────────────────────────────────────────────────── */}
        <div style={s.stepContent}>

          {/* STEP 1 — Scores */}
          {activeStep === 'scores' && (
            <div>
              <h3 style={s.stepTitle}>Review Scores</h3>
              <div style={s.progressRow}>
                <div style={s.progressTrack}>
                  <div style={{
                    ...s.progressFill,
                    width: `${Math.min(100, (submittedScores / Math.max(1, expectedScores)) * 100)}%`,
                    background: scoresOk ? 'var(--green)' : '#f6c90e',
                  }} />
                </div>
                <span style={s.progressLabel}>
                  {submittedScores} of {expectedScores} teams submitted
                </span>
              </div>

              {leaderboard.length === 0
                ? <p style={s.empty}>No scores entered yet for this event.</p>
                : leaderboard.map((row, i) => (
                    <div key={row.team.id} style={s.scoreRow}>
                      <span style={s.scoreRank}>{i + 1}</span>
                      <span style={s.scoreTeam}>{row.team.name || 'Unknown Team'}</span>
                      <span style={s.scoreNet}>Net {row.totalNet}</span>
                      <span style={s.scoreGross}>Gross {row.totalGross}</span>
                    </div>
                  ))
              }
              <div style={s.stepActions}>
                <button style={s.nextBtn} onClick={() => ack('scores', 'skins')}>
                  {scoresOk
                    ? <><Check size={15} strokeWidth={2.5} style={{ verticalAlign: '-3px', marginRight: 6 }} />Scores look good — Next: Skins</>
                    : 'Mark reviewed & continue →'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 2 — Skins */}
          {activeStep === 'skins' && (
            <div>
              <h3 style={s.stepTitle}>Skins</h3>
              {skins.length === 0 ? (
                <div style={s.infoBox}>
                  No skins winners found yet. Skins are calculated automatically once players submit their hole-by-hole scores. Check back after scores are in.
                </div>
              ) : (
                <>
                  <p style={s.stepDesc}>
                    Skins calculated — {skins.length} winner{skins.length !== 1 ? 's' : ''} identified
                  </p>
                  {skins.map((sk, i) => (
                    <div key={i} style={s.skinRow}>
                      <span style={s.skinHole}>Hole {sk.hole}</span>
                      <span style={s.skinTeam}>{sk.playerName}</span>
                      <span style={s.skinAmt}>
                        {sk.score}{sk.par != null ? ` · par ${sk.par}` : ''}
                      </span>
                    </div>
                  ))}
                </>
              )}
              <div style={s.stepActions}>
                <button style={s.nextBtn} onClick={() => ack('skins', 'results')}>
                  {skinsOk ? 'Skins confirmed — Next: Results →' : 'Skip skins & continue →'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3 — Results */}
          {activeStep === 'results' && (
            <div>
              <h3 style={s.stepTitle}>Results Preview</h3>
              <p style={s.stepDesc}>Verify the leaderboard before publishing.</p>
              {leaderboard.length === 0
                ? <p style={s.empty}>No scores to preview.</p>
                : leaderboard.slice(0, 5).map((row, i) => {
                    const medals = ['🥇','🥈','🥉']
                    return (
                      <div key={row.team.id} style={s.resultRow}>
                        <span style={s.resultMedal}>{medals[i] || `${i+1}.`}</span>
                        <span style={s.resultTeam}>{row.team.name || 'Unknown Team'}</span>
                        <div style={s.resultRight}>
                          <span style={s.resultNet}>Net {row.totalNet}</span>
                          <span style={s.resultGross}>/ Gross {row.totalGross}</span>
                        </div>
                      </div>
                    )
                  })
              }
              <div style={s.stepActions}>
                <button style={s.nextBtn} onClick={() => ack('results', 'email')}>
                  Results verified — Next: Weekly Email →
                </button>
              </div>
            </div>
          )}

          {/* STEP 4 — Weekly Email */}
          {activeStep === 'email' && (
            <div>
              <h3 style={s.stepTitle}>Weekly Email</h3>
              <p style={s.stepDesc}>
                Edit the recap below, then copy it or open it in your mail app.
              </p>
              <textarea
                style={s.emailArea}
                value={emailBody}
                onChange={e => setEmailBody(e.target.value)}
                rows={16}
              />
              <div style={s.emailBtns}>
                <button style={s.copyBtn} onClick={copyEmail}>
                  {copied
                    ? <><Check size={15} strokeWidth={2.5} style={{ verticalAlign: '-3px', marginRight: 6 }} />Copied!</>
                    : <><Clipboard size={15} strokeWidth={2} style={{ verticalAlign: '-3px', marginRight: 6 }} />Copy to Clipboard</>}
                </button>
                <a
                  style={s.mailtoBtn}
                  href={`mailto:?bcc=${emailPlayerList}&subject=${emailSubject}&body=${emailBodyEncoded}`}
                  onClick={() => setAcked(prev => ({ ...prev, email: true }))}
                >
                  <Mail size={15} strokeWidth={2} style={{ verticalAlign: '-3px', marginRight: 6 }} />Open in Mail App
                </a>
              </div>
              <p style={s.emailNote}>
                {players.filter(p => p.email).length} of {players.length} players have email addresses on file.
              </p>
              <div style={s.stepActions}>
                <button style={s.nextBtn} onClick={() => ack('email', 'publish')}>
                  Email ready — Next: Lock &amp; Publish →
                </button>
              </div>
            </div>
          )}

          {/* STEP 5 — Lock & Publish */}
          {activeStep === 'publish' && (
            <div>
              <h3 style={s.stepTitle}>Lock &amp; Publish — {eventLabel}</h3>
              <p style={s.stepDesc}>This is the final step. Review the checklist below before publishing.</p>

              <div style={s.checklist}>
                {[
                  { done: stepDone.scores,  text: `${submittedScores} of ${expectedScores} scores submitted${submittedScores > expectedScores ? ` (${submittedScores - expectedScores} entered manually)` : ''}` },
                  { done: stepDone.skins,   text: skins.length > 0 ? `Skins calculated — ${skins.length} winner${skins.length !== 1 ? 's' : ''} identified` : 'Skins step reviewed' },
                  { done: stepDone.results, text: 'Results previewed — standings verified' },
                  { done: stepDone.email,   text: 'Weekly email composed and ready to send' },
                ].map(({ done, text }) => (
                  <div key={text} style={s.checkRow}>
                    <span style={s.checkIcon}>
                      {done
                        ? <CheckCircle2 size={20} strokeWidth={2} color="var(--green)" />
                        : <Square size={20} strokeWidth={1.75} color="var(--gray-400)" />}
                    </span>
                    <span style={{ ...s.checkText, color: done ? 'var(--black)' : 'var(--gray-400)' }}>{text}</span>
                  </div>
                ))}
              </div>

              <div style={s.publishInfo}>
                Publishing will: unlock results for all players, reveal skins winners in the app,
                recalculate all handicaps, and update season standings.
              </div>

              {published ? (
                <div style={s.successBanner}>
                  🎉 Event published! Season standings have been updated.
                </div>
              ) : (
                <button
                  style={{ ...s.publishBtn, opacity: publishing ? 0.7 : 1 }}
                  onClick={handlePublish}
                  disabled={publishing}
                >
                  {publishing
                    ? 'Publishing…'
                    : <><Lock size={16} strokeWidth={2.25} style={{ verticalAlign: '-3px', marginRight: 8 }} />Lock & Publish Event</>}
                </button>
              )}
            </div>
          )}

        </div>{/* end stepContent */}
      </div>
      /* end closeout card */
      )}
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────
const s = {
  page:    { padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' },
  loading: { padding: '60px', textAlign: 'center', color: 'var(--gray-400)' },

  // stat strip
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' },
  statCard: { background: '#fff', borderRadius: 'var(--radius)', padding: '18px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  statIcon: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '22px' },
  statValue: { fontSize: '30px', fontWeight: 800, color: 'var(--green-dark)', lineHeight: 1 },
  statLabel: { fontSize: '11px', color: 'var(--gray-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: '2px' },

  // no event
  noEvent:     { background: '#fff', borderRadius: 'var(--radius)', padding: '48px 24px', textAlign: 'center', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  noEventTitle: { fontSize: '18px', fontWeight: 700, color: 'var(--green-dark)', marginBottom: '8px' },
  noEventSub:   { fontSize: '14px', color: 'var(--gray-400)' },

  // closeout card
  card: { background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },

  closeoutHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px 16px', background: 'var(--green-dark)', color: '#fff' },
  closeoutTitle:  { fontSize: '20px', fontWeight: 800, color: '#fff', letterSpacing: '-0.2px' },
  closeoutSub:    { fontSize: '13px', color: 'rgba(255,255,255,0.70)', marginTop: '4px', fontWeight: 400 },
  openBadge:      { background: '#f6c90e', color: '#5a4200', fontSize: '11px', fontWeight: 800, padding: '3px 10px', borderRadius: '20px', flexShrink: 0, marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.4px' },

  // step bar
  stepBar: { display: 'flex', borderBottom: '1px solid var(--gray-200)', overflowX: 'auto', scrollbarWidth: 'none', background: 'var(--off-white)' },
  stepTab: { display: 'flex', alignItems: 'center', gap: '7px', padding: '12px 16px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s', flexShrink: 0 },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', color: '#fff', fontSize: '11px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepLabel: { fontSize: '13px' },

  // step content
  stepContent: { padding: '24px' },
  stepTitle:   { fontSize: '16px', fontWeight: 800, color: 'var(--green-dark)', marginBottom: '14px', letterSpacing: '-0.1px' },
  stepDesc:    { fontSize: '13px', color: 'var(--gray-500)', marginBottom: '14px' },
  empty:       { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '20px 0' },
  infoBox:     { background: 'var(--off-white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', fontSize: '13px', color: 'var(--gray-600)', marginBottom: '16px' },

  // scores
  progressRow:   { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
  progressTrack: { flex: 1, height: '8px', background: 'var(--gray-100)', borderRadius: '4px', overflow: 'hidden' },
  progressFill:  { height: '100%', borderRadius: '4px', transition: 'width 0.4s ease' },
  progressLabel: { fontSize: '13px', color: 'var(--gray-500)', whiteSpace: 'nowrap', fontWeight: 600 },
  scoreRow:      { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--gray-100)' },
  scoreRank:     { width: '24px', height: '24px', background: 'var(--green-xlight)', color: 'var(--green-dark)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 800, flexShrink: 0 },
  scoreTeam:     { flex: 1, fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  scoreNet:      { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '2px 8px', borderRadius: '10px' },
  scoreGross:    { fontSize: '12px', color: 'var(--gray-400)' },

  // skins
  skinRow:  { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--gray-100)' },
  skinHole: { fontSize: '12px', fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 },
  skinTeam: { flex: 1, fontSize: '14px', fontWeight: 600 },
  skinAmt:  { fontSize: '13px', fontWeight: 700, color: '#2d6a4f' },

  // results
  resultRow:   { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  resultMedal: { fontSize: '20px', width: '28px', textAlign: 'center', flexShrink: 0 },
  resultTeam:  { flex: 1, fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  resultRight: { display: 'flex', gap: '6px', alignItems: 'center' },
  resultNet:   { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '2px 8px', borderRadius: '10px' },
  resultGross: { fontSize: '12px', color: 'var(--gray-400)' },

  // email
  emailArea: { width: '100%', padding: '14px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '13px', fontFamily: 'monospace', lineHeight: '1.6', color: 'var(--black)', background: 'var(--off-white)', resize: 'vertical', boxSizing: 'border-box', marginBottom: '12px' },
  emailBtns: { display: 'flex', gap: '10px', marginBottom: '10px' },
  copyBtn:   { flex: 1, padding: '11px', background: 'var(--green)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  mailtoBtn: { flex: 1, padding: '11px', background: 'var(--off-white)', color: 'var(--green-dark)', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700, textDecoration: 'none', textAlign: 'center', border: '1.5px solid var(--gray-200)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  emailNote: { fontSize: '11px', color: 'var(--gray-400)', marginBottom: '4px' },

  // publish checklist
  checklist:   { display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' },
  checkRow:    { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  checkIcon:   { display: 'flex', alignItems: 'center', flexShrink: 0 },
  checkText:   { fontSize: '14px', fontWeight: 500 },
  publishInfo: { background: '#e8f4fd', border: '1px solid #bee3f8', borderRadius: 'var(--radius-sm)', padding: '14px 16px', fontSize: '13px', color: '#2b6cb0', marginBottom: '20px', lineHeight: '1.5' },
  publishBtn:  { width: '100%', padding: '16px', background: 'var(--green-dark)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '15px', fontWeight: 800, cursor: 'pointer', letterSpacing: '0.2px', transition: 'opacity 0.2s' },
  successBanner: { background: '#d8f3dc', border: '1px solid #95d5a8', borderRadius: 'var(--radius-sm)', padding: '16px', fontSize: '15px', fontWeight: 700, color: '#2d6a4f', textAlign: 'center' },

  // shared
  stepActions: { marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--gray-100)' },
  nextBtn: { width: '100%', padding: '13px', background: 'var(--green)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700, cursor: 'pointer' },
}
