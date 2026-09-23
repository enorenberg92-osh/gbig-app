import React, { useState, useEffect } from 'react'
import { useLocation as useRouterLocation, useNavigate } from 'react-router-dom'
import {
  Users, Upload, User, Lock, Unlock, Target, KeyRound,
  CheckCircle2, BarChart3, Handshake, X, Plus, Inbox, Search,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import PlayerProfile from '../PlayerProfile'
import AdminImport from './AdminImport'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'
import { Button, Toast, EmptyState, Input } from '../ui'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { mutationErrorMessage } from '../../lib/rpcErrors'

// `password` is write-only: it goes to the create-player-account Edge Function
// (create or reset mode) and is never stored on the players row — the old
// players.league_password column was readable by everyone in the location.
const EMPTY_PLAYER_FORM = { name: '', email: '', handicap: '', in_skins: false, handicap_locked: false, password: '' }
const MIN_PASSWORD_LENGTH = 6

// Calls the create-player-account Edge Function with the caller's access
// token (the function verifies we're an admin for the player's location).
// Body is { player_id, email, password } to create/link an account, or
// { mode: 'reset_password', player_id, password } to change the password of
// an existing login. Throws with the function's error message on failure.
async function callPlayerAccountFunction(body) {
  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('You are not signed in.')
  if (typeof body.password === 'string') body = { ...body, password: body.password.trim() }
  const fnRes = await fetch(
    import.meta.env.VITE_SUPABASE_URL + '/functions/v1/create-player-account',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
      body: JSON.stringify(body),
    }
  )
  const fnBody = await fnRes.json().catch(() => null)
  if (!fnRes.ok || fnBody?.error) throw new Error(fnBody?.error || `HTTP ${fnRes.status}`)
  return fnBody
}

// Create (or link) a login for a player and make sure the typed password is
// the one that works. An email that already has a login gets linked with its
// old password untouched, so follow up with a reset (the edge function refuses
// it when that login belongs to someone outside this admin's locations).
// Returns a short note for the toast.
async function createPlayerLogin(playerId, email, password) {
  const res = await callPlayerAccountFunction({ player_id: playerId, email, password })
  if (!res?.reused) return 'account created! They can sign in now.'
  try {
    await callPlayerAccountFunction({ mode: 'reset_password', player_id: playerId, password })
    return 'linked to their existing login and set the new password.'
  } catch (e) {
    return `linked to their existing login, but its password was NOT changed (${e.message}).`
  }
}
const EMPTY_TEAM_FORM   = { name: '', player1_id: '', player2_id: '' }

export default function AdminPlayers() {
  const { locationId } = useLocation()
  const [players, setPlayers]         = useState([])
  const [teams, setTeams]             = useState([])
  const [loading, setLoading]         = useState(true)
  const [showPlayerForm, setShowPlayerForm] = useState(false)
  const [playerForm, setPlayerForm]   = useState(EMPTY_PLAYER_FORM)
  const [editingPlayer, setEditingPlayer] = useState(null)
  const [showTeamForm, setShowTeamForm]   = useState(false)
  const [teamForm, setTeamForm]       = useState(EMPTY_TEAM_FORM)
  const [editingTeam, setEditingTeam] = useState(null)
  const [swapForm, setSwapForm]       = useState({ out: '', in: '', date: '' })
  const [saving, setSaving]           = useState(false)
  const [toast, setToast]             = useState(null)
  const [dialog, setDialog]           = useState(null)
  const [search, setSearch]           = useState('')
  const [workingLeague, setWorkingLeague] = useState(null)
  // player_id → team_id for ACTIVE memberships (effective_to IS NULL) in the
  // working league. players.team_id is a legacy location-wide column and
  // goes stale across leagues, so roster availability comes from here.
  const [teamByPlayer, setTeamByPlayer] = useState(() => new Map())
  // Inline "Create Account" password prompt: { playerId, password }
  const [accountPrompt, setAccountPrompt] = useState(null)

  // ── URL-driven sub-view state ────────────────────────────────────────────
  // /league/admin/players            → main list + teams (default)
  // /league/admin/players/import     → CSV importer
  // /league/admin/players/:playerId  → admin-mode player profile
  //
  // Keeping this derived from the URL (instead of local state) means admins
  // can deep-link to a specific player's stats, reload without losing the
  // view, and the browser back button behaves as expected.
  const routerLocation = useRouterLocation()
  const navigate       = useNavigate()
  const subPathMatch   = routerLocation.pathname.match(/\/league\/admin\/players\/?([^/?#]*)/)
  const subPath        = (subPathMatch && subPathMatch[1]) || ''
  const isImportView   = subPath === 'import'
  const viewingProfileId = (subPath && !isImportView) ? subPath : null

  useEffect(() => { if (locationId) loadAll() }, [locationId])

  async function loadAll() {
    let league
    try { league = await loadWorkingLeague(supabase, locationId) }
    catch (error) { showToast(error.message, 'error'); setLoading(false); return }
    setWorkingLeague(league)
    const [{ data: plrs, error: plrErr }, { data: tms }, { data: mships, error: mshipErr }] = await Promise.all([
      supabase.from('players').select('*').eq('location_id', locationId).order('name'),
      supabase.from('teams').select('id, name, player1_id, player2_id').eq('location_id', locationId).eq('league_id', league.id).order('created_at', { ascending: true }),
      supabase.from('team_memberships').select('player_id, team_id').eq('league_id', league.id).is('effective_to', null),
    ])
    if (plrErr) console.error('Players load error:', plrErr)
    if (mshipErr) console.error('Team memberships load error:', mshipErr)
    setPlayers(plrs || [])
    setTeams(tms || [])
    setTeamByPlayer(new Map((mships || []).map(m => [m.player_id, m.team_id])))
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // ── Player CRUD ──────────────────────────────────────────────────────────

  async function handleSavePlayer(e) {
    e.preventDefault()

    // Handicap is required by the form; still truncate + clamp on save as
    // defense in depth so a manually typed decimal or out-of-range value
    // can't sneak into the DB. Spec: integers only, [-2, 27] for regular
    // players and [-2, 40] for subs (matches the server-side clamp). If you
    // want different rules for a future league, change the floor/ceil here
    // and the defaults in handicapCalc.js DEFAULT_SETTINGS in tandem.
    const maxHcp = editingPlayer?.is_sub ? 40 : 27
    const rawHcp = parseFloat(playerForm.handicap)
    const handicap = Number.isFinite(rawHcp)
      ? Math.max(-2, Math.min(maxHcp, Math.floor(rawHcp)))
      : null

    const payload = {
      name: playerForm.name.trim(),
      email: playerForm.email.trim().toLowerCase() || null,
      handicap,
      in_skins: playerForm.in_skins,
      handicap_locked: playerForm.handicap_locked,
    }
    // Write-only; blank = no change / no account yet.
    // Trimmed because LoginScreen trims what the player types.
    const password = playerForm.password.trim()
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      showToast(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'error'); return
    }

    if (editingPlayer) {
      setSaving(true)
      const { error } = await supabase.rpc('admin_update_player', {
        p_player_id: editingPlayer.id,
        p_payload: payload,
      })
      if (error) {
        setSaving(false)
        showToast('Error: ' + mutationErrorMessage(error, 'update this player'), 'error'); return
      }
      // A typed password resets the real login password (existing account)
      // or creates the login (no account yet, email on file).
      let msg = 'Player updated!'
      let type = 'success'
      if (password) {
        try {
          if (editingPlayer.user_id) {
            await callPlayerAccountFunction({ mode: 'reset_password', player_id: editingPlayer.id, password })
            msg = 'Player updated & login password changed.'
          } else if (payload.email) {
            msg = 'Player updated & ' + await createPlayerLogin(editingPlayer.id, payload.email, password)
          } else {
            msg = 'Player updated. Password ignored — add an email to create a login.'
            type = 'error'
          }
        } catch (e) {
          msg = `Player updated, but the password change failed: ${e.message}`
          type = 'error'
        }
      }
      setSaving(false)
      showToast(msg, type)
      setShowPlayerForm(false); setEditingPlayer(null); setPlayerForm(EMPTY_PLAYER_FORM)
      loadAll()
      return
    }

    // ── New-player duplicate check ──────────────────────────────────────────
    // Bugs this prevents: admin accidentally adds "Mike" when "Michael" already
    // exists, or re-types a name a second time thinking the first try failed.
    // We match against state (already loaded in loadAll), so no extra DB round
    // trip for the 99% of cases where there's no duplicate.
    //
    // Match rules (either one triggers the warning):
    //   • Email exact match, case-insensitive (stored lowercased, so this is
    //     effectively ==).
    //   • Name match after lowercase + collapsed whitespace.
    const trimmedName = payload.name.toLowerCase().replace(/\s+/g, ' ').trim()
    const matches = players.filter(p => {
      if (payload.email && p.email && p.email.toLowerCase().trim() === payload.email) return true
      if (trimmedName && p.name && p.name.toLowerCase().replace(/\s+/g, ' ').trim() === trimmedName) return true
      return false
    })

    if (matches.length) {
      const matchList = matches.map(p => {
        const parts = [p.name]
        if (p.email) parts.push(p.email)
        if (p.handicap != null) parts.push(`HCP ${p.handicap}`)
        return `• ${parts.join(' — ')}`
      }).join('\n')

      setDialog({
        message:
          `Heads up: a player with a matching name or email already exists in this league:\n\n` +
          `${matchList}\n\n` +
          `Add ${payload.name} anyway?`,
        confirmLabel: 'Add Anyway',
        destructive: false,
        onConfirm: () => doInsertNewPlayer(payload, password),
      })
      return
    }

    await doInsertNewPlayer(payload, password)
  }

  // Extracted insert path — called either directly (no duplicate) or from
  // the "Add Anyway" branch of the duplicate-detection dialog. Keeps the
  // Edge Function call, toast choice, and form reset all in one place.
  async function doInsertNewPlayer(payload, password) {
    setSaving(true)

    const { data: newPlayerId, error: insertError } = await supabase.rpc('admin_create_player', {
      p_location_id: locationId,
      p_payload: payload,
    })

    setSaving(false)
    if (insertError) { showToast('Error: ' + mutationErrorMessage(insertError, 'add this player'), 'error'); return }

    // Create a login account when both an email and a password were given
    if (payload.email && password && newPlayerId) {
      try {
        showToast('Player added & ' + await createPlayerLogin(newPlayerId, payload.email, password))
      } catch (e) {
        showToast(`Player added, but account creation failed: ${e.message}`, 'error')
      }
    } else if (payload.email) {
      showToast('Player added! (No password set — use Create Account to give them a login.)')
    } else {
      showToast('Player added! (No email — add one later to create a login.)')
    }

    setShowPlayerForm(false); setEditingPlayer(null); setPlayerForm(EMPTY_PLAYER_FORM)
    loadAll()
  }

  // Cascaded player delete.
  //
  // Previously this only unlinked team membership and attempted `.delete()` on
  // the player row — which Postgres refused because `scores.player_id`,
  // `subs.player_id`, `follows.*_id`, and `messages.*_id` all FK into
  // `players` with ON DELETE NO ACTION. That left admins with "update or
  // delete on table players violates foreign key constraint …" errors and no
  // way forward short of hand-running SQL.
  //
  // New flow: count children up front so the confirm dialog tells the admin
  // exactly what's about to vanish, then delete them in dependency order
  // inside the confirm handler. Each step checks for an error and aborts on
  // failure — we never want a half-deleted player row.
  async function handleDeletePlayer(player) {
    // Count every child table that references this player. `head: true, count: 'exact'`
    // asks Postgres for the row count without returning the rows themselves.
    let counts = { scores: 0, subs: 0, follows: 0, messages: 0, ledger: 0 }
    try {
      const [scoresRes, subsRes, followsRes, messagesRes, ledgerRes] = await Promise.all([
        supabase.from('scores')
          .select('id', { count: 'exact', head: true })
          .eq('player_id', player.id),
        supabase.from('subs')
          .select('id', { count: 'exact', head: true })
          .or(`player_id.eq.${player.id},sub_player_id.eq.${player.id}`),
        supabase.from('follows')
          .select('follower_id', { count: 'exact', head: true })
          .or(`follower_id.eq.${player.id},following_id.eq.${player.id}`),
        supabase.from('messages')
          .select('id', { count: 'exact', head: true })
          .or(`sender_id.eq.${player.id},recipient_id.eq.${player.id}`),
        supabase.from('ledger')
          .select('id', { count: 'exact', head: true })
          .eq('player_id', player.id),
      ])
      counts = {
        scores:   scoresRes.count   ?? 0,
        subs:     subsRes.count     ?? 0,
        follows:  followsRes.count  ?? 0,
        messages: messagesRes.count ?? 0,
        ledger:   ledgerRes.count   ?? 0,
      }
    } catch (e) {
      // If the pre-count fails (RLS, network), fall through with zeros; the
      // admin still gets a confirm dialog and the delete will attempt anyway.
      console.warn('Pre-delete child count failed:', e)
    }

    const childLines = []
    if (counts.scores)   childLines.push(`${counts.scores} score row${counts.scores === 1 ? '' : 's'}`)
    if (counts.subs)     childLines.push(`${counts.subs} sub request${counts.subs === 1 ? '' : 's'}`)
    if (counts.follows)  childLines.push(`${counts.follows} friendship link${counts.follows === 1 ? '' : 's'}`)
    if (counts.messages) childLines.push(`${counts.messages} message${counts.messages === 1 ? '' : 's'}`)

    // Money-list (ledger) entries are financial history: the server refuses
    // the delete rather than cascading them away, so say so up front.
    if (counts.ledger) {
      showToast(`${player.name} has ${counts.ledger} money-list entr${counts.ledger === 1 ? 'y' : 'ies'} and can't be removed. Remove those entries first.`, 'error')
      return
    }

    const preamble = `Remove ${player.name}? This cannot be undone.`
    const message  = childLines.length
      ? `${preamble}\n\nThe following will also be permanently deleted:\n• ${childLines.join('\n• ')}`
      : `${preamble}\n\nNo scores, subs, or social activity are attached to this player.`

    setDialog({
      message,
      confirmLabel: 'Remove Player',
      destructive: true,
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_delete_player', { p_player_id: player.id })
        if (error) { showToast('Error: ' + mutationErrorMessage(error, 'remove this player'), 'error'); return }
        showToast(`${player.name} and all related data removed.`)
        loadAll()
      },
    })
  }

  // "Create Account" opens an inline password prompt on the player's row;
  // this runs when the admin submits it.
  async function handleCreateAccount(player, rawPassword) {
    const password = (rawPassword || '').trim()
    if (!player.email) {
      showToast('Add an email address for this player first.', 'error'); return
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      showToast(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'error'); return
    }
    setSaving(true)
    try {
      showToast(`${player.name}: ` + await createPlayerLogin(player.id, player.email, password))
      setAccountPrompt(null)
      loadAll()
    } catch (e) {
      showToast('Error: ' + e.message, 'error')
    }
    setSaving(false)
  }

  function startEditPlayer(player) {
    setPlayerForm({ name: player.name || '', email: player.email || '', handicap: player.handicap != null ? String(player.handicap) : '', in_skins: player.in_skins || false, handicap_locked: player.handicap_locked || false, password: '' })
    setEditingPlayer(player)
    setShowPlayerForm(true)
    setShowTeamForm(false)
  }

  // ── Team CRUD ────────────────────────────────────────────────────────────

  async function handleSaveTeam(e) {
    e.preventDefault()
    if (teamForm.player1_id && teamForm.player1_id === teamForm.player2_id) {
      showToast('Player 1 and Player 2 must be different.', 'error'); return
    }
    setSaving(true)

    const teamName = teamForm.name.trim() || buildAutoName()

    const payload = {
      name: teamName,
      player1_id: teamForm.player1_id || null,
      player2_id: teamForm.player2_id || null,
    }

    if (!workingLeague) { setSaving(false); showToast('Choose a working league first.', 'error'); return }
    if (!payload.player1_id || !payload.player2_id) {
      setSaving(false); showToast('A team requires exactly two players.', 'error'); return
    }
    const { error } = await supabase.rpc('admin_save_team', {
      p_team_id: editingTeam?.id || null,
      p_league_id: workingLeague.id,
      p_name: payload.name,
      p_player_ids: [payload.player1_id, payload.player2_id],
    })

    setSaving(false)
    if (error) { showToast('Error: ' + mutationErrorMessage(error, 'save this team'), 'error'); return }
    showToast(editingTeam ? 'Team updated!' : 'Team created!')
    setShowTeamForm(false); setEditingTeam(null); setTeamForm(EMPTY_TEAM_FORM)
    loadAll()
  }

  function handleDeleteTeam(team) {
    const p1 = players.find(p => p.id === team.player1_id)
    const p2 = players.find(p => p.id === team.player2_id)
    const names = [p1?.name, p2?.name].filter(Boolean).join(' & ')
    setDialog({
      message: `Delete Team ${teamNumber(team)} "${team.name}"${names ? ` (${names})` : ''}? Players will become unassigned.`,
      confirmLabel: 'Delete Team',
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_delete_team', { p_team_id: team.id })
        if (error) { showToast('Error: ' + mutationErrorMessage(error, 'delete this team'), 'error'); return }
        showToast('Team deleted.')
        loadAll()
      },
    })
  }

  async function handleMidSeasonSwap() {
    const { error } = await supabase.rpc('admin_swap_team_member', {
      p_team_id: editingTeam.id,
      p_out_player_id: swapForm.out,
      p_in_player_id: swapForm.in,
      p_effective_date: swapForm.date,
    })
    if (error) { showToast('Error: ' + mutationErrorMessage(error, 'swap players'), 'error'); return }
    showToast('Swap saved — past weeks stay with the outgoing player.')
    setSwapForm({ out: '', in: '', date: '' })
    setShowTeamForm(false); setEditingTeam(null)
    loadAll()
  }

  function startEditTeam(team) {
    setTeamForm({ name: team.name || '', player1_id: team.player1_id || '', player2_id: team.player2_id || '' })
    setSwapForm({ out: '', in: '', date: '' })
    setEditingTeam(team)
    setShowTeamForm(true)
    setShowPlayerForm(false)
  }

  function buildAutoName() {
    const p1 = players.find(p => p.id === teamForm.player1_id)
    const p2 = players.find(p => p.id === teamForm.player2_id)
    const lastName = n => n?.trim().split(' ').pop() || ''
    if (p1 && p2) return `${lastName(p1.name)}/${lastName(p2.name)}`
    if (p1) return lastName(p1.name)
    return `Team ${teams.length + 1}`
  }

  function teamNumber(team) {
    return teams.findIndex(t => t.id === team.id) + 1
  }

  // Players available for team assignment: no active membership in the
  // working league, or already on this team.
  function availablePlayers(slot) {
    const currentTeamId = editingTeam?.id
    const otherSlot = slot === 'p1' ? teamForm.player2_id : teamForm.player1_id
    return players.filter(p => {
      const teamId = teamByPlayer.get(p.id)
      return (!teamId || teamId === currentTeamId) && p.id !== otherSlot
    })
  }

  const filtered = players.filter(p =>
    p.name?.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase())
  )

  const unassigned = players.filter(p => !teamByPlayer.has(p.id))

  if (loading) return <div style={styles.loading}>Loading…</div>

  // ── Admin player profile view ────────────────────────────────────────────
  if (viewingProfileId) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <PlayerProfile
          session={null}
          playerId={viewingProfileId}
          onBack={() => navigate('/league/admin/players')}
        />
      </div>
    )
  }

  // ── Import sub-view ──────────────────────────────────────────────────────
  if (isImportView) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={styles.subNav}>
          <button
            style={{ ...styles.subNavBtn, ...(!isImportView ? styles.subNavActive : {}) }}
            onClick={() => navigate('/league/admin/players')}
          >
            <Users size={15} strokeWidth={2.25} style={{ verticalAlign: '-3px', marginRight: 6 }} />
            Players &amp; Teams
          </button>
          <button
            style={{ ...styles.subNavBtn, ...(isImportView ? styles.subNavActive : {}) }}
            onClick={() => navigate('/league/admin/players/import')}
          >
            <Upload size={15} strokeWidth={2.25} style={{ verticalAlign: '-3px', marginRight: 6 }} />
            Import from CSV
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
        <AdminImport leagueId={workingLeague?.id || null} />
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {/* Sub-nav toggle */}
      <div style={styles.subNav}>
        <button
          style={{ ...styles.subNavBtn, ...(!isImportView ? styles.subNavActive : {}) }}
          onClick={() => navigate('/league/admin/players')}
        >
          <Users size={15} strokeWidth={2.25} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          Players &amp; Teams
        </button>
        <button
          style={{ ...styles.subNavBtn, ...(isImportView ? styles.subNavActive : {}) }}
          onClick={() => navigate('/league/admin/players/import')}
        >
          <Upload size={15} strokeWidth={2.25} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          Import from CSV
        </button>
      </div>
      <Toast toast={toast} />

      {/* ── PLAYERS SECTION ── */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>
          <User size={18} strokeWidth={2} style={{ verticalAlign: '-4px', marginRight: 8, color: 'var(--green-dark)' }} />
          Players
        </h2>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={15} strokeWidth={2.5} />}
          onClick={() => { setShowPlayerForm(true); setEditingPlayer(null); setPlayerForm(EMPTY_PLAYER_FORM); setShowTeamForm(false) }}
        >
          Add Player
        </Button>
      </div>

      {showPlayerForm && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>{editingPlayer ? 'Edit Player' : 'New Player'}</h3>
          <form onSubmit={handleSavePlayer} style={styles.form}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Full Name *</label>
              <input style={styles.input} value={playerForm.name} onChange={e => setPlayerForm(f => ({ ...f, name: e.target.value }))} placeholder="John Smith" required />
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Email</label>
              <input type="email" style={styles.input} value={playerForm.email} onChange={e => setPlayerForm(f => ({ ...f, email: e.target.value }))} placeholder="john@example.com" />
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>{editingPlayer?.user_id ? 'Reset Login Password' : 'Set Login Password'}</label>
              <input
                type="text"
                style={styles.input}
                value={playerForm.password}
                onChange={e => setPlayerForm(f => ({ ...f, password: e.target.value }))}
                placeholder={editingPlayer?.user_id ? 'Leave blank to keep current password' : `At least ${MIN_PASSWORD_LENGTH} characters`}
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
              <span style={styles.hint}>
                {editingPlayer?.user_id
                  ? 'Blank = no change. A new password takes effect immediately.'
                  : 'Needs an email too. Leave blank to create their login later. Not stored — share it with the player directly.'}
              </span>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Handicap</label>
              <input
                type="number"
                step="1"
                min="-2"
                max={editingPlayer?.is_sub ? 40 : 27}
                required
                style={styles.input}
                value={playerForm.handicap}
                onChange={e => setPlayerForm(f => ({ ...f, handicap: e.target.value }))}
                placeholder="e.g. 12"
              />
              <span style={styles.hint}>Whole numbers only, -2 to {editingPlayer?.is_sub ? 40 : 27}.</span>
            </div>

            {/* Handicap Lock Toggle */}
            <div
              style={{
                ...styles.lockToggleRow,
                background: playerForm.handicap_locked ? '#fff0f0' : 'var(--gray-100)',
                border: `1.5px solid ${playerForm.handicap_locked ? '#c53030' : 'var(--gray-200)'}`,
              }}
              onClick={() => setPlayerForm(f => ({ ...f, handicap_locked: !f.handicap_locked }))}
            >
              <div style={styles.skinsToggleLeft}>
                <span style={{ display: 'flex', alignItems: 'center', color: playerForm.handicap_locked ? '#c53030' : 'var(--gray-500)' }}>
                  {playerForm.handicap_locked
                    ? <Lock size={18} strokeWidth={2} />
                    : <Unlock size={18} strokeWidth={2} />}
                </span>
                <div>
                  <div style={styles.skinsToggleLabel}>Lock Handicap</div>
                  <div style={styles.skinsToggleSub}>
                    {playerForm.handicap_locked
                      ? 'Locked — auto-recalculation will not change this handicap'
                      : 'Unlocked — handicap will update when recalculated'}
                  </div>
                </div>
              </div>
              <div style={{ ...styles.skinsToggleSwitch, background: playerForm.handicap_locked ? '#c53030' : 'var(--gray-200)' }}>
                <div style={{ ...styles.skinsToggleKnob, transform: playerForm.handicap_locked ? 'translateX(18px)' : 'translateX(0)' }} />
              </div>
            </div>

            {/* Skins Toggle */}
            <div
              style={{
                ...styles.skinsToggleRow,
                background: playerForm.in_skins ? '#fff8e1' : 'var(--gray-100)',
                border: `1.5px solid ${playerForm.in_skins ? '#f6c90e' : 'var(--gray-200)'}`,
              }}
              onClick={() => setPlayerForm(f => ({ ...f, in_skins: !f.in_skins }))}
            >
              <div style={styles.skinsToggleLeft}>
                <span style={{ display: 'flex', alignItems: 'center', color: playerForm.in_skins ? '#b45309' : 'var(--gray-500)' }}>
                  <Target size={18} strokeWidth={2} />
                </span>
                <div>
                  <div style={styles.skinsToggleLabel}>In Skins Game</div>
                  <div style={styles.skinsToggleSub}>Player's scores count toward weekly skins</div>
                </div>
              </div>
              <div style={{ ...styles.skinsToggleSwitch, background: playerForm.in_skins ? '#f6c90e' : 'var(--gray-200)' }}>
                <div style={{ ...styles.skinsToggleKnob, transform: playerForm.in_skins ? 'translateX(18px)' : 'translateX(0)' }} />
              </div>
            </div>

            <div style={styles.formActions}>
              <Button type="submit" variant="primary" fullWidth loading={saving} loadingText="Saving…">
                {editingPlayer ? 'Update Player' : 'Add Player'}
              </Button>
              <Button type="button" variant="secondary" fullWidth onClick={() => { setShowPlayerForm(false); setEditingPlayer(null) }}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <div style={styles.searchWrap}>
            <Input
              type="search"
              placeholder="Search players…"
              prefixIcon={<Search size={14} strokeWidth={2.25} />}
              size="sm"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <span style={styles.count}>{search.trim() ? filtered.length : players.length}</span>
        </div>
        {!search.trim() ? (
          <EmptyState
            icon={<Search size={36} strokeWidth={1.5} />}
            title="Search to find a player"
            description="Start typing a name or email above to see matching players."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox size={36} strokeWidth={1.5} />}
            title="No matches"
            description={`No players match "${search}".`}
          />
        ) : (
          filtered.map(player => {
            const teamId = teamByPlayer.get(player.id)
            const team = teamId ? teams.find(t => t.id === teamId) : null
            const num  = team ? teamNumber(team) : null
            return (
              <div key={player.id} style={styles.playerRow}>
                <div style={styles.playerAvatar}>{(player.name || '?')[0].toUpperCase()}</div>
                <div style={styles.playerInfo}>
                  <div style={styles.playerName}>{player.name}</div>
                  <div style={styles.playerMeta}>
                    {player.email && <span>{player.email}</span>}
                    {player.handicap != null && (
                      <span>
                        · HCP {player.handicap}
                        {player.handicap_locked && (
                          <span style={styles.lockBadge} title="Handicap locked">
                            <Lock size={11} strokeWidth={2.5} />
                          </span>
                        )}
                      </span>
                    )}
                    {team
                      ? <span style={styles.teamPill}>Team {num}: {team.name}</span>
                      : <span style={styles.unpairPill}>Unassigned</span>
                    }
                    {player.in_skins
                      ? <span style={styles.skinsPill}>
                          <Target size={11} strokeWidth={2.5} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                          Skins
                        </span>
                      : <span style={styles.noSkinsPill}>No Skins</span>
                    }
                  </div>
                  <div style={styles.playerMeta}>
                    {player.user_id
                      ? <span style={styles.loginPill}>
                          <CheckCircle2 size={12} strokeWidth={2.5} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                          Account active
                        </span>
                      : accountPrompt?.playerId === player.id
                        ? (
                          <form
                            style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                            onSubmit={e => { e.preventDefault(); handleCreateAccount(player, accountPrompt.password) }}
                          >
                            <input
                              type="text"
                              style={{ ...styles.input, padding: '4px 8px', fontSize: 12, width: 150 }}
                              value={accountPrompt.password}
                              onChange={e => setAccountPrompt(a => ({ ...a, password: e.target.value }))}
                              placeholder={`Password (${MIN_PASSWORD_LENGTH}+ chars)`}
                              minLength={MIN_PASSWORD_LENGTH}
                              autoComplete="new-password"
                              autoFocus
                            />
                            <Button type="submit" variant="primary" size="sm" loading={saving}
                              disabled={accountPrompt.password.length < MIN_PASSWORD_LENGTH}
                              style={{ padding: '3px 10px', fontSize: 11, borderRadius: 10 }}>
                              Create
                            </Button>
                            <Button type="button" variant="secondary" size="sm" onClick={() => setAccountPrompt(null)}
                              style={{ padding: '3px 10px', fontSize: 11, borderRadius: 10 }}>
                              Cancel
                            </Button>
                          </form>
                        )
                        : (
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<KeyRound size={13} strokeWidth={2.25} />}
                            onClick={() => {
                              if (!player.email) { showToast('Add an email address for this player first.', 'error'); return }
                              setAccountPrompt({ playerId: player.id, password: '' })
                            }}
                            style={{ background: 'var(--green-dark)', borderColor: 'var(--green-dark)', padding: '3px 10px', fontSize: 11, borderRadius: 10 }}
                          >
                            Create Account
                          </Button>
                        )
                    }
                  </div>
                </div>
                <div style={styles.rowActions}>
                  <Button variant="secondary" size="sm" onClick={() => navigate('/league/admin/players/' + player.id)} aria-label="View profile" icon={<BarChart3 size={16} strokeWidth={2} />} />
                  <Button variant="secondary" size="sm" onClick={() => startEditPlayer(player)} style={{ background: 'var(--green-xlight)', color: 'var(--green)', borderColor: 'var(--green-xlight)' }}>
                    Edit
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => handleDeletePlayer(player)} aria-label="Delete player" icon={<X size={15} strokeWidth={2.5} />} />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── TEAMS SECTION ── */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>
          <Handshake size={18} strokeWidth={2} style={{ verticalAlign: '-4px', marginRight: 8, color: 'var(--green-dark)' }} />
          Teams
        </h2>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={15} strokeWidth={2.5} />}
          onClick={() => { setShowTeamForm(true); setEditingTeam(null); setTeamForm(EMPTY_TEAM_FORM); setShowPlayerForm(false) }}
        >
          Create Team
        </Button>
      </div>

      {showTeamForm && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>
            {editingTeam ? `Edit Team ${teamNumber(editingTeam)}` : `New Team ${teams.length + 1}`}
          </h3>
          <form onSubmit={handleSaveTeam} style={styles.form}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Team Name</label>
              <input
                style={styles.input}
                value={teamForm.name}
                onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))}
                placeholder={`e.g. Smith/Jones (auto-filled if blank)`}
              />
              <span style={styles.hint}>Leave blank to auto-generate from player last names</span>
            </div>
            <div style={styles.row}>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Player 1</label>
                <select style={styles.select} value={teamForm.player1_id} onChange={e => setTeamForm(f => ({ ...f, player1_id: e.target.value }))}>
                  <option value="">— Select —</option>
                  {availablePlayers('p1').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Player 2</label>
                <select style={styles.select} value={teamForm.player2_id} onChange={e => setTeamForm(f => ({ ...f, player2_id: e.target.value }))}>
                  <option value="">— Select —</option>
                  {availablePlayers('p2').map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {unassigned.length === 0 && !editingTeam && (
              <div style={styles.infoNote}>All players are already assigned to teams.</div>
            )}
            <div style={styles.formActions}>
              <Button type="submit" variant="primary" fullWidth loading={saving} loadingText="Saving…">
                {editingTeam ? 'Update Team' : 'Create Team'}
              </Button>
              <Button type="button" variant="secondary" fullWidth onClick={() => { setShowTeamForm(false); setEditingTeam(null) }}>
                Cancel
              </Button>
            </div>
          </form>

          {/* Mid-season swap: history stays with the outgoing player; the team
              slot changes only from the effective date forward. Team edit above
              instead corrects the roster from the start of the season. */}
          {editingTeam && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--gray-200)' }}>
              <div style={{ ...styles.label, marginBottom: 8 }}>Mid-season swap (keeps past weeks with the outgoing player)</div>
              <div style={styles.row}>
                <select style={{ ...styles.select, flex: 1 }} value={swapForm.out} onChange={e => setSwapForm(f => ({ ...f, out: e.target.value }))}>
                  <option value="">— out —</option>
                  {[editingTeam.player1_id, editingTeam.player2_id].filter(Boolean).map(id => (
                    <option key={id} value={id}>{players.find(p => p.id === id)?.name || '?'}</option>
                  ))}
                </select>
                <select style={{ ...styles.select, flex: 1 }} value={swapForm.in} onChange={e => setSwapForm(f => ({ ...f, in: e.target.value }))}>
                  <option value="">— in —</option>
                  {unassigned.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input type="date" style={{ ...styles.input, width: 140 }} value={swapForm.date}
                  onChange={e => setSwapForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <Button type="button" variant="secondary" size="sm" style={{ marginTop: 8 }}
                disabled={!swapForm.out || !swapForm.in || !swapForm.date}
                onClick={handleMidSeasonSwap}>
                Swap from this date
              </Button>
            </div>
          )}
        </div>
      )}

      <div style={styles.card}>
        {teams.length === 0 ? (
          <EmptyState
            icon={<Handshake size={36} strokeWidth={1.5} />}
            title="No teams yet"
            description='Click "Create Team" above to pair players up for the league.'
          />
        ) : (
          teams.map((team, idx) => {
            const p1 = players.find(p => p.id === team.player1_id)
            const p2 = players.find(p => p.id === team.player2_id)
            // Handicaps are integers per league spec, so the sum is already an
            // integer — don't slap a trailing ".0" on it via toFixed(1).
            const combinedHcp = (p1?.handicap != null && p2?.handicap != null)
              ? String(p1.handicap + p2.handicap) : null
            return (
              <div key={team.id} style={styles.teamRow}>
                <div style={styles.teamNum}>{idx + 1}</div>
                <div style={styles.teamInfo}>
                  <div style={styles.teamName}>{team.name || 'Unnamed Team'}</div>
                  <div style={styles.teamPlayers}>
                    <span>{p1 ? p1.name : <em style={{ color: 'var(--gray-300)' }}>Empty slot</em>}</span>
                    <span style={styles.ampersand}>&amp;</span>
                    <span>{p2 ? p2.name : <em style={{ color: 'var(--gray-300)' }}>Empty slot</em>}</span>
                    {combinedHcp && <span style={styles.teamHcp}>· Combined HCP {combinedHcp}</span>}
                  </div>
                </div>
                <div style={styles.rowActions}>
                  <Button variant="secondary" size="sm" onClick={() => startEditTeam(team)} style={{ background: 'var(--green-xlight)', color: 'var(--green)', borderColor: 'var(--green-xlight)' }}>
                    Edit
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => handleDeleteTeam(team)} aria-label="Delete team" icon={<X size={15} strokeWidth={2.5} />} />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

const styles = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  subNav: { display: 'flex', background: 'var(--white)', borderBottom: '1px solid var(--gray-200)', padding: '10px 16px', gap: '8px', flexShrink: 0 },
  subNavBtn: { padding: '7px 18px', borderRadius: '20px', fontSize: '13px', fontWeight: 500, color: 'var(--gray-600)', border: '1.5px solid var(--gray-200)', background: 'var(--white)', cursor: 'pointer', transition: 'all 0.15s' },
  subNavActive: { background: 'var(--green)', color: 'var(--white)', border: '1.5px solid var(--green)', fontWeight: 700 },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' },
  sectionTitle: { fontSize: '15px', fontWeight: 700, color: 'var(--green-dark)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  searchWrap: { flex: 1, marginRight: '10px' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '5px' },
  row: { display: 'flex', gap: '12px' },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  hint: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  select: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  formActions: { display: 'flex', gap: '10px' },
  infoNote: { fontSize: '12px', color: 'var(--gray-400)', fontStyle: 'italic' },
  playerRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  playerAvatar: { width: '36px', height: '36px', background: 'var(--green)', color: 'var(--white)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: 700, flexShrink: 0 },
  playerInfo: { flex: 1, minWidth: 0 },
  playerName: { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  playerMeta: { fontSize: '12px', color: 'var(--gray-400)', display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px', alignItems: 'center' },
  teamPill: { fontSize: '11px', fontWeight: 600, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '1px 7px', borderRadius: '10px' },
  unpairPill: { fontSize: '11px', fontWeight: 600, color: '#7a5c00', background: '#fff8e1', padding: '1px 7px', borderRadius: '10px' },
  rowActions: { display: 'flex', gap: '6px', flexShrink: 0 },
  teamRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--gray-100)' },
  teamNum: { width: '28px', height: '28px', background: 'var(--green)', color: 'var(--white)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 800, flexShrink: 0 },
  teamInfo: { flex: 1, minWidth: 0 },
  teamName: { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  teamPlayers: { fontSize: '12px', color: 'var(--gray-500)', marginTop: '3px', display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' },
  ampersand: { color: 'var(--gray-300)', fontWeight: 700 },
  teamHcp: { fontSize: '11px', color: 'var(--gray-400)' },
  skinsPill:   { fontSize: '11px', fontWeight: 600, color: '#7a5c00', background: '#fff8e1', padding: '1px 7px', borderRadius: '10px', border: '1px solid #f6c90e' },
  noSkinsPill: { fontSize: '11px', fontWeight: 500, color: 'var(--gray-400)', background: 'var(--gray-100)', padding: '1px 7px', borderRadius: '10px' },
  loginPill:        { fontSize: '11px', fontWeight: 600, color: '#166534', background: '#d8f3dc', padding: '2px 9px', borderRadius: '10px' },
  skinsToggleRow:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  skinsToggleLeft:  { display: 'flex', alignItems: 'center', gap: '10px' },
  skinsToggleLabel: { fontSize: '13px', fontWeight: 700, color: 'var(--black)' },
  skinsToggleSub:   { fontSize: '11px', color: 'var(--gray-400)', marginTop: '1px' },
  skinsToggleSwitch: { width: '38px', height: '20px', borderRadius: '20px', padding: '2px', flexShrink: 0, transition: 'background 0.2s', position: 'relative' },
  skinsToggleKnob:   { width: '16px', height: '16px', background: 'white', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s' },
  lockToggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  lockBadge: { display: 'inline-flex', alignItems: 'center', marginLeft: '6px', color: '#c53030' },
}
