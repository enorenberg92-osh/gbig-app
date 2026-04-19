import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import PlayerProfile from './PlayerProfile'
import { useLocation } from '../context/LocationContext'

// ── Social push helper ────────────────────────────────────────────────────────
// Fire-and-forget: sends a targeted push notification to one player's devices.
// Never throws — social pings are best-effort and should never break UI flows.
const SOCIAL_PUSH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-social-push`

async function sendSocialPush(targetPlayerId, title, body) {
  try {
    // Forward the caller's access token so the Edge Function can verify
    // both caller and target belong to the same location.
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token
    if (!accessToken) return // best-effort; silently skip for signed-out flows

    await fetch(SOCIAL_PUSH_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ target_player_id: targetPlayerId, title, body }),
    })
  } catch (e) {
    console.warn('sendSocialPush failed (non-fatal):', e)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function playerName(p) {
  if (!p) return 'Unknown'
  return p.first_name ? `${p.first_name} ${p.last_name || ''}`.trim() : p.name || 'Unknown'
}

function PlayerAvatar({ player, size = 38 }) {
  const name    = playerName(player)
  const initial = name[0]?.toUpperCase() || '?'
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--green)', color: '#fff', fontSize: size * 0.4, fontWeight: 700,
      border: '2px solid var(--green-xlight)',
    }}>
      {player?.avatar_url
        ? <img src={player.avatar_url} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial
      }
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FriendsTab({ session }) {
  const { locationId } = useLocation()
  const [myPlayer, setMyPlayer]           = useState(null)
  const [following, setFollowing]         = useState([])   // players I follow
  const [followers, setFollowers]         = useState([])   // players who follow me
  const [searchQuery, setSearchQuery]     = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching]         = useState(false)
  const [activeTab, setActiveTab]         = useState('following')
  const [view, setView]                   = useState('list') // 'list' | 'profile' | 'conversation'
  const [viewingPlayer, setViewingPlayer] = useState(null)
  const [loading, setLoading]             = useState(true)
  const [toast, setToast]                 = useState(null)

  useEffect(() => { if (locationId) loadMyPlayer() }, [session, locationId])

  async function loadMyPlayer() {
    if (!session?.user?.id) { setLoading(false); return }
    const { data } = await supabase
      .from('players')
      .select('id, name, first_name, last_name')
      .eq('user_id', session.user.id)
      .eq('location_id', locationId)
      .maybeSingle()
    setMyPlayer(data || null)
    if (data) await loadFollows(data.id)
    setLoading(false)
  }

  async function loadFollows(playerId) {
    const [{ data: fwingRows }, { data: fwerRows }] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', playerId),
      supabase.from('follows').select('follower_id').eq('following_id', playerId),
    ])

    const followingIds = (fwingRows || []).map(r => r.following_id)
    const followerIds  = (fwerRows  || []).map(r => r.follower_id)

    const [fwingRes, fwerRes] = await Promise.all([
      followingIds.length
        ? supabase.from('players').select('id, name, first_name, last_name, handicap, avatar_url').eq('location_id', locationId).in('id', followingIds)
        : { data: [] },
      followerIds.length
        ? supabase.from('players').select('id, name, first_name, last_name, handicap, avatar_url').eq('location_id', locationId).in('id', followerIds)
        : { data: [] },
    ])

    setFollowing(fwingRes.data || [])
    setFollowers(fwerRes.data  || [])
  }

  function isMutual(player) {
    return following.some(f => f.id === player.id) && followers.some(f => f.id === player.id)
  }
  function isFollowing(player) {
    return following.some(f => f.id === player.id)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleFollow(player) {
    if (!myPlayer) return

    // Check BEFORE inserting whether this follow creates a mutual (friendship)
    const willBeMutual = followers.some(f => f.id === player.id)

    const { error } = await supabase.from('follows').insert({
      follower_id: myPlayer.id,
      following_id: player.id,
    })
    if (error) { showToast('Could not follow — try again.', 'error'); return }

    showToast(`Following ${playerName(player)}!`)
    setSearchQuery('')
    setSearchResults([])
    await loadFollows(myPlayer.id)

    // Send push notification to the followed player (best-effort, never blocks UI)
    const myName = playerName(myPlayer)
    if (willBeMutual) {
      // Both now follow each other — notify them that a friendship formed
      sendSocialPush(player.id, '🤝 New Friend!', `You and ${myName} are now mutual followers!`)
    } else {
      // Simple follow
      sendSocialPush(player.id, '👥 New Follower', `${myName} started following you.`)
    }
  }

  async function handleUnfollow(player) {
    if (!myPlayer) return
    await supabase.from('follows')
      .delete()
      .eq('follower_id', myPlayer.id)
      .eq('following_id', player.id)
    showToast(`Unfollowed ${playerName(player)}`)
    await loadFollows(myPlayer.id)
  }

  async function handleRemoveFollower(player) {
    if (!myPlayer) return
    await supabase.from('follows')
      .delete()
      .eq('follower_id', player.id)
      .eq('following_id', myPlayer.id)
    showToast(`Removed ${playerName(player)} from your followers`)
    await loadFollows(myPlayer.id)
  }

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      const { data } = await supabase
        .from('players')
        .select('id, name, first_name, last_name, handicap, avatar_url')
        .eq('location_id', locationId)
        .or(`name.ilike.%${searchQuery}%,first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%`)
        .neq('id', myPlayer?.id || '00000000-0000-0000-0000-000000000000')
        .limit(8)
      setSearchResults(data || [])
      setSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, myPlayer, locationId])

  // ── Full-screen views ──────────────────────────────────────────────────────
  if (loading) return <div style={st.loading}>Loading…</div>

  if (!myPlayer) return (
    <div style={st.emptyState}>
      <div style={st.emptyIcon}>👥</div>
      <div style={st.emptyTitle}>Player record not linked</div>
      <div style={st.emptySub}>Contact your league admin to link your account to your player record.</div>
    </div>
  )

  if (view === 'profile' && viewingPlayer) return (
    <PlayerProfile
      session={null}
      playerId={viewingPlayer.id}
      onBack={() => { setView('list'); setViewingPlayer(null) }}
    />
  )

  if (view === 'conversation' && viewingPlayer) return (
    <ConversationView
      myPlayer={myPlayer}
      otherPlayer={viewingPlayer}
      onBack={() => { setView('list'); setViewingPlayer(null) }}
    />
  )

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <div style={st.page}>
      {toast && (
        <div style={{ ...st.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* Search */}
      <div style={st.card}>
        <label style={st.label}>🔍 Find a player to follow</label>
        <input
          style={st.searchInput}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by name…"
        />
        {searchQuery.length > 0 && (
          <div style={st.searchResults}>
            {searching && <div style={st.hint}>Searching…</div>}
            {!searching && searchResults.length === 0 && searchQuery.length >= 2 && (
              <div style={st.hint}>No players found for "{searchQuery}"</div>
            )}
            {searchResults.map(p => (
              <div key={p.id} style={st.searchRow}>
                <PlayerAvatar player={p} />
                <div style={st.searchInfo}>
                  <div style={st.playerName}>{playerName(p)}</div>
                  {p.handicap != null && <div style={st.meta}>HCP {p.handicap}</div>}
                </div>
                {isFollowing(p)
                  ? <span style={st.followingPill}>Following ✓</span>
                  : <button style={st.followBtn} onClick={() => handleFollow(p)}>+ Follow</button>
                }
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Following / Followers tabs */}
      <div style={st.tabRow}>
        {[
          { id: 'following', label: 'Following', count: following.length },
          { id: 'followers', label: 'Followers', count: followers.length },
        ].map(({ id, label, count }) => (
          <button
            key={id}
            style={{ ...st.tabBtn, ...(activeTab === id ? st.tabBtnActive : {}) }}
            onClick={() => setActiveTab(id)}
          >
            {label}
            {count > 0 && (
              <span style={{ ...st.tabCount, background: activeTab === id ? 'rgba(255,255,255,0.25)' : 'var(--green-xlight)', color: activeTab === id ? '#fff' : 'var(--green-dark)' }}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={st.card}>
        {activeTab === 'following' && (
          following.length === 0
            ? <div style={st.emptyList}>You're not following anyone yet — search above!</div>
            : following.map(p => {
                const mutual = isMutual(p)
                return (
                  <div key={p.id} style={st.playerRow}>
                    <PlayerAvatar player={p} />
                    <div style={{ ...st.playerInfo, cursor: 'pointer' }} onClick={() => { setViewingPlayer(p); setView('profile') }}>
                      <div style={st.playerName}>{playerName(p)}</div>
                      <div style={st.metaRow}>
                        {p.handicap != null && <span style={st.meta}>HCP {p.handicap}</span>}
                        {mutual && <span style={st.mutualPill}>🤝 Mutual</span>}
                        <span style={st.tapHint}>Tap to view profile →</span>
                      </div>
                    </div>
                    <div style={st.actions}>
                      {mutual && (
                        <button style={st.msgBtn} title="Send message" onClick={() => { setViewingPlayer(p); setView('conversation') }}>
                          💬
                        </button>
                      )}
                      <button style={st.unfollowBtn} onClick={() => handleUnfollow(p)}>Unfollow</button>
                    </div>
                  </div>
                )
              })
        )}

        {activeTab === 'followers' && (
          followers.length === 0
            ? <div style={st.emptyList}>Nobody is following you yet.</div>
            : followers.map(p => {
                const mutual = isMutual(p)
                return (
                  <div key={p.id} style={st.playerRow}>
                    <PlayerAvatar player={p} />
                    <div style={st.playerInfo}>
                      <div style={st.playerName}>{playerName(p)}</div>
                      <div style={st.metaRow}>
                        {p.handicap != null && <span style={st.meta}>HCP {p.handicap}</span>}
                        {mutual && <span style={st.mutualPill}>🤝 Mutual</span>}
                      </div>
                    </div>
                    <div style={st.actions}>
                      {mutual && (
                        <button style={st.msgBtn} title="Send message" onClick={() => { setViewingPlayer(p); setView('conversation') }}>
                          💬
                        </button>
                      )}
                      {!isFollowing(p) && (
                        <button style={st.followBtn} onClick={() => handleFollow(p)}>Follow Back</button>
                      )}
                      <button style={st.removeBtn} onClick={() => handleRemoveFollower(p)}>Remove</button>
                    </div>
                  </div>
                )
              })
        )}
      </div>
    </div>
  )
}

// ── Conversation view ─────────────────────────────────────────────────────────
function ConversationView({ myPlayer, otherPlayer, onBack }) {
  const [messages, setMessages] = useState([])
  const [newMsg, setNewMsg]     = useState('')
  const [sending, setSending]   = useState(false)
  const [loading, setLoading]   = useState(true)
  const bottomRef               = useRef(null)

  useEffect(() => {
    loadMessages()

    // Real-time: listen for new messages in this conversation
    const channel = supabase
      .channel(`conv_${[myPlayer.id, otherPlayer.id].sort().join('_')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
        const msg = payload.new
        const isOurs =
          (msg.sender_id === myPlayer.id    && msg.recipient_id === otherPlayer.id) ||
          (msg.sender_id === otherPlayer.id && msg.recipient_id === myPlayer.id)
        if (isOurs) setMessages(prev => [...prev, msg])
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [myPlayer.id, otherPlayer.id])

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadMessages() {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${myPlayer.id},recipient_id.eq.${otherPlayer.id}),` +
        `and(sender_id.eq.${otherPlayer.id},recipient_id.eq.${myPlayer.id})`
      )
      .order('created_at', { ascending: true })
    setMessages(data || [])
    setLoading(false)
  }

  async function handleSend(e) {
    e.preventDefault()
    if (!newMsg.trim() || sending) return
    setSending(true)
    const text = newMsg.trim()
    const { error } = await supabase.from('messages').insert({
      sender_id: myPlayer.id,
      recipient_id: otherPlayer.id,
      content: text,
    })
    if (!error) {
      setNewMsg('')
      // Notify the recipient (best-effort)
      const preview = text.length > 80 ? text.slice(0, 80) + '…' : text
      sendSocialPush(otherPlayer.id, `💬 ${playerName(myPlayer)}`, preview)
    }
    setSending(false)
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  function fmtDate(ts) {
    const d = new Date(ts)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return 'Today'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const otherName = playerName(otherPlayer)

  return (
    <div style={cv.shell}>
      {/* Header */}
      <div style={cv.header}>
        <button style={cv.back} onClick={onBack}>← Back</button>
        <div style={cv.headerCenter}>
          <div style={cv.headerAvatar}>{otherName[0]}</div>
          <div style={cv.headerName}>{otherName}</div>
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Messages */}
      <div style={cv.messageList}>
        {loading && <div style={cv.loadingMsg}>Loading messages…</div>}

        {!loading && messages.length === 0 && (
          <div style={cv.emptyConvo}>
            <div style={{ fontSize: '36px', marginBottom: '8px' }}>💬</div>
            <div style={{ fontWeight: 700, color: 'var(--green-dark)', marginBottom: '4px' }}>Start the trash talk</div>
            <div style={{ fontSize: '13px', color: 'var(--gray-400)' }}>Send the first message — you follow each other, now make it count! 🏌️</div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isMe    = msg.sender_id === myPlayer.id
          const prevMsg = messages[i - 1]
          const showDate = !prevMsg || fmtDate(msg.created_at) !== fmtDate(prevMsg.created_at)
          return (
            <React.Fragment key={msg.id}>
              {showDate && (
                <div style={cv.dateDivider}>{fmtDate(msg.created_at)}</div>
              )}
              <div style={{ ...cv.row, justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                {!isMe && <div style={cv.msgAvatar}>{otherName[0]}</div>}
                <div style={{
                  ...cv.bubble,
                  background: isMe ? 'var(--green-dark)' : '#fff',
                  color:      isMe ? '#fff'              : 'var(--black)',
                  borderBottomRightRadius: isMe ? 4 : 18,
                  borderBottomLeftRadius:  isMe ? 18 : 4,
                }}>
                  <div style={cv.bubbleText}>{msg.content}</div>
                  <div style={{ ...cv.bubbleTime, color: isMe ? 'rgba(255,255,255,0.55)' : 'var(--gray-400)' }}>
                    {fmtTime(msg.created_at)}
                  </div>
                </div>
              </div>
            </React.Fragment>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form style={cv.inputRow} onSubmit={handleSend}>
        <input
          style={cv.input}
          value={newMsg}
          onChange={e => setNewMsg(e.target.value)}
          placeholder="Talk some smack… 🏌️"
          autoComplete="off"
          maxLength={500}
        />
        <button
          type="submit"
          style={{ ...cv.sendBtn, opacity: sending || !newMsg.trim() ? 0.5 : 1 }}
          disabled={sending || !newMsg.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const st = {
  page:    { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '32px' },
  loading: { padding: '60px', textAlign: 'center', color: 'var(--gray-400)' },
  toast:   { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: '#fff', padding: '10px 22px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },

  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 32px', textAlign: 'center', gap: '14px' },
  emptyIcon:  { fontSize: '52px' },
  emptyTitle: { fontSize: '20px', fontWeight: 800, color: 'var(--green-dark)' },
  emptySub:   { fontSize: '14px', color: 'var(--gray-500)', lineHeight: 1.6, maxWidth: '280px' },

  card:        { background: '#fff', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  label:       { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' },
  searchInput: { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)', boxSizing: 'border-box' },
  searchResults: { marginTop: '10px', display: 'flex', flexDirection: 'column' },
  hint:        { fontSize: '13px', color: 'var(--gray-400)', padding: '10px 0', textAlign: 'center' },
  searchRow:   { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--gray-100)' },
  searchInfo:  { flex: 1, minWidth: 0 },
  meta:        { fontSize: '11px', color: 'var(--gray-400)' },

  tabRow:       { display: 'flex', gap: '8px' },
  tabBtn:       { flex: 1, padding: '10px', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 600, color: 'var(--gray-500)', background: '#fff', border: '1.5px solid var(--gray-200)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' },
  tabBtnActive: { background: 'var(--green-dark)', color: '#fff', border: '1.5px solid var(--green-dark)' },
  tabCount:     { fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '10px' },

  playerRow:    { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 0', borderBottom: '1px solid var(--gray-100)' },
  avatar:       { width: '38px', height: '38px', background: 'var(--green)', color: '#fff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: 700, flexShrink: 0 },
  playerInfo:   { flex: 1, minWidth: 0 },
  playerName:   { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  metaRow:      { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' },
  tapHint:      { fontSize: '10px', color: 'var(--gray-400)', fontStyle: 'italic' },
  mutualPill:   { fontSize: '11px', fontWeight: 600, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '1px 7px', borderRadius: '10px' },
  followingPill:{ fontSize: '11px', fontWeight: 600, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '3px 9px', borderRadius: '20px', flexShrink: 0 },
  emptyList:    { padding: '24px 0', textAlign: 'center', color: 'var(--gray-400)', fontSize: '13px', lineHeight: 1.5 },

  actions:      { display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' },
  msgBtn:       { fontSize: '16px', padding: '5px 8px', background: 'var(--green-xlight)', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--green)', lineHeight: 1 },
  followBtn:    { fontSize: '12px', fontWeight: 700, color: '#fff', background: 'var(--green)', padding: '5px 12px', borderRadius: '20px', flexShrink: 0, cursor: 'pointer', border: 'none' },
  unfollowBtn:  { fontSize: '11px', fontWeight: 600, color: '#c53030', background: '#fff5f5', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', border: '1px solid #fecaca' },
  removeBtn:    { fontSize: '11px', fontWeight: 600, color: '#c53030', background: '#fff5f5', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', border: '1px solid #fecaca' },
}

const cv = {
  shell:       { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)' },
  header:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: '#fff', flexShrink: 0 },
  back:        { color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500, cursor: 'pointer' },
  headerCenter:{ display: 'flex', alignItems: 'center', gap: '8px' },
  headerAvatar:{ width: '32px', height: '32px', background: 'rgba(255,255,255,0.2)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, border: '1.5px solid rgba(255,255,255,0.3)' },
  headerName:  { fontSize: '16px', fontWeight: 700, color: '#fff' },

  messageList: { flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px', WebkitOverflowScrolling: 'touch' },
  loadingMsg:  { textAlign: 'center', color: 'var(--gray-400)', fontSize: '13px', padding: '32px 0' },
  emptyConvo:  { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', textAlign: 'center' },
  dateDivider: { textAlign: 'center', fontSize: '11px', color: 'var(--gray-400)', fontWeight: 600, padding: '8px 0', textTransform: 'uppercase', letterSpacing: '0.5px', userSelect: 'none' },

  row:         { display: 'flex', alignItems: 'flex-end', gap: '6px', marginBottom: '2px' },
  msgAvatar:   { width: '28px', height: '28px', background: 'var(--green)', color: '#fff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, flexShrink: 0, marginBottom: '2px' },
  bubble:      { maxWidth: '72%', padding: '10px 14px', borderRadius: '18px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
  bubbleText:  { fontSize: '14px', lineHeight: 1.45, wordBreak: 'break-word' },
  bubbleTime:  { fontSize: '10px', marginTop: '4px', textAlign: 'right' },

  inputRow:    { display: 'flex', gap: '8px', padding: '10px 12px', background: '#fff', borderTop: '1px solid var(--gray-200)', flexShrink: 0 },
  input:       { flex: 1, padding: '10px 14px', borderRadius: '20px', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', outline: 'none' },
  sendBtn:     { padding: '10px 18px', background: 'var(--green-dark)', color: '#fff', borderRadius: '20px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flexShrink: 0, border: 'none', transition: 'opacity 0.15s' },
}
