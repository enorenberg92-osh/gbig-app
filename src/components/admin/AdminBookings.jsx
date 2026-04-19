import React, { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'

// ── Constants ────────────────────────────────────────────────
const ROW_HEIGHT = 60          // px per hour slot
const TIME_COL_WIDTH = 64      // px for left time labels
const BAY_MIN_WIDTH = 110      // min px per bay column
const POPUP_TIMEOUT = 10000    // 10 seconds auto-close

// ── Helpers ──────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0') }

function formatTime12(timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${pad(m)} ${ampm}`
}

function toDateStr(date) {
  return date.toISOString().slice(0, 10)
}

function getDow(date) {
  return date.getDay() // 0=Sun ... 6=Sat
}

function generateTimeSlots(openTime, closeTime) {
  const [openH] = openTime.split(':').map(Number)
  const [closeH] = closeTime.split(':').map(Number)
  const slots = []
  for (let h = openH; h < closeH; h++) {
    slots.push(`${pad(h)}:00`)
  }
  return slots
}

function timeToIndex(timeStr, openHour) {
  const [h] = timeStr.split(':').map(Number)
  return h - openHour
}

// Category colors matching our services table
const CATEGORY_COLORS = {
  single: { bg: '#FDE68A', border: '#F59E0B', text: '#92400E' },
  group:  { bg: '#BFDBFE', border: '#3B82F6', text: '#1E3A5F' },
  vip:    { bg: '#FECACA', border: '#EF4444', text: '#991B1B' },
}

// ── Main Component ───────────────────────────────────────────
export default function AdminBookings() {
  const { locationId } = useLocation()
  // Date navigation
  const [selectedDate, setSelectedDate] = useState(new Date())

  // Data
  const [bays, setBays] = useState([])
  const [services, setServices] = useState([])
  const [bayServicesMap, setBayServicesMap] = useState({})
  const [bookings, setBookings] = useState([])
  const [bayBlocks, setBayBlocks] = useState([])
  const [operatingHours, setOperatingHours] = useState(null)
  const [hourOverride, setHourOverride] = useState(null)
  const [profiles, setProfiles] = useState([])

  // UI state
  const [loading, setLoading] = useState(true)
  const [selectedBooking, setSelectedBooking] = useState(null)
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 })
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createSlot, setCreateSlot] = useState(null) // { bayId, time }
  const [showEditModal, setShowEditModal] = useState(false)
  const [editBooking, setEditBooking] = useState(null)

  // Create form state
  const [createService, setCreateService] = useState('')
  const [createUser, setCreateUser] = useState('')
  const [createUserSearch, setCreateUserSearch] = useState('')
  const [createPlayers, setCreatePlayers] = useState(1)
  const [createNotes, setCreateNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const popupTimer = useRef(null)
  const calendarRef = useRef(null)

  // ── Derived values ───────────────────────────────────────
  const dateStr = toDateStr(selectedDate)
  const dow = getDow(selectedDate)

  const effectiveHours = hourOverride
    ? (hourOverride.is_closed ? null : { open_time: hourOverride.open_time, close_time: hourOverride.close_time })
    : operatingHours

  const timeSlots = effectiveHours
    ? generateTimeSlots(effectiveHours.open_time, effectiveHours.close_time)
    : []

  const openHour = timeSlots.length > 0 ? parseInt(timeSlots[0].split(':')[0]) : 9

  // ── Data fetching ────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true)

    const [
      { data: baysData },
      { data: servicesData },
      { data: bayServicesData },
      { data: hoursData },
      { data: overrideData },
      { data: bookingsData },
      { data: blocksData },
      { data: profilesData },
    ] = await Promise.all([
      supabase.from('bays').select('*').eq('location_id', locationId).eq('is_active', true).order('display_order'),
      supabase.from('services').select('*').eq('location_id', locationId).eq('is_active', true).order('display_order'),
      supabase.from('bay_services').select('bay_id, service_id'),
      supabase.from('operating_hours').select('*').eq('location_id', locationId).eq('dow', dow).maybeSingle(),
      supabase.from('hour_overrides').select('*').eq('location_id', locationId).eq('override_date', dateStr).maybeSingle(),
      supabase.from('bookings').select('*, service:services(*), user:profiles(*)').eq('location_id', locationId).eq('booking_date', dateStr).neq('status', 'cancelled'),
      supabase.from('bay_blocks').select('*').eq('location_id', locationId).eq('is_active', true).or(`block_date.eq.${dateStr},and(is_recurring.eq.true,dow.eq.${dow})`),
      supabase.from('profiles').select('id, full_name, email, phone').order('full_name'),
    ])

    setBays(baysData || [])
    setServices(servicesData || [])
    setBookings(bookingsData || [])
    setBayBlocks(blocksData || [])
    setOperatingHours(hoursData)
    setHourOverride(overrideData)
    setProfiles(profilesData || [])

    // Build bay → services map
    const bsMap = {}
    ;(bayServicesData || []).forEach(({ bay_id, service_id }) => {
      if (!bsMap[bay_id]) bsMap[bay_id] = new Set()
      bsMap[bay_id].add(service_id)
    })
    setBayServicesMap(bsMap)

    setLoading(false)
  }, [dateStr, dow])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Popup auto-close ─────────────────────────────────────
  useEffect(() => {
    if (selectedBooking) {
      popupTimer.current = setTimeout(() => {
        setSelectedBooking(null)
      }, POPUP_TIMEOUT)
    }
    return () => {
      if (popupTimer.current) clearTimeout(popupTimer.current)
    }
  }, [selectedBooking])

  // ── Date navigation ──────────────────────────────────────
  const goToday = () => setSelectedDate(new Date())
  const goPrev = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() - 1)
    setSelectedDate(d)
  }
  const goNext = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + 1)
    setSelectedDate(d)
  }

  // ── Booking click → detail popup ─────────────────────────
  const handleBookingClick = (booking, e) => {
    e.stopPropagation()
    const rect = calendarRef.current?.getBoundingClientRect() || { left: 0, top: 0 }
    setPopupPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setSelectedBooking(booking)
    setShowCreateModal(false)
    setShowEditModal(false)
  }

  const closePopup = () => {
    setSelectedBooking(null)
    if (popupTimer.current) clearTimeout(popupTimer.current)
  }

  // ── Empty slot click → create modal ──────────────────────
  const handleEmptyClick = (bayId, time) => {
    if (selectedBooking) { closePopup(); return }
    setCreateSlot({ bayId, time })
    setCreateService('')
    setCreateUser('')
    setCreateUserSearch('')
    setCreatePlayers(1)
    setCreateNotes('')
    setShowCreateModal(true)
    setShowEditModal(false)
  }

  // ── Available services for a bay ─────────────────────────
  const getServicesForBay = (bayId) => {
    const allowed = bayServicesMap[bayId]
    if (!allowed) return []
    return services.filter(s => allowed.has(s.id))
  }

  // ── Check if a slot is blocked ───────────────────────────
  const isSlotBlocked = (bayId, timeStr) => {
    const [h] = timeStr.split(':').map(Number)
    return bayBlocks.some(block => {
      if (block.bay_id !== bayId) return false
      const [startH] = block.start_time.split(':').map(Number)
      const [endH] = block.end_time.split(':').map(Number)
      return h >= startH && h < endH
    })
  }

  // ── Check if a slot is occupied by a booking ─────────────
  const getBookingAt = (bayId, timeStr) => {
    const [h] = timeStr.split(':').map(Number)
    return bookings.find(b => {
      if (b.bay_id !== bayId) return false
      const [startH] = b.start_time.split(':').map(Number)
      const [endH] = b.end_time.split(':').map(Number)
      return h >= startH && h < endH
    })
  }

  // ── Create booking ───────────────────────────────────────
  const handleCreate = async () => {
    if (!createSlot || !createService || !createUser) return
    setSubmitting(true)

    const service = services.find(s => s.id === Number(createService))
    if (!service) { setSubmitting(false); return }

    const startH = parseInt(createSlot.time.split(':')[0])
    const endH = startH + service.duration_hours
    const endTime = `${pad(endH)}:00`

    const { error } = await supabase.from('bookings').insert({
      user_id:      createUser,
      bay_id:       createSlot.bayId,
      service_id:   service.id,
      booking_date: dateStr,
      start_time:   createSlot.time,
      end_time:     endTime,
      num_players:  createPlayers,
      notes:        createNotes || null,
      status:       'confirmed',
      location_id:  locationId,
    })

    setSubmitting(false)
    if (!error) {
      setShowCreateModal(false)
      fetchData()
    } else {
      alert('Booking failed: ' + error.message)
    }
  }

  // ── Update booking status ────────────────────────────────
  const handleStatusChange = async (booking, newStatus) => {
    const { error } = await supabase
      .from('bookings')
      .update({ status: newStatus })
      .eq('id', booking.id)

    if (!error) {
      closePopup()
      fetchData()
    } else {
      alert('Update failed: ' + error.message)
    }
  }

  // ── Filtered user search ─────────────────────────────────
  const filteredProfiles = createUserSearch.length >= 2
    ? profiles.filter(p =>
        p.full_name?.toLowerCase().includes(createUserSearch.toLowerCase()) ||
        p.email?.toLowerCase().includes(createUserSearch.toLowerCase()) ||
        p.phone?.includes(createUserSearch)
      ).slice(0, 8)
    : []

  // ── Date formatting ──────────────────────────────────────
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dateLabel = `${dayNames[selectedDate.getDay()]}, ${monthNames[selectedDate.getMonth()]} ${selectedDate.getDate()}, ${selectedDate.getFullYear()}`

  // ── Render ───────────────────────────────────────────────
  if (loading) {
    return (
      <div style={styles.loadingWrap}>
        <div style={styles.spinner} />
        <span style={styles.loadingText}>Loading calendar...</span>
      </div>
    )
  }

  if (!effectiveHours) {
    return (
      <div style={styles.closedWrap}>
        <div style={styles.closedCard}>
          <span style={{ fontSize: 32 }}>🚫</span>
          <span style={styles.closedTitle}>Facility Closed</span>
          <span style={styles.closedDate}>{dateLabel}</span>
          {hourOverride?.reason && <span style={styles.closedReason}>{hourOverride.reason}</span>}
        </div>
        {renderDateNav()}
      </div>
    )
  }

  const totalHeight = timeSlots.length * ROW_HEIGHT

  // Date nav rendered as a function so it can be reused
  function renderDateNav() {
    return (
      <div style={styles.dateNav}>
        <button style={styles.dateNavBtn} onClick={goPrev}>◀</button>
        <button style={styles.todayBtn} onClick={goToday}>Today</button>
        <span style={styles.dateLabel}>{dateLabel}</span>
        <button style={styles.dateNavBtn} onClick={goNext}>▶</button>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Date Navigation Bar */}
      {renderDateNav()}

      {/* Calendar Grid */}
      <div style={styles.calendarWrap} ref={calendarRef}>
        <div style={styles.calendarScroll}>
          {/* Grid container */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `${TIME_COL_WIDTH}px repeat(${bays.length}, minmax(${BAY_MIN_WIDTH}px, 1fr))`,
            minWidth: TIME_COL_WIDTH + (bays.length * BAY_MIN_WIDTH),
          }}>

            {/* ── Header row ─────────────────────────── */}
            <div style={styles.headerCorner}>Time</div>
            {bays.map(bay => (
              <div key={bay.id} style={styles.headerCell}>
                {bay.name}
              </div>
            ))}

            {/* ── Time slot rows ─────────────────────── */}
            {timeSlots.map((time, rowIdx) => (
              <React.Fragment key={time}>
                {/* Time label */}
                <div style={{
                  ...styles.timeCell,
                  borderBottom: rowIdx < timeSlots.length - 1 ? '1px solid var(--gray-200)' : 'none',
                }}>
                  {formatTime12(time)}
                </div>

                {/* Bay cells for this time slot */}
                {bays.map(bay => {
                  const blocked = isSlotBlocked(bay.id, time)
                  const booking = getBookingAt(bay.id, time)
                  const isBookingStart = booking && booking.start_time.slice(0, 5) === time

                  // If this slot is mid-booking (not the start), render empty
                  if (booking && !isBookingStart) {
                    return (
                      <div key={bay.id} style={{
                        ...styles.bayCell,
                        borderBottom: rowIdx < timeSlots.length - 1 ? '1px solid var(--gray-200)' : 'none',
                        background: 'transparent',
                      }} />
                    )
                  }

                  // Blocked slot
                  if (blocked) {
                    return (
                      <div key={bay.id} style={{
                        ...styles.bayCell,
                        ...styles.blockedCell,
                        borderBottom: rowIdx < timeSlots.length - 1 ? '1px solid var(--gray-200)' : 'none',
                      }}>
                        <span style={styles.blockedLabel}>Blocked</span>
                      </div>
                    )
                  }

                  // Booking start → render the booking block
                  if (isBookingStart) {
                    const cat = booking.service?.category || 'group'
                    const colors = CATEGORY_COLORS[cat] || CATEGORY_COLORS.group
                    const durationHours = booking.service?.duration_hours || 1
                    const heightPx = durationHours * ROW_HEIGHT

                    return (
                      <div key={bay.id} style={{
                        ...styles.bayCell,
                        position: 'relative',
                        borderBottom: rowIdx < timeSlots.length - 1 ? '1px solid var(--gray-200)' : 'none',
                        padding: 0,
                        overflow: 'visible',
                      }}>
                        <div
                          style={{
                            position: 'absolute',
                            top: 1,
                            left: 2,
                            right: 2,
                            height: heightPx - 3,
                            background: colors.bg,
                            border: `2px solid ${colors.border}`,
                            borderRadius: 6,
                            padding: '4px 6px',
                            cursor: 'pointer',
                            zIndex: 2,
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                          }}
                          onClick={(e) => handleBookingClick(booking, e)}
                        >
                          <span style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: colors.text,
                            lineHeight: '14px',
                          }}>
                            {formatTime12(booking.start_time)} – {formatTime12(booking.end_time)}
                          </span>
                          <span style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: colors.text,
                            lineHeight: '13px',
                            opacity: 0.85,
                          }}>
                            {booking.service?.name || 'Booking'}
                          </span>
                          {booking.user?.full_name && (
                            <span style={{
                              fontSize: 10,
                              color: colors.text,
                              lineHeight: '12px',
                              opacity: 0.7,
                              marginTop: 1,
                            }}>
                              {booking.user.full_name}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  }

                  // Empty slot → clickable to create
                  return (
                    <div
                      key={bay.id}
                      style={{
                        ...styles.bayCell,
                        cursor: 'pointer',
                        borderBottom: rowIdx < timeSlots.length - 1 ? '1px solid var(--gray-200)' : 'none',
                      }}
                      onClick={() => handleEmptyClick(bay.id, time)}
                    >
                      <span style={styles.emptyPlus}>+</span>
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* ── Booking Detail Popup (10s auto-close) ───── */}
        {selectedBooking && (
          <div style={styles.popupOverlay} onClick={closePopup}>
            <div style={styles.popup} onClick={e => e.stopPropagation()}>
              {/* Countdown bar */}
              <div style={styles.popupCountdown}>
                <div style={styles.popupCountdownBar} />
              </div>

              <div style={styles.popupHeader}>
                <span style={{
                  ...styles.popupCategory,
                  background: CATEGORY_COLORS[selectedBooking.service?.category]?.bg || '#eee',
                  color: CATEGORY_COLORS[selectedBooking.service?.category]?.text || '#333',
                  border: `1.5px solid ${CATEGORY_COLORS[selectedBooking.service?.category]?.border || '#ccc'}`,
                }}>
                  {selectedBooking.service?.category?.toUpperCase()}
                </span>
                <button style={styles.popupClose} onClick={closePopup}>✕</button>
              </div>

              <div style={styles.popupBody}>
                <div style={styles.popupServiceName}>
                  {selectedBooking.service?.name || 'Booking'}
                </div>

                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Customer</span>
                  <span style={styles.popupValue}>
                    {selectedBooking.user?.full_name || 'Unknown'}
                  </span>
                </div>
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Email</span>
                  <span style={styles.popupValue}>
                    {selectedBooking.user?.email || '—'}
                  </span>
                </div>
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Phone</span>
                  <span style={styles.popupValue}>
                    {selectedBooking.user?.phone || '—'}
                  </span>
                </div>
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Time</span>
                  <span style={styles.popupValue}>
                    {formatTime12(selectedBooking.start_time)} – {formatTime12(selectedBooking.end_time)}
                  </span>
                </div>
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Duration</span>
                  <span style={styles.popupValue}>
                    {selectedBooking.service?.duration_hours || '?'} hour{selectedBooking.service?.duration_hours > 1 ? 's' : ''}
                  </span>
                </div>
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Players</span>
                  <span style={styles.popupValue}>
                    {selectedBooking.num_players}
                  </span>
                </div>
                {selectedBooking.notes && (
                  <div style={styles.popupRow}>
                    <span style={styles.popupLabel}>Notes</span>
                    <span style={styles.popupValue}>{selectedBooking.notes}</span>
                  </div>
                )}
                <div style={styles.popupRow}>
                  <span style={styles.popupLabel}>Status</span>
                  <span style={{
                    ...styles.popupValue,
                    fontWeight: 700,
                    color: selectedBooking.status === 'confirmed' ? 'var(--green)' : 'var(--gray-600)',
                  }}>
                    {selectedBooking.status.charAt(0).toUpperCase() + selectedBooking.status.slice(1)}
                  </span>
                </div>
              </div>

              {/* Action buttons */}
              <div style={styles.popupActions}>
                {selectedBooking.status === 'confirmed' && (
                  <>
                    <button
                      style={{ ...styles.popupBtn, ...styles.popupBtnComplete }}
                      onClick={() => handleStatusChange(selectedBooking, 'completed')}
                    >
                      Complete
                    </button>
                    <button
                      style={{ ...styles.popupBtn, ...styles.popupBtnNoShow }}
                      onClick={() => handleStatusChange(selectedBooking, 'no_show')}
                    >
                      No-Show
                    </button>
                    <button
                      style={{ ...styles.popupBtn, ...styles.popupBtnCancel }}
                      onClick={() => handleStatusChange(selectedBooking, 'cancelled')}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Create Booking Modal ────────────────────── */}
      {showCreateModal && createSlot && (
        <div style={styles.modalOverlay} onClick={() => setShowCreateModal(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>New Booking</span>
              <button style={styles.modalClose} onClick={() => setShowCreateModal(false)}>✕</button>
            </div>

            <div style={styles.modalBody}>
              {/* Bay & Time (read-only) */}
              <div style={styles.fieldGroup}>
                <label style={styles.fieldLabel}>Bay</label>
                <div style={styles.fieldStatic}>
                  {bays.find(b => b.id === createSlot.bayId)?.name}
                </div>
              </div>
              <div style={styles.fieldGroup}>
                <label style={styles.fieldLabel}>Start Time</label>
                <div style={styles.fieldStatic}>
                  {formatTime12(createSlot.time)} — {dateLabel}
                </div>
              </div>

              {/* Service picker */}
              <div style={styles.fieldGroup}>
                <label style={styles.fieldLabel}>Service</label>
                <select
                  style={styles.fieldSelect}
                  value={createService}
                  onChange={e => {
                    setCreateService(e.target.value)
                    const svc = services.find(s => s.id === Number(e.target.value))
                    if (svc?.category === 'single') setCreatePlayers(1)
                  }}
                >
                  <option value="">— Select a service —</option>
                  {getServicesForBay(createSlot.bayId).map(svc => (
                    <option key={svc.id} value={svc.id}>
                      {svc.name}
                    </option>
                  ))}
                </select>
                {createService && (() => {
                  const svc = services.find(s => s.id === Number(createService))
                  if (!svc) return null
                  const cat = svc.category
                  const colors = CATEGORY_COLORS[cat] || CATEGORY_COLORS.group
                  const startH = parseInt(createSlot.time.split(':')[0])
                  const endTime = `${pad(startH + svc.duration_hours)}:00`
                  return (
                    <div style={{ ...styles.servicePreview, background: colors.bg, borderColor: colors.border }}>
                      {formatTime12(createSlot.time)} – {formatTime12(endTime)} ({svc.duration_hours}hr{svc.duration_hours > 1 ? 's' : ''})
                    </div>
                  )
                })()}
              </div>

              {/* Customer search */}
              <div style={styles.fieldGroup}>
                <label style={styles.fieldLabel}>Customer</label>
                {createUser ? (
                  <div style={styles.selectedUser}>
                    <span>{profiles.find(p => p.id === createUser)?.full_name}</span>
                    <button style={styles.clearUserBtn} onClick={() => { setCreateUser(''); setCreateUserSearch('') }}>✕</button>
                  </div>
                ) : (
                  <>
                    <input
                      style={styles.fieldInput}
                      placeholder="Search by name, email, or phone..."
                      value={createUserSearch}
                      onChange={e => setCreateUserSearch(e.target.value)}
                    />
                    {filteredProfiles.length > 0 && (
                      <div style={styles.userDropdown}>
                        {filteredProfiles.map(p => (
                          <div
                            key={p.id}
                            style={styles.userOption}
                            onClick={() => { setCreateUser(p.id); setCreateUserSearch(p.full_name) }}
                          >
                            <span style={styles.userName}>{p.full_name}</span>
                            <span style={styles.userEmail}>{p.email}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Number of players */}
              {createService && (() => {
                const svc = services.find(s => s.id === Number(createService))
                return svc && svc.max_players > 1 ? (
                  <div style={styles.fieldGroup}>
                    <label style={styles.fieldLabel}>Number of Players</label>
                    <input
                      style={styles.fieldInput}
                      type="number"
                      min={1}
                      max={svc.max_players}
                      value={createPlayers}
                      onChange={e => setCreatePlayers(Math.min(svc.max_players, Math.max(1, Number(e.target.value))))}
                    />
                    <span style={styles.fieldHint}>Max {svc.max_players} players</span>
                  </div>
                ) : null
              })()}

              {/* Notes */}
              <div style={styles.fieldGroup}>
                <label style={styles.fieldLabel}>Notes (optional)</label>
                <textarea
                  style={styles.fieldTextarea}
                  rows={2}
                  placeholder="Any notes about this booking..."
                  value={createNotes}
                  onChange={e => setCreateNotes(e.target.value)}
                />
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button
                style={styles.cancelBtn}
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                style={{
                  ...styles.confirmBtn,
                  opacity: (!createService || !createUser || submitting) ? 0.5 : 1,
                }}
                disabled={!createService || !createUser || submitting}
                onClick={handleCreate}
              >
                {submitting ? 'Booking...' : 'Confirm Booking'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--off-white)',
  },
  loadingWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 12,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid var(--gray-200)',
    borderTopColor: 'var(--green)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: {
    fontSize: 14,
    color: 'var(--gray-600)',
  },
  closedWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 24,
  },
  closedCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: 32,
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
  },
  closedTitle: { fontSize: 18, fontWeight: 700, color: 'var(--gray-800)' },
  closedDate: { fontSize: 14, color: 'var(--gray-600)' },
  closedReason: { fontSize: 13, color: 'var(--gray-400)', fontStyle: 'italic' },

  // ── Date Navigation ──
  dateNav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: '10px 16px',
    background: 'var(--white)',
    borderBottom: '1px solid var(--gray-200)',
    flexShrink: 0,
  },
  dateNavBtn: {
    width: 36,
    height: 36,
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    background: 'var(--white)',
    fontSize: 14,
    color: 'var(--gray-800)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayBtn: {
    padding: '6px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--green)',
    background: 'var(--green-xlight)',
    color: 'var(--green-dark)',
    fontSize: 13,
    fontWeight: 600,
  },
  dateLabel: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--gray-800)',
    minWidth: 200,
    textAlign: 'center',
  },

  // ── Calendar Grid ──
  calendarWrap: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  calendarScroll: {
    width: '100%',
    height: '100%',
    overflow: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  headerCorner: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 10,
    background: 'var(--green-dark)',
    color: 'var(--white)',
    fontSize: 11,
    fontWeight: 700,
    padding: '10px 6px',
    textAlign: 'center',
    borderRight: '1px solid rgba(255,255,255,0.2)',
    borderBottom: '2px solid var(--green)',
  },
  headerCell: {
    position: 'sticky',
    top: 0,
    zIndex: 5,
    background: 'var(--green-dark)',
    color: 'var(--white)',
    fontSize: 12,
    fontWeight: 700,
    padding: '10px 4px',
    textAlign: 'center',
    borderRight: '1px solid rgba(255,255,255,0.1)',
    borderBottom: '2px solid var(--green)',
    whiteSpace: 'nowrap',
  },
  timeCell: {
    position: 'sticky',
    left: 0,
    zIndex: 4,
    background: 'var(--gray-100)',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--gray-600)',
    padding: '4px 6px',
    textAlign: 'right',
    borderRight: '2px solid var(--gray-200)',
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
  },
  bayCell: {
    height: ROW_HEIGHT,
    borderRight: '1px solid var(--gray-100)',
    background: 'var(--white)',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockedCell: {
    background: 'repeating-linear-gradient(45deg, var(--gray-100), var(--gray-100) 4px, var(--gray-200) 4px, var(--gray-200) 8px)',
  },
  blockedLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--gray-400)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  emptyPlus: {
    fontSize: 16,
    color: 'var(--gray-200)',
    fontWeight: 300,
    transition: 'color 0.15s',
  },

  // ── Booking Detail Popup ──
  popupOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 50,
    background: 'rgba(0,0,0,0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  popup: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
    width: 320,
    maxWidth: '90vw',
    overflow: 'hidden',
    animation: 'fadeIn 0.15s ease',
  },
  popupCountdown: {
    height: 3,
    background: 'var(--gray-100)',
    overflow: 'hidden',
  },
  popupCountdownBar: {
    height: '100%',
    background: 'var(--green)',
    animation: 'countdown 10s linear forwards',
  },
  popupHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px 8px',
  },
  popupCategory: {
    fontSize: 10,
    fontWeight: 800,
    padding: '3px 10px',
    borderRadius: 12,
    letterSpacing: 0.8,
  },
  popupClose: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'var(--gray-100)',
    fontSize: 14,
    color: 'var(--gray-600)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  popupBody: {
    padding: '0 16px 12px',
  },
  popupServiceName: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--gray-800)',
    marginBottom: 10,
  },
  popupRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    padding: '5px 0',
    borderBottom: '1px solid var(--gray-100)',
  },
  popupLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--gray-400)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  popupValue: {
    fontSize: 13,
    color: 'var(--gray-800)',
    textAlign: 'right',
    maxWidth: '60%',
    wordBreak: 'break-word',
  },
  popupActions: {
    display: 'flex',
    gap: 6,
    padding: '8px 16px 14px',
  },
  popupBtn: {
    flex: 1,
    padding: '8px 4px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 700,
    border: 'none',
    cursor: 'pointer',
  },
  popupBtnComplete: {
    background: 'var(--green)',
    color: 'var(--white)',
  },
  popupBtnNoShow: {
    background: 'var(--gold)',
    color: 'var(--white)',
  },
  popupBtnCancel: {
    background: '#EF4444',
    color: 'var(--white)',
  },

  // ── Create Modal ──
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modal: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
    width: 400,
    maxWidth: '95vw',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px 12px',
    borderBottom: '1px solid var(--gray-200)',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--gray-800)',
  },
  modalClose: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: 'var(--gray-100)',
    fontSize: 16,
    color: 'var(--gray-600)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBody: {
    padding: '16px 20px',
    overflowY: 'auto',
    flex: 1,
  },
  modalFooter: {
    display: 'flex',
    gap: 10,
    padding: '12px 20px 16px',
    borderTop: '1px solid var(--gray-200)',
  },
  fieldGroup: {
    marginBottom: 14,
  },
  fieldLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--gray-600)',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 5,
  },
  fieldStatic: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--gray-800)',
    padding: '8px 12px',
    background: 'var(--gray-100)',
    borderRadius: 'var(--radius-sm)',
  },
  fieldSelect: {
    width: '100%',
    padding: '9px 12px',
    fontSize: 14,
    border: '1.5px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--white)',
    color: 'var(--gray-800)',
  },
  fieldInput: {
    width: '100%',
    padding: '9px 12px',
    fontSize: 14,
    border: '1.5px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--white)',
    color: 'var(--gray-800)',
    outline: 'none',
  },
  fieldTextarea: {
    width: '100%',
    padding: '9px 12px',
    fontSize: 14,
    border: '1.5px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--white)',
    color: 'var(--gray-800)',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
  },
  fieldHint: {
    fontSize: 11,
    color: 'var(--gray-400)',
    marginTop: 3,
    display: 'block',
  },
  servicePreview: {
    marginTop: 6,
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    border: '1.5px solid',
  },
  selectedUser: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '9px 12px',
    background: 'var(--green-xlight)',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--green-light)',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--green-dark)',
  },
  clearUserBtn: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: 'var(--green-light)',
    color: 'var(--white)',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userDropdown: {
    marginTop: 4,
    border: '1.5px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--white)',
    maxHeight: 180,
    overflowY: 'auto',
    boxShadow: 'var(--shadow)',
  },
  userOption: {
    padding: '8px 12px',
    cursor: 'pointer',
    borderBottom: '1px solid var(--gray-100)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  userName: { fontSize: 13, fontWeight: 600, color: 'var(--gray-800)' },
  userEmail: { fontSize: 11, color: 'var(--gray-400)' },
  cancelBtn: {
    flex: 1,
    padding: '10px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    background: 'var(--white)',
    color: 'var(--gray-600)',
    fontSize: 14,
    fontWeight: 600,
  },
  confirmBtn: {
    flex: 2,
    padding: '10px',
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    background: 'var(--green)',
    color: 'var(--white)',
    fontSize: 14,
    fontWeight: 700,
  },
}
