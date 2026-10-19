import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ slots: [], cursor: 0, effects: [], invoke: vi.fn() }))
vi.mock('react', async original => {
  const actual = await original()
  return {
    ...actual,
    useId: () => 'login-input',
    useState(initial) {
      const index = harness.cursor++
      if (!(index in harness.slots)) harness.slots[index] = initial
      return [harness.slots[index], value => { harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value }]
    },
    useRef(initial) {
      const index = harness.cursor++
      if (!(index in harness.slots)) harness.slots[index] = { current: initial }
      return harness.slots[index]
    },
    useEffect(effect) {
      const index = harness.cursor++
      if (!harness.slots[index]) { harness.slots[index] = true; harness.effects.push(effect) }
    },
  }
})
vi.mock('../../lib/supabase', () => ({ supabase: { functions: { invoke: harness.invoke } } }))
vi.mock('../ui', () => ({ Button: function Button() {} }))
import PlayerLoginEditor from './PlayerLoginEditor'

const details = overrides => ({
  player: { id: 'player', name: 'Test Golfer', email: 'roster@example.invalid' },
  venue: 'Appleton Indoor Golf', auth_email: 'typo@example.invalid', email_confirmed: true,
  last_sign_in_at: null, notice: 'Updates the existing login immediately.', blocked: null, ...overrides,
})
let tree, props
const render = () => { harness.cursor = 0; tree = PlayerLoginEditor(props); harness.effects.splice(0).forEach(effect => effect()); return tree }
const nodes = (node = tree) => !node || typeof node !== 'object' ? [] : [node, ...[].concat(node.props?.children || []).flat(Infinity).flatMap(child => nodes(child))]
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : [].concat(node.props?.children || []).flat(Infinity).map(text).join('')
const button = label => nodes().find(node => node.props?.onClick && text(node) === label)
const settle = () => new Promise(resolve => setImmediate(resolve))
async function mount(value = details()) {
  harness.invoke.mockResolvedValueOnce({ data: value, error: null })
  render(); await settle(); render()
}
async function review() {
  harness.invoke.mockResolvedValueOnce({ data: details({ review: 'synthetic-review', new_email: 'correct@example.invalid' }), error: null })
  await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  render()
}
beforeEach(() => { harness.slots = []; harness.cursor = 0; harness.effects = []; harness.invoke.mockReset(); props = { playerId: 'player', onClose: vi.fn(), onSaved: vi.fn() } })
afterEach(() => vi.restoreAllMocks())

it('shows roster and actual Auth email separately, without treating linkage as a sign-in', async () => {
  await mount()
  expect(text(tree)).toContain('roster@example.invalid')
  expect(text(tree)).toContain('typo@example.invalid')
  expect(text(tree)).toContain('No sign-in recorded')
  expect(nodes().some(node => node.props?.type === 'password')).toBe(false)
  expect(harness.invoke).toHaveBeenCalledWith('update-player-login', { body: { action: 'status', player_id: 'player' } })
})
it('requires the confirmation checkbox and invalidates review when the address changes', async () => {
  await mount(); await review()
  expect(button('Update roster and login email').props.disabled).toBe(true)
  nodes().find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
  render()
  expect(button('Update roster and login email').props.disabled).toBe(false)
  nodes().find(node => node.props?.type === 'email').props.onChange({ target: { value: 'changed@example.invalid' } })
  render()
  expect(button('Update roster and login email')).toBeUndefined()
})
it('blocks a conflicting or privileged login while allowing a fresh status read', async () => {
  await mount(details({ blocked: 'Shared login; review required.' }))
  expect(text(tree)).toContain('Shared login')
  expect(nodes().some(node => node.type === 'form')).toBe(false)
  expect(button('Refresh login details')).toBeDefined()
})
it('submits the signed review once and renders verified success', async () => {
  await mount(); await review()
  nodes().find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } }); render()
  harness.invoke.mockResolvedValueOnce({ data: details({ auth_email: 'correct@example.invalid', player: { id: 'player', name: 'Test Golfer', email: 'correct@example.invalid' } }), error: null })
  const action = button('Update roster and login email').props.onClick
  await Promise.all([action(), action()]); render()
  expect(harness.invoke.mock.calls.filter(([, args]) => args.body.action === 'apply')).toHaveLength(1)
  expect(harness.invoke).toHaveBeenLastCalledWith('update-player-login', { body: { action: 'apply', player_id: 'player', review: 'synthetic-review', confirmed: true } })
  expect(text(tree)).toContain('existing password')
  expect(props.onSaved).toHaveBeenCalledTimes(1)
})
it('shows partial failure, discards the review and requires refreshed details', async () => {
  await mount(); await review()
  nodes().find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } }); render()
  harness.invoke.mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ error: 'Login changed; roster not updated. Contact the account owner.' }) } } })
  await button('Update roster and login email').props.onClick(); render()
  expect(text(tree)).toContain('roster not updated')
  expect(text(tree)).toContain('Refresh login details before')
  expect(button('Update roster and login email')).toBeUndefined()
  expect(props.onSaved).not.toHaveBeenCalled()
})
