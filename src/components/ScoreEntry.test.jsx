import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ slots: [], cursor: 0, effects: [], rows: [], draft: {}, user: 'ua', rpc: vi.fn(), save: vi.fn(), clear: vi.fn(), readError: false }))
vi.mock('react', async original => ({
  ...await original(),
  useState(initial) {
    const index = h.cursor++
    if (!(index in h.slots)) h.slots[index] = initial
    return [h.slots[index], value => { h.slots[index] = typeof value === 'function' ? value(h.slots[index]) : value }]
  },
  useRef(initial) {
    const index = h.cursor++
    if (!(index in h.slots)) h.slots[index] = { current: initial }
    return h.slots[index]
  },
  useEffect: effect,
  useLayoutEffect: effect,
}))
function effect(callback, deps) {
  const index = h.cursor++
  if (!h.slots[index] || deps.some((value, i) => value !== h.slots[index][i])) {
    h.slots[index] = deps
    h.effects.push(callback)
  }
}
vi.mock('../context/LocationContext', () => ({ useLocation: () => ({ locationId: 'venue' }) }))
vi.mock('../lib/leagueUtils', () => ({ loadWorkingLeague: async () => ({ id: 'league' }) }))
vi.mock('../lib/scoreDraft', () => ({ readScoreDraft: () => h.draft, saveScoreDraft: (...args) => { h.save(...args); return 'saved' }, clearScoreDraft: (...args) => h.clear(...args) }))
vi.mock('./HoleEventAnimation', () => ({ default: () => null }))
vi.mock('./ui', () => ({ Button: function Button() {}, Toast: function Toast() {} }))
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc: (...args) => h.rpc(...args),
  from(table) {
    const filters = {}
    const query = {
      select: () => query, order: () => query, limit: () => query, neq: () => query,
      eq: (key, value) => { filters[key] = value; return query },
      in: () => query, single: () => query, maybeSingle: () => query,
      then(resolve) {
        const players = [{ id: 'a', name: 'Alex Player', handicap: 2 }, { id: 'b', name: 'Blair Partner', handicap: 4 }]
        const data = table === 'players' ? filters.user_id ? players[filters.user_id === 'ua' ? 0 : 1] : players
          : table === 'events' ? { id: 'event', name: 'Week 1', course_id: 'course' }
          : table === 'roster_at' ? filters.player_id ? { team_id: 'team' } : [{ player_id: 'b' }, { player_id: 'a' }]
          : table === 'teams' ? { id: 'team', name: 'Partners' }
          : table === 'courses' ? { id: 'course', name: 'Course', num_holes: 2, hole_pars: [4, 3], total_par: 7 }
          : h.rows
        return Promise.resolve(resolve({ data, error: table === 'scores' && h.readError ? new Error('Offline') : null }))
      },
    }
    return query
  },
} }))
import ScoreEntry from './ScoreEntry'
let tree
const render = () => { h.cursor = 0; tree = ScoreEntry({ session: { user: { id: h.user } }, onBack: vi.fn() }); h.effects.splice(0).forEach(callback => callback()); return tree }
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...[].concat(node.props?.children || []).flat(Infinity).flatMap(walk)]
const nodes = () => walk(tree)
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : [].concat(node.props?.children || []).flat(Infinity).map(text).join('')
const button = label => nodes().find(node => node.props?.onClick && text(node) === label)
const checkbox = name => nodes().find(node => node.props?.['aria-label'] === 'Include ' + name)
const settle = () => new Promise(resolve => setImmediate(resolve))
async function mount() { render(); await settle(); render() }
function lastHole() { nodes().find(node => node.props?.['aria-label'] === 'Hole 2').props.onClick(); render() }
const card = (player, status = 'pending') => ({ id: player + '-score', player_id: player, status, hole_scores: [4, 3], gross_total: 7 })
const completeDraft = () => ({ status: 'restored', scores: { p1: [4, 3], p2: [5, null] }, stats: { p1: [{}, {}], p2: [{}, {}] }, currentHole: 0, showStats: false, selectedPlayerIds: ['a'] })
beforeEach(() => {
  Object.assign(h, { slots: [], cursor: 0, effects: [], rows: [], draft: { status: 'empty' }, user: 'ua', readError: false })
  h.rpc.mockReset(); h.save.mockReset(); h.clear.mockReset()
  h.rpc.mockImplementation(async (_, { p_entries }) => { h.rows = [...h.rows, ...p_entries.map(entry => card(entry.player_id))]; return { data: { inserted: p_entries.length }, error: null } })
})

it('defaults to the signed-in golfer, even if the dated roster order is reversed', async () => {
  await mount()
  expect(checkbox('Alex Player').props.checked).toBe(true)
  expect(checkbox('Blair Partner').props.checked).toBe(false)
  expect(nodes().filter(node => node.props?.['aria-label']?.startsWith('Increase score')).map(node => node.props['aria-label'])).toEqual(['Increase score for Alex Player'])
  expect(button('Hole 2').props.disabled).toBe(true)
})
it('submits only a complete selected card and preserves the unfinished partner draft', async () => {
  h.draft = completeDraft()
  await mount(); lastHole()
  expect(button('Submit Scorecard').props.disabled).toBe(false)
  const submit = button('Submit Scorecard').props.onClick
  await Promise.all([submit(), submit()]); render()
  expect(h.rpc).toHaveBeenCalledTimes(1)
  expect(h.rpc.mock.calls[0][1].p_entries).toEqual([{ player_id: 'a', hole_scores: [4, 3], hole_stats: null }])
  expect(checkbox('Alex Player').props.disabled).toBe(true)
  expect(checkbox('Blair Partner').props.disabled).toBe(false)
  expect(text(tree)).toContain('Your partner can submit separately')
  expect(h.clear).not.toHaveBeenCalled()
  expect(h.save.mock.calls.at(-1)[1].scores).toEqual({ p1: [null, null], p2: [5, null] })
})
it('lets the second partner enter their own card later when the first is already submitted', async () => {
  h.user = 'ub'; h.rows = [card('a', 'verified')]
  await mount()
  expect(checkbox('Blair Partner').props.checked).toBe(true)
  expect(checkbox('Blair Partner').props.disabled).toBe(false)
  expect(checkbox('Alex Player').props.disabled).toBe(true)
  expect(text(tree)).toContain('Submitted · Approved')
  expect(text(tree)).not.toContain('Both scorecards submitted')
})
it('keeps both-player entry available and requires every selected card to be complete', async () => {
  h.draft = completeDraft()
  await mount(); lastHole()
  checkbox('Blair Partner').props.onChange({ target: { checked: true } }); render()
  expect(button('Submit Both Scorecards').props.disabled).toBe(true)
  nodes().find(node => node.props?.['aria-label'] === 'Increase score for Blair Partner').props.onClick(); render()
  expect(button('Submit Both Scorecards').props.disabled).toBe(false)
  await button('Submit Both Scorecards').props.onClick(); render()
  expect(h.rpc.mock.calls[0][1].p_entries.map(entry => entry.player_id)).toEqual(['a', 'b'])
  expect(text(tree)).toContain('Both scorecards submitted')
  expect(h.clear).toHaveBeenCalled()
})
it('refreshes a card submitted from another device and never restores its stale draft', async () => {
  h.draft = completeDraft()
  await mount()
  h.rows = [card('a')]
  await button('Refresh submitted cards').props.onClick(); render()
  expect(checkbox('Alex Player').props.disabled).toBe(true)
  expect(h.save.mock.calls.at(-1)[1].scores.p1).toEqual([null, null])
  expect(h.save.mock.calls.at(-1)[1].scores.p2).toEqual([5, null])
})
it('keeps drafts if the RPC succeeds but confirmation cannot be read', async () => {
  h.draft = completeDraft()
  await mount(); lastHole(); h.readError = true
  await button('Submit Scorecard').props.onClick(); render()
  expect(h.clear).not.toHaveBeenCalled()
  expect(checkbox('Alex Player').props.disabled).toBe(false)
  expect(nodes().find(node => node.props?.toast)?.props.toast.msg).toContain('draft is kept')
})
