import React, { useState, useEffect } from 'react'
import { CalendarCheck, CalendarX, Check, Users, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'
import { Button, Toast, EmptyState } from '../components/ui'

// -----------------------------------------------------------------------------
//  EventsPage -- player-facing event feed with RSVP support.
//
//  For every upcoming event at the player's location we show: date, title,
//  description, signup count (and capacity if set), and an RSVP / Cancel RSVP
//  button. Full events disable the RSVP button for players who haven't signed
//  up yet; a player who's already in can always cancel.
// -----------------------------------------------------------------------------

export default function EventsPage({ session }) {
  const { locationId } = useLocation()
  const [events,   setEvents]   = useState([])
  // Map of eventId -> count of signups. Admin view uses a richer structure;
  // the player side only needs the tally for the capacity meter.
  const [counts,   setCounts]   = useState({})
  // Set of eventIds the current player has RSVP'd to.
  const [myRsvps,  setMyRsvps]  = useState(new Set())
  const [myPlayer, setMyPlayer] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [busyId,   setBusyId]   = useState(null)    // which event's button is mid-request
  const [toast,    setToast]    = useState(null)
  // Tournaments (scored, standalone) — separate from social RSVPs above.
  const [tournaments, setTournaments] = useState([])
  const [tCounts, setTCounts]         = useState({})   // tournamentId -> entry count
  const [myTEntries, setMyTEntries]   = useState(new Set())
  const [boards, setBoards]           = useState({})   // tournamentId -> leaderboard rows
  const [expandedT, setExpandedT]     = useState(null)

  useEffect(() => {
    if (!locationId) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, session?.user?.id])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function load() {
    setLoading(true)

    const userId = session?.user?.id || null
    const [
      { data: evRows,     error: evErr },
      { data: signupRows, error: suErr },
      playerRes,
      { data: tRows },
      { data: tEntryRows },
    ] = await Promise.all([
      supabase.from('app_events')
        .select('id, title, description, event_date, capacity')
        .eq('location_id', locationId)
        .order('event_date', { ascending: true }),
      supabase.from('event_signups')
        .select('event_id, player_id')
        .eq('location_id', locationId),
      userId
        ? supabase.from('players')
            .select('id')
            .eq('user_id', userId)
            .eq('location_id', locationId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('tournaments')
        .select('id, name, tournament_date, format, team_size, capacity, notes, status')
        .eq('location_id', locationId)
        .neq('status', 'cancelled')
        .order('tournament_date', { ascending: true, nullsFirst: false }),
      supabase.from('tournament_entries')
        .select('tournament_id, player_id')
        .eq('location_id', locationId),
    ])

    if (evErr) console.error('EventsPage events error:', evErr.message)
    if (suErr) console.error('EventsPage signups error:', suErr.message)

    const cnt = {}
    const mine = new Set()
    const myId = playerRes?.data?.id || null
    ;(signupRows || []).forEach(s => {
      cnt[s.event_id] = (cnt[s.event_id] || 0) + 1
      if (myId && s.player_id === myId) mine.add(s.event_id)
    })

    // Keep upcoming only; past events stay out of the player feed.
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const upcoming = (evRows || []).filter(e =>
      e.event_date && new Date(e.event_date + 'T00:00:00') >= today
    )

    setEvents(upcoming)
    setCounts(cnt)
    setMyRsvps(mine)
    setMyPlayer(myId ? { id: myId } : null)

    const tCnt = {}
    const tMine = new Set()
    ;(tEntryRows || []).forEach(e => {
      tCnt[e.tournament_id] = (tCnt[e.tournament_id] || 0) + 1
      if (myId && e.player_id === myId) tMine.add(e.tournament_id)
    })
    setTournaments(tRows || [])
    setTCounts(tCnt)
    setMyTEntries(tMine)
    setLoading(false)
  }

  async function toggleTournament(t) {
    if (!myPlayer?.id) { showToast('Sign in to enter tournaments.', 'error'); return }
    setBusyId(t.id)
    const joined = myTEntries.has(t.id)
    const { error } = joined
      ? await supabase.rpc('withdraw_tournament', { p_tournament_id: t.id })
      : await supabase.rpc('signup_tournament', { p_tournament_id: t.id })
    setBusyId(null)
    if (error) { showToast(error.message, 'error'); return }
    showToast(joined ? 'Withdrawn.' : `You're in — ${t.name}!`)
    setMyTEntries(prev => {
      const n = new Set(prev)
      joined ? n.delete(t.id) : n.add(t.id)
      return n
    })
    setTCounts(prev => ({ ...prev, [t.id]: Math.max(0, (prev[t.id] || 0) + (joined ? -1 : 1)) }))
  }

  async function toggleBoard(t) {
    const next = expandedT === t.id ? null : t.id
    setExpandedT(next)
    if (next && !boards[t.id]) {
      const { data } = await supabase.rpc('tournament_leaderboard', { p_tournament_id: t.id })
      setBoards(prev => ({ ...prev, [t.id]: Array.isArray(data) ? data : [] }))
    }
  }

  async function toggleRsvp(evt) {
    if (!myPlayer?.id) {
      showToast('Sign in to RSVP for events.', 'error')
      return
    }

    setBusyId(evt.id)
    const alreadyIn = myRsvps.has(evt.id)

    if (alreadyIn) {
      const { error } = await supabase
        .from('event_signups')
        .delete()
        .eq('event_id', evt.id)
        .eq('player_id', myPlayer.id)
        .eq('location_id', locationId)
      setBusyId(null)
      if (error) { showToast('Error: ' + error.message, 'error'); return }
      showToast('RSVP cancelled.')
      setMyRsvps(prev => { const n = new Set(prev); n.delete(evt.id); return n })
      setCounts(prev => ({ ...prev, [evt.id]: Math.max(0, (prev[evt.id] || 1) - 1) }))
      return
    }

    // Joining: double-check capacity client-side. The DB unique (event_id,
    // player_id) constraint is the real guard but this stops racing a
    // just-full event from a stale view.
    const current = counts[evt.id] || 0
    if (evt.capacity != null && current >= evt.capacity) {
      setBusyId(null)
      showToast('This event is full.', 'error'); return
    }

    const { error } = await supabase
      .from('event_signups')
      .insert({ event_id: evt.id, player_id: myPlayer.id, location_id: locationId })
    setBusyId(null)
    if (error) {
      // 23505 = unique_violation -- caller already RSVP'd in another tab.
      if (error.code === '23505') {
        showToast("You're already signed up.")
        setMyRsvps(prev => new Set(prev).add(evt.id))
        return
      }
      showToast('Error: ' + error.message, 'error')
      return
    }
    showToast("You're signed up for " + evt.title + "!")
    setMyRsvps(prev => new Set(prev).add(evt.id))
    setCounts(prev => ({ ...prev, [evt.id]: (prev[evt.id] || 0) + 1 }))
  }

  return (
    <div style={styles.container}>
      <Toast toast={toast} />

      <div style={styles.pageHeader}>
        <h1 style={styles.pageTitle}>Events</h1>
        <p style={styles.pageSubtitle}>Tournaments & special events</p>
      </div>

      {/* Tournaments — scored standalone events */}
      {!loading && tournaments.length > 0 && (
        <div style={{ ...styles.list, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '0 2px' }}>
            Tournaments
          </div>
          {tournaments.map(t => {
            const count = tCounts[t.id] || 0
            const joined = myTEntries.has(t.id)
            const isFull = t.capacity != null && count >= t.capacity
            const busy = busyId === t.id
            const fmtLabel = { stroke: 'Stroke play', scramble: 'Scramble', best_ball: 'Best ball', stableford: 'Stableford' }[t.format] || t.format
            const board = boards[t.id]
            return (
              <div key={t.id} style={{ ...styles.card, flexDirection: 'column' }}>
                <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                  <div style={styles.cardBody}>
                    <div style={styles.cardTitle}>
                      {t.name}
                      <span style={{
                        marginLeft: 8, fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
                        padding: '2px 7px', borderRadius: 10,
                        background: t.status === 'signup' ? 'var(--green-xlight)' : t.status === 'scoring' ? '#fef3c7' : 'var(--gray-100)',
                        color: t.status === 'signup' ? 'var(--green-dark)' : t.status === 'scoring' ? '#92400e' : 'var(--gray-500)',
                      }}>
                        {t.status === 'signup' ? 'Sign-ups open' : t.status === 'scoring' ? 'In progress' : 'Final'}
                      </span>
                    </div>
                    <div style={styles.cardDesc}>
                      {fmtLabel}{t.team_size > 1 ? ` · teams of ${t.team_size}` : ''}
                      {t.tournament_date ? ` · ${new Date(t.tournament_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                      {t.notes ? ` — ${t.notes}` : ''}
                    </div>
                    <div style={styles.meterRow}>
                      <Users size={13} strokeWidth={2} style={{ color: 'var(--gray-500)' }} />
                      <span style={styles.meterText}>
                        {t.capacity != null ? `${count} / ${t.capacity} entered` : `${count} entered`}
                      </span>
                      {isFull && <span style={styles.fullBadge}>FULL</span>}
                    </div>
                    <div style={styles.actionsRow}>
                      {t.status === 'signup' && (
                        joined ? (
                          <>
                            <div style={styles.goingPill}>
                              <CalendarCheck size={13} strokeWidth={2.25} />
                              <span>You're in</span>
                            </div>
                            <Button variant="ghost" size="sm" loading={busy} onClick={() => toggleTournament(t)}>
                              Withdraw
                            </Button>
                          </>
                        ) : (
                          <Button variant="primary" size="sm" loading={busy}
                            disabled={isFull || !myPlayer?.id}
                            onClick={() => toggleTournament(t)}>
                            {isFull ? 'Full' : 'Sign up'}
                          </Button>
                        )
                      )}
                      {t.status !== 'signup' && (
                        <Button variant="secondary" size="sm" onClick={() => toggleBoard(t)}>
                          {expandedT === t.id ? 'Hide leaderboard' : 'Leaderboard'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                {expandedT === t.id && (
                  <div style={{ width: '100%', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--gray-100)' }}>
                    {!board ? (
                      <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>Loading…</div>
                    ) : board.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>No scores yet.</div>
                    ) : board.map((r, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--gray-100)' }}>
                        <span style={{ width: 20, fontSize: 12, fontWeight: 800, color: 'var(--gray-400)', textAlign: 'center' }}>{i + 1}</span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                        {r.gross != null && <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>gross {r.gross}</span>}
                        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--green-dark)' }}>{Number(r.result)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {loading ? (
        <div style={styles.loading}>Loading events...</div>
      ) : events.length === 0 && tournaments.length === 0 ? (
        <div style={styles.emptyWrap}>
          <EmptyState
            icon={<CalendarX size={38} strokeWidth={1.5} />}
            title="No upcoming events"
            description="New tournaments and socials will show up here. Check back soon!"
          />
        </div>
      ) : (
        <div style={styles.list}>
          {events.map(evt => {
            const count    = counts[evt.id] || 0
            const isFull   = evt.capacity != null && count >= evt.capacity
            const joined   = myRsvps.has(evt.id)
            const canRsvp  = !!myPlayer?.id
            const busy     = busyId === evt.id
            const dateObj  = new Date(evt.event_date + 'T00:00:00')
            const monthTxt = dateObj.toLocaleDateString('en-US', { month: 'short' })
            const dayTxt   = dateObj.toLocaleDateString('en-US', { day: 'numeric' })

            const pct = evt.capacity
              ? Math.min(100, Math.round((count / evt.capacity) * 100))
              : null

            return (
              <div key={evt.id} style={styles.card}>
                <div style={styles.cardDateBlock}>
                  <div style={styles.cardMonth}>{monthTxt.toUpperCase()}</div>
                  <div style={styles.cardDay}>{dayTxt}</div>
                </div>

                <div style={styles.cardBody}>
                  <div style={styles.cardTitle}>{evt.title}</div>
                  {evt.description && (
                    <div style={styles.cardDesc}>{evt.description}</div>
                  )}

                  <div style={styles.meterRow}>
                    <Users size={13} strokeWidth={2} style={{ color: 'var(--gray-500)' }} />
                    <span style={styles.meterText}>
                      {evt.capacity != null
                        ? count + ' / ' + evt.capacity + ' signed up'
                        : count + ' signed up'}
                    </span>
                    {isFull && <span style={styles.fullBadge}>FULL</span>}
                  </div>
                  {pct != null && (
                    <div style={styles.meterBar}>
                      <div style={{
                        ...styles.meterFill,
                        width: pct + '%',
                        background: isFull ? '#c53030' : 'var(--green)',
                      }} />
                    </div>
                  )}

                  <div style={styles.actionsRow}>
                    {joined ? (
                      <>
                        <div style={styles.goingPill}>
                          <CalendarCheck size={13} strokeWidth={2.25} />
                          <span>You're going</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleRsvp(evt)}
                          loading={busy}
                          loadingText="..."
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant={isFull ? 'secondary' : 'primary'}
                        size="sm"
                        icon={isFull ? <Clock size={14} strokeWidth={2.25} /> : <Check size={14} strokeWidth={2.5} />}
                        onClick={() => toggleRsvp(evt)}
                        disabled={!canRsvp || isFull}
                        loading={busy}
                        loadingText="Saving..."
                      >
                        {isFull ? 'Event full' : canRsvp ? 'RSVP' : 'Sign in to RSVP'}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { padding: '0 0 24px' },
  pageHeader: {
    padding: '20px 20px 16px',
    borderBottom: '1px solid var(--gray-200)',
  },
  pageTitle: { fontSize: '22px', fontWeight: 700, color: 'var(--green-dark)' },
  pageSubtitle: { fontSize: '13px', color: 'var(--gray-600)', marginTop: '2px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },

  emptyWrap: { padding: '24px 16px 0' },

  list: { padding: '16px 16px 0' },

  card: {
    display: 'flex',
    gap: '14px',
    padding: '14px',
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    marginBottom: '12px',
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
    alignItems: 'flex-start',
  },

  cardDateBlock: {
    background: 'var(--green)',
    color: 'var(--white)',
    borderRadius: '10px',
    padding: '8px 10px',
    minWidth: '56px',
    textAlign: 'center',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  cardMonth: { fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', opacity: 0.95 },
  cardDay:   { fontSize: 20, fontWeight: 800, lineHeight: 1 },

  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: '15px', fontWeight: 700, color: 'var(--black)' },
  cardDesc:  { fontSize: '13px', color: 'var(--gray-600)', marginTop: 4, lineHeight: 1.4 },

  meterRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 12,
  },
  meterText: { fontSize: 12, fontWeight: 600, color: 'var(--gray-600)' },
  fullBadge: {
    marginLeft: 'auto',
    fontSize: 10,
    fontWeight: 800,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#c53030',
    color: '#fff',
    letterSpacing: '0.3px',
  },
  meterBar: {
    marginTop: 6,
    height: 5,
    borderRadius: 3,
    background: 'var(--gray-100)',
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    transition: 'width 0.25s ease, background 0.2s',
  },

  actionsRow: {
    marginTop: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  goingPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'var(--green-xlight)',
    border: '1px solid var(--green)',
    padding: '6px 12px',
    borderRadius: 20,
  },
}
