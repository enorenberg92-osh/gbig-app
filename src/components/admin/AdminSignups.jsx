import React, { useState, useEffect, useCallback } from 'react'
import { Inbox, KeyRound, Copy, RefreshCw, XCircle, RotateCcw, ChevronDown, ChevronUp, Link2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, Callout, EmptyState, Card, TabGroup } from '../ui'
import { mutationErrorMessage } from '../../lib/rpcErrors'

// Inbox for sign-ups that arrive from the website form through the
// signup-webhook edge function. Clean pairs are imported automatically
// (players + team in the working league); everything else waits here.

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signup-webhook`

const STATUS = {
  imported:     { label: 'Imported',     bg: 'var(--green-xlight)', color: 'var(--green-dark)', border: 'var(--green)' },
  needs_review: { label: 'Needs review', bg: '#fff3cd',             color: '#856404',           border: '#ffc107' },
  duplicate:    { label: 'Duplicate',    bg: 'var(--gray-100)',     color: 'var(--gray-600)',   border: 'var(--gray-200)' },
  dismissed:    { label: 'Dismissed',    bg: 'var(--gray-100)',     color: 'var(--gray-500)',   border: 'var(--gray-200)' },
}

// Keys the WPForms Webhooks addon (or Zapier/Make) should send.
const FIELD_KEYS = [
  ['p1_name', 'Player 1 name'], ['p1_email', 'Player 1 email'], ['p1_phone', 'Player 1 phone'],
  ['p1_handicap', 'Player 1 9-hole handicap'], ['p2_name', 'Player 2 name'], ['p2_email', 'Player 2 email'],
  ['p2_phone', 'Player 2 phone'], ['p2_handicap', 'Player 2 9-hole handicap'], ['day', 'Day'],
  ['time', 'Time'], ['message', 'Message'], ['team_name', 'Team name (optional)'],
]

function timeAgo(dateStr) {
  const diff  = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export default function AdminSignups({ onPendingChange }) {
  const { locationId } = useLocation()
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [filter, setFilter]     = useState('all')
  const [busyId, setBusyId]     = useState(null)
  const [openRaw, setOpenRaw]   = useState(null)
  const [keyInfo, setKeyInfo]   = useState(null)   // { key_prefix, created_at, last_used_at } | null
  const [newKey, setNewKey]     = useState(null)   // plaintext, shown once
  const [keyBusy, setKeyBusy]   = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [toast, setToast]       = useState(null)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    const [subsRes, keyRes] = await Promise.all([
      supabase
        .from('signup_submissions')
        .select('id, status, parsed, raw_payload, error_text, team_id, created_player_ids, source, created_at')
        .eq('location_id', locationId)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('location_integration_keys')
        .select('key_prefix, created_at, last_used_at')
        .eq('location_id', locationId)
        .eq('kind', 'signup_webhook')
        .maybeSingle(),
    ])
    if (subsRes.error) {
      setLoadError(mutationErrorMessage(subsRes.error, 'receive website sign-ups'))
    } else {
      setLoadError(null)
      setRows(subsRes.data || [])
    }
    setKeyInfo(keyRes.data || null)
    setLoading(false)
  }, [locationId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  // Default to the review queue when something is waiting.
  const pending = rows.filter(r => r.status === 'needs_review').length
  useEffect(() => {
    if (!loading && pending > 0) setFilter(f => (f === 'all' ? 'needs_review' : f))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  async function refreshAfterChange() {
    await load()
    onPendingChange?.()
  }

  async function handleRetry(row) {
    setBusyId(row.id)
    const { data, error } = await supabase.rpc('admin_retry_signup', { p_submission_id: row.id })
    setBusyId(null)
    if (error) { showToast(mutationErrorMessage(error, 'retry this sign-up'), 'error'); return }
    if (data?.status === 'imported') showToast(`Imported ${data.team_name || 'team'}`)
    else showToast(data?.reason || 'Still needs review', 'error')
    refreshAfterChange()
  }

  async function handleDismiss(row) {
    setBusyId(row.id)
    const { error } = await supabase.rpc('admin_dismiss_signup', { p_submission_id: row.id })
    setBusyId(null)
    if (error) { showToast(mutationErrorMessage(error, 'dismiss this sign-up'), 'error'); return }
    showToast('Sign-up dismissed')
    refreshAfterChange()
  }

  async function handleRotate() {
    if (keyInfo && !window.confirm('Generate a new key? The current webhook URL stops working immediately — you will need to paste the new one into WPForms.')) return
    setKeyBusy(true)
    const { data, error } = await supabase.rpc('admin_rotate_signup_key', { p_location_id: locationId })
    setKeyBusy(false)
    if (error) { showToast(mutationErrorMessage(error, 'generate a sign-up key'), 'error'); return }
    setNewKey(data)
    load()
  }

  async function handleRevoke() {
    if (!window.confirm('Turn off website sign-ups? The webhook URL stops working until you generate a new key.')) return
    setKeyBusy(true)
    const { error } = await supabase.rpc('admin_revoke_signup_key', { p_location_id: locationId })
    setKeyBusy(false)
    if (error) { showToast(mutationErrorMessage(error, 'revoke the sign-up key'), 'error'); return }
    setNewKey(null)
    showToast('Website sign-ups turned off')
    load()
  }

  async function handleCopy(text, what) {
    if (await copyText(text)) showToast(`${what} copied`)
    else showToast('Copy failed — select the text and copy it manually', 'error')
  }

  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  const visible = filter === 'all' ? rows : rows.filter(r => r.status === filter)
  const fullUrl = newKey ? `${WEBHOOK_URL}?key=${newKey}` : null

  return (
    <div style={styles.page}>
      <Toast toast={toast} />

      {/* ── Integration key ──────────────────────────────────── */}
      <Card title="Website sign-up form">
        <p style={styles.hint}>
          Connect the WordPress sign-up form so new teams land here automatically and you get a
          push notification. Clean pairs are added to the working league straight away.
        </p>

        {newKey ? (
          <div style={styles.keyBox}>
            <Callout tone="warning" style={{ marginBottom: 10 }}>
              Copy this now — the key is only shown once. Paste the full URL into WPForms (Webhooks → Request URL).
            </Callout>
            <div style={styles.fieldLabel}>Webhook URL</div>
            <div style={styles.codeRow}>
              <code style={styles.code}>{fullUrl}</code>
              <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => handleCopy(fullUrl, 'URL')}>Copy</Button>
            </div>
            <div style={styles.fieldLabel}>Key only (for an X-Signup-Key header)</div>
            <div style={styles.codeRow}>
              <code style={styles.code}>{newKey}</code>
              <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => handleCopy(newKey, 'Key')}>Copy</Button>
            </div>
          </div>
        ) : keyInfo ? (
          <div style={styles.keyStatus}>
            <KeyRound size={15} strokeWidth={2} color="var(--green)" />
            <span>
              Connected · key <code style={styles.inlineCode}>{keyInfo.key_prefix}…</code>
              {' · '}{keyInfo.last_used_at ? `last sign-up ${timeAgo(keyInfo.last_used_at)}` : 'no sign-ups received yet'}
            </span>
          </div>
        ) : (
          <div style={styles.keyStatus}>
            <Link2 size={15} strokeWidth={2} color="var(--gray-500)" />
            <span>Not connected yet — generate a key to get the webhook URL.</span>
          </div>
        )}

        <div style={styles.actionsRow}>
          <Button
            size="sm"
            icon={<KeyRound size={13} />}
            loading={keyBusy}
            onClick={handleRotate}
          >
            {keyInfo ? 'Rotate key' : 'Generate key'}
          </Button>
          {keyInfo && (
            <Button size="sm" variant="danger" disabled={keyBusy} onClick={handleRevoke}>Turn off</Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            iconRight={showSetup ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            onClick={() => setShowSetup(s => !s)}
          >
            Setup
          </Button>
        </div>

        {showSetup && (
          <div style={styles.setup}>
            <div style={styles.step}>1. WPForms → your sign-up form → <strong>Settings → Webhooks</strong> → Add New Webhook.</div>
            <div style={styles.step}>2. Request URL: the webhook URL above · Method: <strong>POST</strong> · Format: <strong>JSON</strong>.</div>
            <div style={styles.step}>3. Request Body — add these keys and pick the matching form field for each:</div>
            <div style={styles.keyGrid}>
              {FIELD_KEYS.map(([k, label]) => (
                <React.Fragment key={k}>
                  <code style={styles.inlineCode}>{k}</code>
                  <span style={styles.keyLabel}>{label}</span>
                </React.Fragment>
              ))}
            </div>
            <div style={styles.step}>No Webhooks addon? A Zapier or Make "Webhooks → POST" step with the same keys works too.</div>
          </div>
        )}
      </Card>

      {/* ── Inbox ─────────────────────────────────────────────── */}
      <TabGroup
        options={[
          { id: 'all',          label: 'All',      count: rows.length || undefined },
          { id: 'needs_review', label: 'Review',   count: counts.needs_review },
          { id: 'imported',     label: 'Imported', count: counts.imported },
          { id: 'duplicate',    label: 'Dupes',    count: counts.duplicate },
          { id: 'dismissed',    label: 'Dismissed', count: counts.dismissed },
        ]}
        value={filter}
        onChange={setFilter}
      />

      {loadError && <Callout tone="danger">{loadError}</Callout>}

      {loading ? (
        <div style={styles.muted}>Loading sign-ups…</div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Inbox size={40} strokeWidth={1.5} />}
          title={filter === 'needs_review' ? 'Nothing to review' : 'No sign-ups yet'}
          description="Entries from the website form appear here as soon as they're submitted."
        />
      ) : (
        visible.map(row => {
          const p = row.parsed || {}
          const chip = STATUS[row.status] || STATUS.needs_review
          const canRetry = row.status !== 'imported'
          const canDismiss = row.status === 'needs_review' || row.status === 'duplicate'
          return (
            <Card key={row.id} padding="md">
              <div style={styles.rowHead}>
                <span style={{ ...styles.chip, background: chip.bg, color: chip.color, borderColor: chip.border }}>
                  {chip.label}
                </span>
                <span style={styles.teamName}>{p.teamName || 'Unnamed team'}</span>
                <span style={styles.when}>
                  {timeAgo(row.created_at)}{row.source && row.source !== 'webhook' ? ` · ${row.source}` : ''}
                </span>
              </div>

              {[p.p1, p.p2].filter(pl => pl && pl.fullName).map((pl, i) => (
                <div key={i} style={styles.player}>
                  <span style={styles.playerName}>{pl.fullName}</span>
                  <span style={styles.playerMeta}>
                    {[pl.email, pl.phone, pl.handicap != null && pl.handicap !== '' ? `HCP ${pl.handicap}` : null]
                      .filter(Boolean).join(' · ')}
                  </span>
                </div>
              ))}
              {(p.slot || p.message) && (
                <div style={styles.extra}>
                  {p.slot && <div><strong>Slot:</strong> {p.slot}</div>}
                  {p.message && <div style={styles.message}>“{p.message}”</div>}
                </div>
              )}

              {row.error_text && row.status !== 'dismissed' && (
                <Callout tone={row.status === 'duplicate' ? 'info' : 'warning'} style={{ marginTop: 10, fontSize: 13 }}>
                  {row.error_text}
                </Callout>
              )}
              {row.status === 'imported' && row.created_player_ids?.length < 2 && (
                <div style={styles.note}>Returning player{row.created_player_ids?.length === 0 ? 's' : ''} matched by email.</div>
              )}

              <div style={styles.actionsRow}>
                {canRetry && (
                  <Button
                    size="sm"
                    icon={row.status === 'needs_review' ? <RefreshCw size={13} /> : <RotateCcw size={13} />}
                    loading={busyId === row.id}
                    disabled={busyId != null && busyId !== row.id}
                    onClick={() => handleRetry(row)}
                  >
                    {row.status === 'needs_review' ? 'Retry import' : 'Import anyway'}
                  </Button>
                )}
                {canDismiss && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<XCircle size={13} />}
                    disabled={busyId != null}
                    onClick={() => handleDismiss(row)}
                  >
                    Dismiss
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setOpenRaw(openRaw === row.id ? null : row.id)}
                >
                  {openRaw === row.id ? 'Hide raw' : 'Raw'}
                </Button>
              </div>
              {openRaw === row.id && (
                <pre style={styles.raw}>{JSON.stringify(row.raw_payload, null, 2)}</pre>
              )}
            </Card>
          )
        })
      )}
    </div>
  )
}

const styles = {
  page: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    paddingBottom: '40px',
  },
  hint: {
    fontSize: '13px',
    color: 'var(--gray-600)',
    lineHeight: 1.5,
    margin: '0 0 12px',
  },
  keyBox: { marginBottom: 4 },
  fieldLabel: {
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    color: 'var(--gray-500)',
    margin: '8px 0 4px',
  },
  codeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  code: {
    flex: 1,
    minWidth: 0,
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'var(--off-white)',
    border: '1px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 10px',
    wordBreak: 'break-all',
    userSelect: 'all',
  },
  inlineCode: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'var(--gray-100)',
    borderRadius: 4,
    padding: '1px 5px',
  },
  keyStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: '13px',
    color: 'var(--gray-600)',
  },
  actionsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  setup: {
    marginTop: 12,
    padding: '12px',
    background: 'var(--off-white)',
    borderRadius: 'var(--radius-sm)',
    fontSize: '13px',
    color: 'var(--gray-600)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  step: { lineHeight: 1.5 },
  keyGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: '4px 10px',
    alignItems: 'center',
    paddingLeft: 12,
  },
  keyLabel: { fontSize: '12px', color: 'var(--gray-500)' },
  muted: { fontSize: '13px', color: 'var(--gray-500)', padding: '12px 4px' },
  rowHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    fontSize: '11px',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '12px',
    border: '1px solid',
    whiteSpace: 'nowrap',
  },
  teamName: {
    fontWeight: 700,
    fontSize: '15px',
    color: 'var(--green-dark)',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  when: { fontSize: '12px', color: 'var(--gray-400)', whiteSpace: 'nowrap' },
  player: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '2px 8px',
    padding: '3px 0',
  },
  playerName: { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  playerMeta: { fontSize: '12px', color: 'var(--gray-500)', wordBreak: 'break-all' },
  extra: {
    fontSize: '12px',
    color: 'var(--gray-600)',
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  message: { fontStyle: 'italic', whiteSpace: 'pre-wrap' },
  note: { fontSize: '12px', color: 'var(--gray-500)', marginTop: 8 },
  raw: {
    marginTop: 10,
    fontSize: '11px',
    background: 'var(--off-white)',
    border: '1px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px',
    maxHeight: 240,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
}
