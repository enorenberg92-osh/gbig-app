import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import PlayerProfile from '../PlayerProfile'
import AdminImport from './AdminImport'

const EMPTY_PLAYER_FORM = { name: '', email: '', handicap: '', in_skins: false, handicap_locked: false, league_password: 'password' }
const EMPTY_TEAM_FORM   = { name: '', player1_id: '', player2_id: '' }

export default function AdminPlayers() {
  const [players, setPlayers]         = useState([])
  const [teams, setTeams]             = useState([])
  const [loading, setLoading]         = useState(true)
  const [showPlayerForm, setShowPlayerForm] = useState(false)
  const [playerForm, setPlayerForm]   = useState(EMPTY_PLAYER_FORM)
  const [editingPlayer, setEditingPlayer] = useState(null)
  const [showTeamForm, setShowTeamForm]   = useState(false)
  const [teamForm, setTeamForm]       = useState(EMPTY_TEAM_FORM)
  const [editingTeam, setEditingTeam] = useState(null)
  const [saving, setSaving]           = useState(false)
  const [toast, setToast]             = useState(null)
  const [search, setSearch]           = useState('')
  const [viewingProfileId, setViewingProfileId] = useState(null)
  const [activeView, setActiveView] = useState('players') // 'players' | 'import'

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const [{ data: plrs, error: plrErr }, { data: tms }] = await Promise.all([
      supabase.from('players').select('*').order('name'),
      supabase.from('teams').select('id, name, player1_id, player2_id').order('created_at', { ascending: true }),
    ])
    if (plrErr) console.error('Players load error:', plrErr)
    setPlayers(plrs || [])
    setTeams(tms || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // ── Player CRUD ──────────────────────────────────────────────────────────

  async function handleSavePlayer(e) {
    e.preventDefault()
    setSaving(true)

    const payload = {
      name: playerForm.name.trim(),
      email: playerForm.email.trim().toLowerCase() || null,
      handicap: playerForm.handicap !== '' ? parseFloat(playerForm.handicap) : null,
      in_skins: playerForm.in_skins,
      handicap_locked: playerForm.handicap_locked,
      league_password: playerForm.league_password.trim() || 'password',
    }

    let error
    if (editingPlayer) {
      ;({ error } = await supabase.from('players').update(payload).eq('id', editingPlayer.id))
      setSaving(false)
      if (error) { showToast('Error: ' + error.message, 'error'); return }
      showToast('Player updated!')
    } else {
      // Insert and get the new player's ID back so we can create their account
      const { data: newPlayer, error: insertError } = await supabase
        .from('players')
        .insert(payload)
        .select('id')
        .single()

      setSaving(false)
      if (insertError) { showToast('Error: ' + insertError.message, 'error'); return }

      // Automatically create a login account if an email was provided
      if (payload.email && newPlayer?.id) {
        const { data: accountData, error: accountError } = await supabase.functions.invoke('create-player-account', {
          body: {
            player_id: newPlayer.id,
            email:     payload.email,
            password:  payload.league_password || 'password',
          },
        })
        if (accountError || accountData?.error) {
          // Account creation failed — player record still saved, surface the issue
          showToast(`Player added, but account creation failed: ${accountData?.error || accountError?.message}`, 'error')
        } else {
          showToast(`✅ Player added & account created! They can sign in now.`)
        }
      } else {
        showToast('Player added! (No email — add one later to create a login.)')
      }
    }

    setShowPlayerForm(false); setEditingPlayer(null); setPlayerForm(EMPTY_PLAYER_FORM)
    loadAll()
  }

  async function handleDeletePlayer(player) {
    if (!window.confirm(`Remove ${player.name}? This cannot be undone.`)) return
    // Unlink from team
    if (player.team_id) {
      const team = teams.find(t => t.id === player.team_id)
      if (team) {
        const otherField = team.player1_id === player.id ? 'player1_id' : 'player2_id'
        await supabase.from('teams').update({ [otherField]: null }).eq('id', team.id)
      }
      await supabase.from('players').update({ team_id: null }).eq('id', player.id)
    }
    const { error } = await supabase.from('players').delete().eq('id', player.id)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(`${player.name} removed.`)
    loadAll()
  }

  async function handleCreateAccount(player) {
    if (!player.email) {
      showToast('Add an email address for this player first.', 'error'); return
    }
    if (!window.confirm(
      `Create a login account for ${player.name}?\n\nEmail: ${player.email}\nPassword: ${player.league_password || 'password'}\n\nThey can sign in immediately after this.`
    )) return

    const { data, error } = await supabase.functions.invoke('create-player-account', {
      body: {
        player_id: player.id,
        email:     player.email,
        password:  player.league_password || 'password',
      },
    })

    // Extract the real error message from the function response body if possible
    let errMsg = null
    if (error) {
      try {
        const body = await error.context?.json()
        errMsg = body?.error || error.message
      } catch {
        errMsg = error.message
      }
    }
    if (data?.error) errMsg = data.error

    if (errMsg) {
      showToast('Error: ' + errMsg, 'error')
    } else {
      showToast(`✅ Account created for ${player.name}! They can now sign in.`)
      loadAll()
    }
  }

  function startEditPlayer(player) {
    setPlayerForm({ name: player.name || '', email: player.email || '', handicap: player.handicap != null ? String(player.handicap) : '', in_skins: player.in_skins || false, handicap_locked: player.handicap_locked || false, league_password: player.league_password || 'password' })
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

    let error, data

    if (editingTeam) {
      // Figure out which players changed so we can update team_id on players
      const oldP1 = editingTeam.player1_id
      const oldP2 = editingTeam.player2_id
      const newP1 = payload.player1_id
      const newP2 = payload.player2_id

      ;({ error } = await supabase.from('teams').update(payload).eq('id', editingTeam.id))
      if (!error) {
        // Unassign removed players
        const removed = [oldP1, oldP2].filter(id => id && id !== newP1 && id !== newP2)
        if (removed.length) await supabase.from('players').update({ team_id: null }).in('id', removed)
        // Assign new players
        const added = [newP1, newP2].filter(Boolean)
        if (added.length) await supabase.from('players').update({ team_id: editingTeam.id }).in('id', added)
      }
    } else {
      ;({ error, data } = await supabase.from('teams').insert(payload).select().single())
      if (!error && data) {
        const toAssign = [payload.player1_id, payload.player2_id].filter(Boolean)
        if (toAssign.length) await supabase.from('players').update({ team_id: data.id }).in('id', toAssign)
      }
    }

    setSaving(false)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(editingTeam ? 'Team updated!' : 'Team created!')
    setShowTeamForm(false); setEditingTeam(null); setTeamForm(EMPTY_TEAM_FORM)
    loadAll()
  }

  async function handleDeleteTeam(team) {
    const p1 = players.find(p => p.id === team.player1_id)
    const p2 = players.find(p => p.id === team.player2_id)
    const names = [p1?.name, p2?.name].filter(Boolean).join(' & ')
    if (!window.confirm(`Delete Team ${teamNumber(team)} "${team.name}"${names ? ` (${names})` : ''}? Players will become unassigned.`)) return
    const ids = [team.player1_id, team.player2_id].filter(Boolean)
    if (ids.length) await supabase.from('players').update({ team_id: null }).in('id', ids)
    await supabase.from('teams').delete().eq('id', team.id)
    showToast('Team deleted.')
    loadAll()
  }

  function startEditTeam(team) {
    setTeamForm({ name: team.name || '', player1_id: team.player1_id || '', player2_id: team.player2_id || '' })
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

  // Players available for team assignment (unassigned, or already on this team)
  function availablePlayers(slot) {
    const currentTeamId = editingTeam?.id
    const otherSlot = slot === 'p1' ? teamForm.player2_id : teamForm.player1_id
    return players.filter(p =>
      (!p.team_id || p.team_id === currentTeamId) && p.id !== otherSlot
    )
  }

  const filtered = players.filter(p =>
    p.name?.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase())
  )

  const unassigned = players.filter(p => !p.team_id)

  if (loading) return <div style={styles.loading}>Loading…</div>

  // ── Admin player profile view ────────────────────────────────────────────
  if (viewingProfileId) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <PlayerProfile
          session={null}
          playerId={viewingProfileId}
          onBack={() => setViewingProfileId(null)}
        />
      </div>
    )
  }

  // ── Import sub-view ──────────────────────────────────────────────────────
  if (activeView === 'import') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={styles.subNav}>
          <button
            style={{ ...styles.subNavBtn, ...(activeView === 'players' ? styles.subNavActive : {}) }}
            onClick={() => setActiveView('players')}
          >
            👥 Players &amp; Teams
          </button>
          <button
            style={{ ...styles.subNavBtn, ...(activeView === 'import' ? styles.subNavActive : {}) }}
            onClick={() => setActiveView('import')}
          >
            📥 Import from CSV
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <AdminImport />
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Sub-nav toggle */}
      <div style={styles.subNav}>
        <button
          style={{ ...styles.subNavBtn, ...(activeView === 'players' ? styles.subNavActive : {}) }}
          onClick={() => setActiveView('players')}
        >
          👥 Players &amp; Teams
        </button>
        <button
          style={{ ...styles.subNavBtn, ...(activeView === 'import' ? styles.subNavActive : {}) }}
          onClick={() => setActiveView('import')}
        >
          📥 Import from CSV
        </button>
      </div>
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* ── PLAYERS SECTION ── */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>👤 Players</h2>
        <button style={styles.addBtn} onClick={() => { setShowPlayerForm(true); setEditingPlayer(null); setPlayerForm(EMPTY_PLAYER_FORM); setShowTeamForm(false) }}>
          + Add Player
        </button>
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
              <label style={styles.label}>Login Password</label>
              <input
                type="text"
                style={styles.input}
                value={playerForm.league_password}
                onChange={e => setPlayerForm(f => ({ ...f, league_password: e.target.value }))}
                placeholder="password"
                autoComplete="off"
              />
              <span style={styles.hint}>Default is "password" — player can change this after logging in.</span>
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Handicap</label>
              <input type="number" step="0.1" min="-10" max="54" style={styles.input} value={playerForm.handicap} onChange={e => setPlayerForm(f => ({ ...f, handicap: e.target.value }))} placeholder="e.g. 12.4" />
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
                <span style={{ fontSize: '18px' }}>{playerForm.handicap_locked ? '🔒' : '🔓'}</span>
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
                <span style={{ fontSize: '18px' }}>🎯</span>
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
              <button type="submit" style={styles.saveBtn} disabled={saving}>{saving ? 'Saving…' : editingPlayer ? 'Update Player' : 'Add Player'}</button>
              <button type="button" style={styles.cancelBtn} onClick={() => { setShowPlayerForm(false); setEditingPlayer(null) }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <div style={styles.searchWrap}>
            <input type="search" placeholder="Search players…" style={styles.searchInput} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <span style={styles.count}>{search.trim() ? filtered.length : players.length}</span>
        </div>
        {!search.trim() ? (
          <p style={styles.empty}>Search above to find a player.</p>
        ) : filtered.length === 0 ? (
          <p style={styles.empty}>No players match "{search}".</p>
        ) : (
          filtered.map(player => {
            const team = player.team_id ? teams.find(t => t.id === player.team_id) : null
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
                        {player.handicap_locked && <span style={styles.lockBadge}>🔒</span>}
                      </span>
                    )}
                    {team
                      ? <span style={styles.teamPill}>Team {num}: {team.name}</span>
                      : <span style={styles.unpairPill}>Unassigned</span>
                    }
                    {player.in_skins
                      ? <span style={styles.skinsPill}>🎯 Skins</span>
                      : <span style={styles.noSkinsPill}>No Skins</span>
                    }
                  </div>
                  <div style={styles.playerMeta}>
                    {player.user_id
                      ? <span style={styles.loginPill}>✅ Account active</span>
                      : (
                        <button
                          style={styles.createAccountBtn}
                          onClick={() => handleCreateAccount(player)}
                        >
                          🔑 Create Account
                        </button>
                      )
                    }
                  </div>
                </div>
                <div style={styles.rowActions}>
                  <button style={styles.profileBtn} onClick={() => setViewingProfileId(player.id)}>📊</button>
                  <button style={styles.editBtn} onClick={() => startEditPlayer(player)}>Edit</button>
                  <button style={styles.deleteBtn} onClick={() => handleDeletePlayer(player)}>✕</button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── TEAMS SECTION ── */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>🤝 Teams</h2>
        <button style={styles.addBtn} onClick={() => { setShowTeamForm(true); setEditingTeam(null); setTeamForm(EMPTY_TEAM_FORM); setShowPlayerForm(false) }}>
          + Create Team
        </button>
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
              <button type="submit" style={styles.saveBtn} disabled={saving}>{saving ? 'Saving…' : editingTeam ? 'Update Team' : 'Create Team'}</button>
              <button type="button" style={styles.cancelBtn} onClick={() => { setShowTeamForm(false); setEditingTeam(null) }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={styles.card}>
        {teams.length === 0 ? (
          <p style={styles.empty}>No teams yet — click "+ Create Team" above.</p>
        ) : (
          teams.map((team, idx) => {
            const p1 = players.find(p => p.id === team.player1_id)
            const p2 = players.find(p => p.id === team.player2_id)
            const combinedHcp = (p1?.handicap != null && p2?.handicap != null)
              ? (p1.handicap + p2.handicap).toFixed(1) : null
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
                  <button style={styles.editBtn} onClick={() => startEditTeam(team)}>Edit</button>
                  <button style={styles.deleteBtn} onClick={() => handleDeleteTeam(team)}>✕</button>
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
  toast: { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' },
  sectionTitle: { fontSize: '15px', fontWeight: 700, color: 'var(--green-dark)' },
  addBtn: { padding: '9px 16px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  searchWrap: { flex: 1, marginRight: '10px' },
  searchInput: { width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--white)', boxSizing: 'border-box' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '5px' },
  row: { display: 'flex', gap: '12px' },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  hint: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  select: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  formActions: { display: 'flex', gap: '10px' },
  saveBtn: { flex: 1, padding: '12px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 },
  cancelBtn: { flex: 1, padding: '12px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: '14px' },
  infoNote: { fontSize: '12px', color: 'var(--gray-400)', fontStyle: 'italic' },
  empty: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '16px 0' },
  playerRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  playerAvatar: { width: '36px', height: '36px', background: 'var(--green)', color: 'var(--white)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: 700, flexShrink: 0 },
  playerInfo: { flex: 1, minWidth: 0 },
  playerName: { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  playerMeta: { fontSize: '12px', color: 'var(--gray-400)', display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px', alignItems: 'center' },
  teamPill: { fontSize: '11px', fontWeight: 600, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '1px 7px', borderRadius: '10px' },
  unpairPill: { fontSize: '11px', fontWeight: 600, color: '#7a5c00', background: '#fff8e1', padding: '1px 7px', borderRadius: '10px' },
  rowActions: { display: 'flex', gap: '6px', flexShrink: 0 },
  profileBtn: { fontSize: '14px', padding: '4px 7px', background: 'var(--gray-100)', borderRadius: '6px', border: '1px solid var(--gray-200)' },
  editBtn: { fontSize: '12px', color: 'var(--green)', fontWeight: 600, padding: '4px 8px', background: 'var(--green-xlight)', borderRadius: '6px' },
  deleteBtn: { fontSize: '12px', color: '#c53030', fontWeight: 700, padding: '4px 8px', background: '#fff5f5', borderRadius: '6px' },
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
  createAccountBtn: { fontSize: '11px', fontWeight: 700, color: '#fff', background: 'var(--green-dark)', padding: '3px 10px', borderRadius: '10px', cursor: 'pointer', border: 'none' },
  skinsToggleRow:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  skinsToggleLeft:  { display: 'flex', alignItems: 'center', gap: '10px' },
  skinsToggleLabel: { fontSize: '13px', fontWeight: 700, color: 'var(--black)' },
  skinsToggleSub:   { fontSize: '11px', color: 'var(--gray-400)', marginTop: '1px' },
  skinsToggleSwitch: { width: '38px', height: '20px', borderRadius: '20px', padding: '2px', flexShrink: 0, transition: 'background 0.2s', position: 'relative' },
  skinsToggleKnob:   { width: '16px', height: '16px', background: 'white', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s' },
  lockToggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  lockBadge: { fontSize: '10px', marginLeft: '4px' },
}
