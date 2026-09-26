import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MapPin, X, QrCode, Printer, Eraser, Check, Pencil } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, Callout, EmptyState, Card, Input } from '../ui'
import ConfirmDialog from '../ConfirmDialog'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { bayName, boardSummary, checkinUrl, thruLabel, playerDisplayName } from '../../lib/bayUtils'

// League-night bay board. Players check their own team in (QR on the bay or
// the app's Check in button); staff watch the board, fix walk-ins, and hit
// "Clear all bays" between waves. Realtime on bay_checkins + live_rounds,
// with a 15s poll as the fallback.

const POLL_MS = 15000

function timeOf(ts) {
  return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
}

export default function AdminBays() {
  const { locationId } = useLocation()
  const [board, setBoard]       = useState(null)
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy]         = useState(null)
  const [dialog, setDialog]     = useState(null)
  const [toast, setToast]       = useState(null)
  const [countInput, setCountInput] = useState('')
  const [renaming, setRenaming] = useState(null)   // { id, label }
  const [showQr, setShowQr]     = useState(false)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => { if (mounted.current) setToast(null) }, 3000)
  }

  const load = useCallback(async () => {
    if (!locationId) return
    const { data, error } = await supabase.rpc('bay_board', { p_location_id: locationId })
    if (!mounted.current) return
    if (error) {
      console.error('[AdminBays] load failed', error)
      setLoadError(mutationErrorMessage(error, 'use bay check-in'))
    } else {
      setBoard(data)
      setLoadError(null)
    }
    setLoading(false)
  }, [locationId])

  useEffect(() => {
    if (!locationId) return undefined
    let debounce = null
    const reloadSoon = () => { clearTimeout(debounce); debounce = setTimeout(load, 400) }
    const channel = supabase
      .channel(`admin-bays-${locationId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'bay_checkins', filter: `location_id=eq.${locationId}` },
        reloadSoon)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'live_rounds', filter: `location_id=eq.${locationId}` },
        reloadSoon)
      .subscribe()
    const poll = setInterval(load, POLL_MS)
    load()
    return () => {
      clearTimeout(debounce)
      clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [locationId, load])

  const bays = board?.bays || []
  const teams = board?.teams || []
  const summary = boardSummary(board)

  useEffect(() => {
    if (board && countInput === '') setCountInput(String(bays.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board])

  // Every admin mutation: busy flag, toast, reload.
  // `call` is a thunk so every RPC name stays literal for check_rpc_params.py.
  async function run(key, call, successMsg) {
    setBusy(key)
    const { data, error } = await call()
    if (!mounted.current) return null
    setBusy(null)
    if (error) {
      showToast(mutationErrorMessage(error, 'use bay check-in'), 'error')
      return null
    }
    if (successMsg) showToast(typeof successMsg === 'function' ? successMsg(data) : successMsg)
    load()
    return data ?? true
  }

  const clearAll = () => setDialog({
    message: 'Clear all bays? Every team comes off its bay so the next wave can check in. Scores are not affected.',
    confirmLabel: 'Clear all bays',
    onConfirm: () => run('all', () => supabase.rpc('admin_clear_all_bays', { p_location_id: locationId }),
      n => `Cleared ${n} team${n === 1 ? '' : 's'}`),
  })
  const clearBay = bay => run(`bay:${bay.id}`, () => supabase.rpc('admin_clear_bay', { p_bay_id: bay.id }), `${bayName(bay.label)} cleared`)
  const clearTeam = team => run(`team:${team.checkin_id}`, () => supabase.rpc('admin_clear_checkin', { p_checkin_id: team.checkin_id }),
    `${team.team_name} taken off`)
  const placeTeam = (teamId, bayId) => {
    const team = teams.find(t => t.team_id === teamId)
    const bay = bays.find(b => b.id === bayId)
    if (!team || !bay) return
    run(`place:${teamId}`, () => supabase.rpc('admin_checkin_team', { p_bay_id: bayId, p_team_id: teamId }),
      `${team.team_name} → ${bayName(bay.label)}`)
  }
  const saveCount = () => {
    const n = parseInt(countInput, 10)
    if (!Number.isFinite(n) || n < 0 || n > 60) { showToast('Enter 0 to 60 bays', 'error'); return }
    const go = () => run('count', () => supabase.rpc('admin_set_bays', { p_location_id: locationId, p_count: n }), `${n} bays`)
    const occupiedRemoved = bays.slice(n).some(b => (b.teams || []).length > 0)
    if (occupiedRemoved) {
      setDialog({
        message: `Bays past ${n} have teams on them. Switching them off takes those teams off too.`,
        confirmLabel: `Use ${n} bays`,
        onConfirm: go,
      })
    } else go()
  }
  const saveRename = async () => {
    if (!renaming) return
    const ok = await run('rename', () => supabase.rpc('admin_rename_bay', { p_bay_id: renaming.id, p_label: renaming.label }), 'Bay renamed')
    if (ok) setRenaming(null)
  }

  if (showQr) {
    return <QrSheet bays={bays} onBack={() => setShowQr(false)} showToast={showToast} toast={toast} />
  }

  return (
    <div style={st.page}>
      {toast && <Toast toast={toast} />}
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onCancel={() => setDialog(null)}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
        />
      )}

      {loadError && <Callout tone="danger">{loadError}</Callout>}

      {!loading && !loadError && (
        <Card tone="dark" padding="lg">
          <div style={st.heroRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={st.heroTitle}>
                {summary.busyBays} of {summary.bays} bays in use
              </div>
              <div style={st.heroSub}>
                {summary.teamsOnBays} team{summary.teamsOnBays === 1 ? '' : 's'} on bays
                {board?.events?.length ? ` · ${summary.waiting} not checked in` : ' · no open week'}
              </div>
            </div>
            <Button
              variant="danger"
              size="lg"
              icon={<Eraser size={18} strokeWidth={2.25} />}
              onClick={clearAll}
              loading={busy === 'all'}
              loadingText="Clearing…"
              disabled={summary.teamsOnBays === 0}
              style={st.clearAllBtn}
            >
              Clear all bays
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p style={st.muted}>Loading bays…</p>
      ) : !loadError && bays.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MapPin size={40} strokeWidth={1.5} />}
            title="No bays set up yet"
            description="Set how many bays you have (below). Players then check in by tapping their bay or scanning its QR code."
          />
        </Card>
      ) : (
        <div style={st.grid}>
          {bays.map(bay => (
            <Card
              key={bay.id}
              padding="sm"
              style={{ borderColor: bay.teams?.length ? 'var(--green)' : 'var(--gray-200)' }}
            >
              <div style={st.bayHead}>
                <span style={st.bayLabel}>{bayName(bay.label)}</span>
                {bay.teams?.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => clearBay(bay)} loading={busy === `bay:${bay.id}`}>
                    Clear
                  </Button>
                )}
              </div>
              {(bay.teams || []).length === 0 ? (
                <div style={st.open}>Open</div>
              ) : bay.teams.map(team => (
                <div key={team.checkin_id} style={st.teamBlock}>
                  <div style={st.teamRow}>
                    <span style={st.teamName}>{team.team_name}</span>
                    {team.finished && <span style={st.doneBadge}>Finished</span>}
                    <span style={st.time}>{timeOf(team.checked_in_at)}</span>
                    <button
                      style={st.removeBtn}
                      aria-label={`Take ${team.team_name} off`}
                      onClick={() => clearTeam(team)}
                      disabled={busy === `team:${team.checkin_id}`}
                    >
                      <X size={16} strokeWidth={2.25} />
                    </button>
                  </div>
                  {(team.players || []).map(p => (
                    <div key={p.player_id} style={st.playerRow}>
                      <span>{playerDisplayName(p)}</span>
                      <span style={{ ...st.thru, color: p.submitted ? 'var(--green)' : 'var(--gray-500)' }}>
                        {thruLabel(p)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}

      {bays.length > 0 && teams.length > 0 && (
        <Card title="Teams tonight" count={teams.length}>
          <p style={st.hint}>For walk-ins and players without a phone: pick the team's bay.</p>
          {[...teams].sort((a, b) => Number(!!a.bay_id) - Number(!!b.bay_id) || a.team_name.localeCompare(b.team_name))
            .map(team => (
              <div key={team.team_id} style={st.manualRow}>
                <span style={{ ...st.teamName, flex: 1 }}>
                  {team.team_name}
                  {team.finished && <span style={{ ...st.doneBadge, marginLeft: 8 }}>Finished</span>}
                </span>
                <select
                  style={st.select}
                  value={team.bay_id || ''}
                  disabled={busy === `place:${team.team_id}`}
                  onChange={e => e.target.value && placeTeam(team.team_id, e.target.value)}
                >
                  <option value="">Not checked in</option>
                  {bays.map(b => <option key={b.id} value={b.id}>{bayName(b.label)}</option>)}
                </select>
              </div>
            ))}
        </Card>
      )}

      <Card title="Bay setup">
        <div style={st.countRow}>
          <Input
            label="Number of bays"
            type="number"
            min={0}
            max={60}
            value={countInput}
            onChange={e => setCountInput(e.target.value)}
            fullWidth={false}
            style={{ width: 140 }}
          />
          <Button onClick={saveCount} loading={busy === 'count'} disabled={countInput === String(bays.length)}>
            Save
          </Button>
          <Button
            variant="secondary"
            icon={<QrCode size={16} strokeWidth={2} />}
            onClick={() => setShowQr(true)}
            disabled={bays.length === 0}
            style={{ marginLeft: 'auto' }}
          >
            Print QR codes
          </Button>
        </div>
        <p style={st.hint}>
          Bays are numbered 1 to N. Rename one if it has a different name on the wall. The QR code for each
          bay prints its name, so reprint after renaming.
        </p>
        <div style={st.renameList}>
          {bays.map(bay => (
            <div key={bay.id} style={st.renameRow}>
              {renaming?.id === bay.id ? (
                <>
                  <Input
                    value={renaming.label}
                    maxLength={20}
                    onChange={e => setRenaming({ ...renaming, label: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename() }}
                    autoFocus
                    size="sm"
                  />
                  <Button size="sm" onClick={saveRename} loading={busy === 'rename'} icon={<Check size={14} />}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1 }}>{bayName(bay.label)}</span>
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />}
                    onClick={() => setRenaming({ id: bay.id, label: bay.label })}>
                    Rename
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ── Printable QR codes ──────────────────────────────────────────────────────
// qrcode is loaded only here, so it never ships in the player bundle.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function QrSheet({ bays, onBack, showToast, toast }) {
  const { appName } = useLocation()
  const [codes, setCodes] = useState(null)   // [{ bay, url, dataUrl }]
  const [error, setError] = useState(null)
  // The board reloads every 15s; only regenerate when the bays themselves change.
  const baysKey = bays.map(b => `${b.id}:${b.label}`).join('|')

  useEffect(() => {
    let cancelled = false
    import('qrcode')
      .then(async mod => {
        const QR = mod.default || mod
        const origin = window.location.origin
        const out = await Promise.all(bays.map(async bay => {
          const url = checkinUrl(origin, bay.label)
          const dataUrl = await QR.toDataURL(url, { margin: 1, width: 600, errorCorrectionLevel: 'M' })
          return { bay, url, dataUrl }
        }))
        if (!cancelled) setCodes(out)
      })
      .catch(e => {
        console.error('[AdminBays] QR generation failed', e)
        if (!cancelled) setError('Could not make the QR codes. Reload and try again.')
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baysKey])

  // Print from a clean window: the admin shell is a fixed, scrolling layout
  // that browsers print badly. One bay per page, sized for a letter sheet.
  const print = () => {
    const win = window.open('', '_blank')
    if (!win) { showToast('Allow pop-ups for this site to print', 'error'); return }
    const pages = codes.map(({ bay, url, dataUrl }) => `
      <section>
        <div class="brand">${escapeHtml(appName || '')}</div>
        <div class="bay">${escapeHtml(bayName(bay.label))}</div>
        <img src="${dataUrl}" alt="QR code for ${escapeHtml(bayName(bay.label))}" />
        <div class="cta">Scan to check in your team</div>
        <div class="url">${escapeHtml(url)}</div>
      </section>`).join('')
    win.document.write(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Bay QR codes</title>
      <style>
        @page { size: letter; margin: 0.6in; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; }
        section { page-break-after: always; break-after: page; text-align: center; padding-top: 0.2in; }
        section:last-child { page-break-after: auto; break-after: auto; }
        .brand { font-size: 20px; font-weight: 600; color: #555; }
        .bay { font-size: 110px; font-weight: 900; line-height: 1.05; margin: 8px 0 16px; }
        img { width: 5.2in; height: 5.2in; image-rendering: pixelated; }
        .cta { font-size: 34px; font-weight: 800; margin-top: 16px; }
        .url { font-size: 12px; color: #777; margin-top: 10px; word-break: break-all; }
      </style></head><body>${pages}
      <script>window.onload = function () { window.focus(); window.print(); };</script>
      </body></html>`)
    win.document.close()
  }

  return (
    <div style={st.page}>
      {toast && <Toast toast={toast} />}
      <div style={st.qrHead}>
        <Button variant="secondary" onClick={onBack}>← Back to bays</Button>
        <Button icon={<Printer size={16} strokeWidth={2} />} onClick={print} disabled={!codes}>
          Print
        </Button>
      </div>
      <Callout tone="info">
        One page per bay. Tape each sheet at its bay. The code opens the phone's browser. Players who use the
        installed app get there faster with its Check in button.
      </Callout>
      {error && <Callout tone="danger">{error}</Callout>}
      {!codes && !error && <p style={st.muted}>Making QR codes…</p>}
      {codes && (
        <div style={st.qrGrid}>
          {codes.map(({ bay, url, dataUrl }) => (
            <Card key={bay.id} style={{ textAlign: 'center' }}>
              <div style={st.qrBay}>{bayName(bay.label)}</div>
              <img src={dataUrl} alt={`QR code for ${bayName(bay.label)}`} style={st.qrImg} />
              <div style={st.qrCta}>Scan to check in your team</div>
              <div style={st.qrUrl}>{url}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

const st = {
  page: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '40px' },
  muted: { textAlign: 'center', color: 'var(--gray-500)', fontSize: '14px', padding: '24px 0' },
  hint: { fontSize: '13px', color: 'var(--gray-600)', lineHeight: 1.5, margin: '4px 0 12px' },

  heroRow: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' },
  heroTitle: { fontSize: '20px', fontWeight: 800, color: '#fff' },
  heroSub: { fontSize: '13px', color: 'rgba(255,255,255,0.75)', marginTop: '4px' },
  clearAllBtn: { minHeight: '52px', fontSize: '16px', padding: '12px 22px' },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '12px' },
  bayHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', minHeight: '30px' },
  bayLabel: { fontSize: '18px', fontWeight: 900, color: 'var(--green-dark)' },
  open: { fontSize: '13px', color: 'var(--gray-400)', padding: '6px 0 4px' },
  teamBlock: { borderTop: '1px solid var(--gray-100)', padding: '8px 0 4px' },
  teamRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  teamName: { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  time: { fontSize: '11px', color: 'var(--gray-400)', marginLeft: 'auto' },
  removeBtn: { color: 'var(--gray-500)', padding: '4px', cursor: 'pointer', display: 'flex' },
  doneBadge: {
    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px',
    color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '2px 6px', borderRadius: '8px',
  },
  playerRow: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--gray-600)', padding: '2px 0 0 2px' },
  thru: { fontSize: '12px', fontWeight: 700 },

  manualRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--gray-100)' },
  select: {
    padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)',
    fontSize: '14px', background: 'var(--white)', minWidth: '140px',
  },

  countRow: { display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' },
  renameList: { display: 'flex', flexDirection: 'column' },
  renameRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderTop: '1px solid var(--gray-100)', fontSize: '14px' },

  qrHead: { display: 'flex', justifyContent: 'space-between', gap: '10px' },
  qrGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  qrBay: { fontSize: '28px', fontWeight: 900, color: 'var(--green-dark)' },
  qrImg: { width: '100%', maxWidth: '220px', aspectRatio: '1', margin: '8px auto', display: 'block' },
  qrCta: { fontSize: '14px', fontWeight: 700 },
  qrUrl: { fontSize: '10px', color: 'var(--gray-500)', wordBreak: 'break-all', marginTop: '4px' },
}
