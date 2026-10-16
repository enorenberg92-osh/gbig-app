import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A small hook harness exercises the component's event handlers without adding
// a DOM/testing-library dependency. These are component logic tests, not browser QA.
const harness = vi.hoisted(() => ({ slots: [], cursor: 0, effects: [], invoke: vi.fn() }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    useState(initial) {
      const index = harness.cursor++
      if (!(index in harness.slots)) harness.slots[index] = typeof initial === 'function' ? initial() : initial
      return [harness.slots[index], value => { harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value }]
    },
    useRef(initial) {
      const index = harness.cursor++
      if (!(index in harness.slots)) harness.slots[index] = { current: initial }
      return harness.slots[index]
    },
    useEffect(callback, dependencies) {
      const index = harness.cursor++
      const previous = harness.slots[index]
      if (!previous || dependencies.some((dependency, i) => dependency !== previous.dependencies[i])) {
        harness.effects.push(() => {
          previous?.cleanup?.()
          harness.slots[index] = { dependencies, cleanup: callback() }
        })
      }
    },
  }
})
vi.mock('../../lib/supabase', () => ({ supabase: { functions: { invoke: harness.invoke } } }))
vi.mock('../ui', () => ({ Button: function Button() {} }))
import WeeklyEmail, { weeklyEmailStarted, weeklyEmailValidation, directEmailValidation } from './WeeklyEmail'

const draft = overrides => ({
  draft_id: 'draft-1', sender_id: 'sender-trent', from: 'Trent <trent@greenbayindoorgolf.com>', recipient_count: 12,
  missing_count: 2, subject: 'Week 3', text: 'Hello league!', status: 'draft',
  accepted_count: 0, review_count: 0, pending_count: 12, ...overrides,
})
const response = data => ({ data, error: null })
const approvedSenders = [{ id: 'sender-trent', from: 'Trent <trent@greenbayindoorgolf.com>', is_default: true }]
const status = (latest, senders = approvedSenders) => response({ latest, senders, from: (senders.find(item => item.is_default) || senders[0])?.from || '', setup: { configured: true, message: 'Configuration present.' } })
const settle = () => new Promise(resolve => setImmediate(resolve))
let props
let tree
function render(nextProps = props) {
  props = nextProps
  harness.cursor = 0
  tree = WeeklyEmail(props)
  harness.effects.splice(0).forEach(effect => effect())
  return tree
}
function nodes(node) {
  if (!arguments.length) node = tree
  if (!node || typeof node !== 'object') return []
  return [node, ...[].concat(node.props?.children || []).flat(Infinity).flatMap(child => nodes(child))]
}
function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  return [].concat(node.props?.children || []).flat(Infinity).map(textOf).join('')
}
const byId = id => nodes().find(node => node.props.id === id)
const button = label => nodes().find(node => node.props.onClick && textOf(node).includes(label))
async function mount(latest = null, senders = approvedSenders) {
  harness.invoke.mockResolvedValueOnce(status(latest, senders))
  render()
  await settle()
  render()
}
function writeMessage(subject = 'Week 3', text = 'Hello league!') {
  byId('weekly-email-subject').props.onChange({ target: { value: subject } })
  byId('weekly-email-body').props.onChange({ target: { value: text } })
  render()
}
async function previewMessage() {
  writeMessage()
  harness.invoke.mockResolvedValueOnce(response(draft()))
  await button('Preview email').props.onClick()
  render()
}

beforeEach(() => {
  harness.slots = []
  harness.cursor = 0
  harness.effects = []
  harness.invoke.mockReset()
  const storage = new Map()
  vi.stubGlobal('sessionStorage', { getItem: vi.fn(key => storage.get(key) || null), setItem: vi.fn((key, value) => storage.set(key, value)) })
  props = { eventId: 'event-1', locationId: 'gbig', onBusyChange: vi.fn(), onProgressChange: vi.fn() }
})

afterEach(() => vi.unstubAllGlobals())

describe('weekly email constraints', () => {
  it('requires subject and body, enforcing both size limits', () => {
    expect(weeklyEmailValidation(' ', 'Hi')).toMatch(/subject/)
    expect(weeklyEmailValidation('Hi', ' ')).toMatch(/message/)
    expect(weeklyEmailValidation('x'.repeat(201), 'Hi')).toMatch(/200/)
    expect(weeklyEmailValidation('Hi', 'x'.repeat(20001))).toMatch(/20,000/)
    expect(weeklyEmailValidation('x'.repeat(200), 'x'.repeat(20000))).toBe('')
  })
  it('locks attempted campaigns, including partial accepted or uncertain results', () => {
    expect(weeklyEmailStarted(null)).toBe(false)
    expect(weeklyEmailStarted(draft())).toBe(false)
    expect(weeklyEmailStarted(draft({ status: 'sending' }))).toBe(true)
    expect(weeklyEmailStarted(draft({ accepted_count: 1 }))).toBe(true)
    expect(weeklyEmailStarted(draft({ review_count: 1 }))).toBe(true)
  })
})

describe('weekly email component logic', () => {
  it('checks setup on mount without sending and displays the server sender', async () => {
    await mount()
    expect(harness.invoke).toHaveBeenCalledTimes(1)
    expect(harness.invoke).toHaveBeenCalledWith('weekly-email', { body: { action: 'status', event_id: 'event-1' } })
    expect(byId('weekly-email-from').props.value).toBe('Trent <trent@greenbayindoorgolf.com>')
    expect(byId('weekly-email-from').props.readOnly).toBe(true)
    expect(textOf(tree)).toMatch(/Gmail authorization validity and inbox delivery have not been tested/)
  })


  it('chooses the server default from multiple approved senders and exposes no free-form From field', async () => {
    const senders = [
      { id: 'sender-office', from: 'League Office <league@example.com>', is_default: false },
      ...approvedSenders,
    ]
    await mount(null, senders)
    expect(byId('weekly-email-from').type).toBe('select')
    expect(byId('weekly-email-from').props.value).toBe('sender-trent')
    const choices = nodes(byId('weekly-email-from')).filter(node => node.type === 'option' && node.props.value)
    expect(choices.map(node => node.props.value)).toEqual(['sender-office', 'sender-trent'])
    expect(byId('weekly-email-from').props.type).toBeUndefined()
  })
  it('uses the first server-approved sender when there is no default', async () => {
    await mount(null, [
      { id: 'sender-office', from: 'League Office <league@example.com>', is_default: false },
      { ...approvedSenders[0], is_default: false },
    ])
    expect(byId('weekly-email-from').props.value).toBe('sender-office')
  })
  it('invalidates a preview when the approved sender changes and submits only its ID', async () => {
    await mount(null, [...approvedSenders, { id: 'sender-office', from: 'League Office <league@example.com>', is_default: false }])
    await previewMessage()
    byId('weekly-email-from').props.onChange({ target: { value: 'sender-office' } })
    render()
    expect(button('Send to 12')).toBeUndefined()
    expect(textOf(tree)).toMatch(/message, sender, or recipient changed/)
    harness.invoke.mockResolvedValueOnce(response(draft({ sender_id: 'sender-office', from: 'League Office <league@example.com>' })))
    await button('Preview email').props.onClick()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'preview', event_id: 'event-1', sender_id: 'sender-office', subject: 'Week 3', text: 'Hello league!' } })
    expect(button('Send to 12').props.disabled).toBe(false)
  })
  it('fixes the sender label once sending has started even when other senders are permitted', async () => {
    await mount(draft({ status: 'sending', accepted_count: 10, pending_count: 2 }), [...approvedSenders, { id: 'sender-office', from: 'League Office <league@example.com>', is_default: false }])
    expect(byId('weekly-email-from').type).toBe('input')
    expect(byId('weekly-email-from').props.readOnly).toBe(true)
    expect(byId('weekly-email-from').props.value).toBe('Trent <trent@greenbayindoorgolf.com>')
    expect(byId('weekly-email-from').props.onChange).toBeUndefined()
  })
  it('keeps a started draft readable after its sender permission is removed without changing identity', async () => {
    await mount(draft({ status: 'sending', accepted_count: 10, pending_count: 2 }), [])
    expect(byId('weekly-email-from').props.value).toBe('Trent <trent@greenbayindoorgolf.com>')
    expect(byId('weekly-email-body').props.value).toBe('Hello league!')
    expect(button('Continue sending').props.disabled).toBe(true)
    expect(textOf(tree)).toMatch(/restore sender access/)
    expect(textOf(tree)).toMatch(/12 unique recipient addresses/)
  })
  it('lets an unstarted draft with a removed sender switch to its only approved replacement', async () => {
    await mount(draft(), [{ id: 'sender-office', from: 'League Office <league@example.com>', is_default: true }])
    expect(byId('weekly-email-from').props.value).toBe('Trent <trent@greenbayindoorgolf.com>')
    expect(button('Send to 12').props.disabled).toBe(true)
    button('Use League Office').props.onClick()
    render()
    expect(byId('weekly-email-from').props.value).toBe('League Office <league@example.com>')
    expect(button('Send to 12')).toBeUndefined()
    expect(button('Preview email').props.disabled).toBe(false)
  })
  it('does not preview or send when the venue has no approved sender', async () => {
    await mount(null, [])
    writeMessage()
    expect(button('Preview email').props.disabled).toBe(true)
    expect(textOf(tree)).toMatch(/Weekly Email is optional/)
    await button('Preview email').props.onClick()
    expect(harness.invoke).toHaveBeenCalledTimes(1)
  })
  it('resets sender selection for a different venue and uses its server-approved default', async () => {
    await mount()
    writeMessage()
    const jordan = [{ id: 'sender-jordan', from: 'Jordan <jordan@appletonindoorgolf.com>', is_default: true }]
    harness.invoke.mockResolvedValueOnce(status(null, jordan))
    render({ ...props, eventId: 'event-appleton', locationId: 'appleton' })
    await settle()
    render()
    expect(byId('weekly-email-from').props.value).toBe('Jordan <jordan@appletonindoorgolf.com>')
    expect(byId('weekly-email-subject').props.value).toBe('')
    expect(byId('weekly-email-body').props.value).toBe('')
  })

  it('reports a failed initial status check to the dashboard without inventing sending progress', async () => {
    harness.invoke.mockResolvedValueOnce({ data: null, error: new Error('Status unavailable') })
    render()
    await settle()
    render()
    expect(props.onProgressChange).toHaveBeenLastCalledWith({ eventId: 'event-1', locationId: 'gbig', statusError: 'Status unavailable' })
    expect(button('Refresh email status').props.disabled).toBe(false)
  })

  it('previews server counts and sends only after an explicit click', async () => {
    await mount()
    await previewMessage()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'preview', event_id: 'event-1', sender_id: 'sender-trent', subject: 'Week 3', text: 'Hello league!' } })
    expect(textOf(tree)).toMatch(/12 unique recipient addresses/)
    expect(textOf(tree)).toMatch(/2 rostered players without a usable email/)
    expect(harness.invoke).toHaveBeenCalledTimes(2)
    harness.invoke.mockResolvedValueOnce(response(draft({ status: 'sending', accepted_count: 10, pending_count: 2 })))
    await button('Send to 12').props.onClick()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'send', event_id: 'event-1', draft_id: 'draft-1' } })
    expect(byId('weekly-email-subject').props.disabled).toBe(true)
    expect(button('Continue sending').props.disabled).toBe(false)
    expect(props.onProgressChange).toHaveBeenLastCalledWith({ eventId: 'event-1', locationId: 'gbig', started: true, pending: 2, review: 0, statusError: '' })
    expect(textOf(tree)).toMatch(/Accepted by the email service does not confirm delivery/)
  })
  it('invalidates the send action when previewed content is edited', async () => {
    await mount()
    await previewMessage()
    writeMessage('Revised subject')
    expect(button('Send to 12')).toBeUndefined()
    expect(textOf(tree)).toMatch(/Preview again before sending/)
    expect(harness.invoke).toHaveBeenCalledTimes(2)
  })
  it('retains unsaved content during an email setup check', async () => {
    await mount(draft())
    writeMessage('Unsaved subject', 'New writing')
    harness.invoke.mockResolvedValueOnce(status(draft()))
    await button('Check email setup').props.onClick()
    render()
    expect(byId('weekly-email-subject').props.value).toBe('Unsaved subject')
    expect(byId('weekly-email-body').props.value).toBe('New writing')
    expect(button('Send to 12')).toBeUndefined()
  })
  it('suppresses repeated clicks while a send is unresolved', async () => {
    await mount()
    await previewMessage()
    let resolveSend
    harness.invoke.mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve }))
    const click = button('Send to 12').props.onClick
    const first = click()
    await click()
    expect(harness.invoke).toHaveBeenCalledTimes(3)
    resolveSend(response(draft({ status: 'sending', accepted_count: 10, pending_count: 2 })))
    await first
  })
  it('resumes a saved partial send with an explicit Continue and unchanged draft ID', async () => {
    await mount(draft({ status: 'sending', accepted_count: 10, pending_count: 2 }))
    expect(byId('weekly-email-body').props.value).toBe('Hello league!')
    expect(byId('weekly-email-body').props.disabled).toBe(true)
    expect(harness.invoke).toHaveBeenCalledTimes(1)
    harness.invoke.mockResolvedValueOnce(response(draft({ status: 'accepted', accepted_count: 12, pending_count: 0 })))
    await button('Continue sending').props.onClick()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'send', event_id: 'event-1', draft_id: 'draft-1' } })
    expect(button('Continue sending')).toBeUndefined()
    expect(textOf(tree)).toMatch(/All 12 emails accepted by the email service/)
    expect(props.onProgressChange).toHaveBeenLastCalledWith({ eventId: 'event-1', locationId: 'gbig', started: true, pending: 0, review: 0, statusError: '' })
  })
  it('requires a status refresh after an uncertain request and never unlocks the draft', async () => {
    await mount()
    await previewMessage()
    harness.invoke.mockResolvedValueOnce({ data: null, error: new Error('Connection lost') })
    await button('Send to 12').props.onClick()
    render()
    expect(button('Continue sending').props.disabled).toBe(true)
    expect(byId('weekly-email-body').props.disabled).toBe(true)
    expect(textOf(tree)).toMatch(/Refresh email status before continuing/)
    harness.invoke.mockResolvedValueOnce(status(draft({ status: 'review', review_count: 1, accepted_count: 9, pending_count: 2 })))
    await button('Refresh email status').props.onClick()
    render()
    expect(button('Continue sending').props.disabled).toBe(false)
    expect(textOf(tree)).toMatch(/not automatically retried/)
  })

  it('unlocks a server-confirmed unstarted draft after a rejected send so the roster can be previewed again', async () => {
    await mount()
    await previewMessage()
    harness.invoke.mockResolvedValueOnce({ data: null, error: new Error('The recipient list changed. Preview again.') })
    await button('Send to 12').props.onClick()
    render()
    expect(byId('weekly-email-body').props.disabled).toBe(true)
    harness.invoke.mockResolvedValueOnce(status(draft()))
    await button('Refresh email status').props.onClick()
    render()
    expect(byId('weekly-email-body').props.disabled).toBe(false)
    expect(button('Refresh preview and audience').props.disabled).toBe(false)
    expect(props.onProgressChange).toHaveBeenLastCalledWith({ eventId: 'event-1', locationId: 'gbig', started: false, pending: 12, review: 0, statusError: '' })
  })
  it('restores a replacement draft after a stale-preview send is rejected', async () => {
    await mount()
    await previewMessage()
    harness.invoke.mockResolvedValueOnce({ data: null, error: new Error('Preview out of date.') })
    await button('Send to 12').props.onClick()
    render()
    harness.invoke.mockResolvedValueOnce(status(draft({ draft_id: 'draft-2', subject: 'Latest preview' })))
    await button('Refresh email status').props.onClick()
    render()
    expect(byId('weekly-email-subject').props.value).toBe('Latest preview')
    expect(byId('weekly-email-subject').props.disabled).toBe(false)
  })
  it('displays an unconfirmed batch warning rather than saying the batch finished', async () => {
    await mount()
    await previewMessage()
    harness.invoke.mockResolvedValueOnce(response(draft({ status: 'sending', message: 'Sending stopped without a confirmed result. Retry this same email.' })))
    await button('Send to 12').props.onClick()
    render()
    expect(textOf(tree)).toMatch(/Sending stopped without a confirmed result/)
    expect(textOf(tree)).not.toMatch(/Batch finished/)
    expect(textOf(tree)).toMatch(/Pending or unconfirmed/)
    expect(button('Continue sending').props.disabled).toBe(false)
  })

  it('does not offer a new send for a completed or review-only campaign', async () => {
    await mount(draft({ status: 'review', review_count: 1, accepted_count: 11, pending_count: 0 }))
    expect(button('Continue sending')).toBeUndefined()
    expect(button('Preview email')).toBeUndefined()
    expect(byId('weekly-email-subject').props.disabled).toBe(true)
  })
  it('ignores a preview response after changing rounds and resets composing state', async () => {
    await mount()
    writeMessage()
    let resolvePreview
    harness.invoke.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve }))
    const pendingPreview = button('Preview email').props.onClick()
    harness.invoke.mockResolvedValueOnce(status(null))
    render({ ...props, eventId: 'event-2' })
    await settle()
    resolvePreview(response(draft()))
    await pendingPreview
    render()
    expect(byId('weekly-email-subject').props.value).toBe('')
    expect(byId('weekly-email-body').props.value).toBe('')
    expect(button('Send to 12')).toBeUndefined()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'status', event_id: 'event-2' } })
  })
  it('blocks sending until the server reports service configuration', async () => {
    harness.invoke.mockResolvedValueOnce(response({ latest: draft(), senders: approvedSenders, from: 'Trent <trent@greenbayindoorgolf.com>', setup: { configured: false, message: 'Missing service configuration.' } }))
    render()
    await settle()
    render()
    expect(button('Send to 12').props.disabled).toBe(true)
    expect(textOf(tree)).toMatch(/configuration is required before sending/)
  })
})


describe('direct Email composition', () => {
  const directDraft = (compose_id, overrides = {}) => draft({ mode: 'direct', compose_id, to: 'test@example.com', recipient_count: 1, missing_count: 0, pending_count: 1, ...overrides })
  function directProps() {
    props = { ...props, mode: 'direct', eventId: undefined, actorId: 'staff-1' }
  }
  function writeTo(value = 'test@example.com') {
    byId('weekly-email-to').props.onChange({ target: { value } })
    render()
  }
  async function directPreview() {
    writeTo()
    writeMessage()
    harness.invoke.mockImplementationOnce(async (_name, { body }) => response(directDraft(body.compose_id)))
    await button('Preview email').props.onClick()
    render()
    return harness.invoke.mock.calls.at(-1)[1].body.compose_id
  }

  it('accepts recipient lists and rejects invalid entries or display-name syntax', () => {
    expect(directEmailValidation('test@example.com')).toBe('')
    for (const to of ['a@example.com,b@example.com', 'a@example.com;b@example.com', 'a@example.com\nb@example.com']) expect(directEmailValidation(to)).toBe('')
    for (const to of ['', 'Name <a@example.com>', 'no-address', 'a@example.com,not-an-email']) {
      expect(directEmailValidation(to)).not.toBe('')
    }
  })
  it('opens without a round and does not guess a To address or use roster fields', async () => {
    directProps()
    await mount()
    expect(harness.invoke).toHaveBeenCalledWith('weekly-email', { body: { action: 'status', mode: 'direct', location_id: 'gbig' } })
    expect(byId('weekly-email-to').props.value).toBe('')
    expect(button('Send email')).toBeUndefined()
    expect(textOf(tree)).toMatch(/No round or weekly schedule is required/)
    expect(textOf(tree)).not.toMatch(/Finish sending before closing/)
    expect(harness.invoke).toHaveBeenCalledTimes(1)
  })
  it('previews only the entered To address and sends only on the explicit Send click', async () => {
    directProps()
    await mount()
    const composeId = await directPreview()
    expect(composeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'preview', mode: 'direct', location_id: 'gbig', compose_id: composeId, sender_id: 'sender-trent', to: 'test@example.com', subject: 'Week 3', text: 'Hello league!' } })
    expect(harness.invoke).toHaveBeenCalledTimes(2)
    expect(textOf(tree)).toContain('test@example.com')
    expect(textOf(tree)).toContain('1 recipient · separate private copies')
    expect(textOf(tree)).not.toMatch(/rostered players without/)
    harness.invoke.mockResolvedValueOnce(response(directDraft(composeId, { status: 'accepted', accepted_count: 1, pending_count: 0 })))
    await button('Send email').props.onClick()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'send', mode: 'direct', location_id: 'gbig', draft_id: 'draft-1' } })
    expect(byId('weekly-email-to').props.disabled).toBe(true)
    expect(byId('weekly-email-body').props.disabled).toBe(true)
    expect(button('New email')).toBeDefined()
    expect(textOf(tree)).toMatch(/All 1 email accepted by the email service/)
  })
  it('invalidates the direct preview after To changes and reuses the compose ID on re-preview', async () => {
    directProps()
    await mount()
    const composeId = await directPreview()
    writeTo('second@example.com')
    expect(button('Send email')).toBeUndefined()
    harness.invoke.mockImplementationOnce(async (_name, { body }) => response(directDraft(body.compose_id, { to: body.to, draft_id: 'draft-2' })))
    await button('Preview email').props.onClick()
    render()
    expect(harness.invoke.mock.calls.at(-1)[1].body).toMatchObject({ compose_id: composeId, to: 'second@example.com' })
    expect(button('Send email').props.disabled).toBe(false)
  })
  it('restores an interrupted direct campaign without automatically sending', async () => {
    directProps()
    const composeId = '11111111-1111-4111-8111-111111111111'
    await mount(directDraft(composeId, { status: 'sending' }))
    expect(byId('weekly-email-to').props.value).toBe('test@example.com')
    expect(byId('weekly-email-to').props.disabled).toBe(true)
    expect(button('New email').props.disabled).toBe(false)
    expect(harness.invoke).toHaveBeenCalledTimes(1)
    harness.invoke.mockResolvedValueOnce(status(directDraft(composeId, { status: 'sending' })))
    await button('Refresh email status').props.onClick()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'status', mode: 'direct', location_id: 'gbig', compose_id: composeId } })
    expect(button('Continue sending').props.disabled).toBe(false)
  })
  it('starts a blank separate compose session only after New email and ignores stale completed status', async () => {
    directProps()
    const oldCompose = '11111111-1111-4111-8111-111111111111'
    const completed = directDraft(oldCompose, { status: 'accepted', accepted_count: 1, pending_count: 0 })
    await mount(completed)
    expect(byId('weekly-email-to').props.disabled).toBe(true)
    button('New email').props.onClick()
    render()
    expect(byId('weekly-email-to').props.value).toBe('')
    expect(byId('weekly-email-subject').props.value).toBe('')
    expect(byId('weekly-email-body').props.disabled).toBe(false)
    expect(harness.invoke).toHaveBeenCalledTimes(1)
    harness.invoke.mockResolvedValueOnce(status(completed))
    await button('Check email setup').props.onClick()
    render()
    expect(byId('weekly-email-to').props.value).toBe('')
    expect(byId('weekly-email-body').props.disabled).toBe(false)
    const newCompose = await directPreview()
    expect(newCompose).not.toBe(oldCompose)
  })

  it('remembers only the opaque compose ID and restores that exact email after a full component reload', async () => {
    directProps()
    props.actorId = 'staff-1'
    await mount()
    const composeId = await directPreview()
    const key = 'weekly-email:compose:gbig:staff-1'
    expect(globalThis.sessionStorage.getItem(key)).toBe(composeId)
    for (const [storedKey, value] of globalThis.sessionStorage.setItem.mock.calls) {
      expect(storedKey).toBe(key)
      expect(value).toMatch(/^[0-9a-f-]{36}$/)
      expect(value).not.toContain('example.com')
      expect(value).not.toContain('Hello')
    }
    harness.slots = []
    harness.cursor = 0
    harness.effects = []
    harness.invoke.mockResolvedValueOnce(status(directDraft(composeId, { status: 'sending' })))
    render()
    await settle()
    render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email', { body: { action: 'status', mode: 'direct', location_id: 'gbig', compose_id: composeId } })
    expect(byId('weekly-email-to').props.value).toBe('test@example.com')
    expect(byId('weekly-email-to').props.disabled).toBe(true)
  })
  it('survives unavailable session storage and warns that the active email cannot be restored reliably', async () => {
    directProps()
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('Blocked') }, setItem() { throw new Error('Blocked') } })
    await mount()
    expect(textOf(tree)).toMatch(/cannot remember the active email across reloads/)
    expect(byId('weekly-email-to').props.disabled).toBe(false)
    const composeId = await directPreview()
    expect(composeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(button('Send email').props.disabled).toBe(false)
  })


  it('does not use a persisted compose key until the signed-in actor is known', async () => {
    directProps()
    props.actorId = undefined
    await mount()
    await directPreview()
    expect(globalThis.sessionStorage.getItem).not.toHaveBeenCalled()
    expect(globalThis.sessionStorage.setItem).not.toHaveBeenCalled()
  })
  it('invalidates a direct preview when the approved sender is changed', async () => {
    directProps()
    await mount(null, [...approvedSenders, { id: 'sender-office', from: 'League Office <league@example.com>', is_default: false }])
    await directPreview()
    byId('weekly-email-from').props.onChange({ target: { value: 'sender-office' } })
    render()
    expect(button('Send email')).toBeUndefined()
    expect(button('Preview email').props.disabled).toBe(false)
  })
  it('shows a provider-limit failure without sending again', async () => {
    directProps()
    await mount()
    await directPreview()
    harness.invoke.mockResolvedValueOnce({ data: null, error: { message: 'Non-2xx status', context: { json: async () => ({ error: 'Gmail sending limit reached. Check the sender account.' }) } } })
    await button('Send email').props.onClick()
    render()
    expect(textOf(tree)).toMatch(/Gmail sending limit reached/)
    expect(button('Continue sending').props.disabled).toBe(true)
    expect(harness.invoke).toHaveBeenCalledTimes(3)
  })

  it('rejects a preview whose recipient count differs from the entered list', async () => {
    directProps()
    await mount()
    writeTo()
    writeMessage()
    harness.invoke.mockImplementationOnce(async (_name, { body }) => response(directDraft(body.compose_id, { recipient_count: 2, pending_count: 2 })))
    await button('Preview email').props.onClick()
    render()
    expect(button('Send email')).toBeUndefined()
    expect(textOf(tree)).toMatch(/preview recipient list did not match/)
  })
  it('reviews a deduplicated list and sends all saved chunks from one explicit click', async () => {
    directProps();await mount()
    const addresses=Array.from({length:12},(_,i)=>`p${i}@example.com`)
    writeTo(addresses.join(';')+';p0@example.com');writeMessage()
    let compose
    const group=overrides=>directDraft(compose,{to:addresses.join(', '),to_addresses:addresses,recipient_count:12,pending_count:12,...overrides})
    harness.invoke.mockImplementationOnce(async(_name,{body})=>{compose=body.compose_id;return response(group())})
    await button('Preview email').props.onClick();render()
    expect(byId('weekly-email-to').type).toBe('textarea')
    expect(textOf(tree)).toContain('12 recipients · separate private copies')
    expect(button('Send to 12 recipients').props.disabled).toBe(false)
    harness.invoke.mockResolvedValueOnce(response(group({status:'sending',accepted_count:10,pending_count:2})))
    harness.invoke.mockResolvedValueOnce(response(group({status:'accepted',accepted_count:12,pending_count:0})))
    await button('Send to 12 recipients').props.onClick();render()
    expect(harness.invoke.mock.calls.slice(-2).map(call=>call[1].body)).toEqual(Array(2).fill({action:'send',mode:'direct',location_id:'gbig',draft_id:'draft-1'}))
    expect(textOf(tree)).toContain('All 12 emails accepted')
    expect(byId('weekly-email-to').props.disabled).toBe(true)
  })
  it('stops automatic continuation on uncertain delivery instead of silently proceeding', async () => {
    directProps();await mount();writeTo('a@example.com,b@example.com');writeMessage()
    let compose
    const group=overrides=>directDraft(compose,{to:'a@example.com, b@example.com',to_addresses:['a@example.com','b@example.com'],recipient_count:2,pending_count:2,...overrides})
    harness.invoke.mockImplementationOnce(async(_name,{body})=>{compose=body.compose_id;return response(group())})
    await button('Preview email').props.onClick();render()
    harness.invoke.mockResolvedValueOnce(response(group({status:'review',review_count:1,pending_count:1,message:'Check Sent mail.'})))
    await button('Send to 2 recipients').props.onClick();render()
    expect(harness.invoke).toHaveBeenCalledTimes(3)
    expect(button('Continue sending')).toBeDefined()
  })
  it('bulk adds a chosen league, preserves extra addresses, deduplicates, and requires a fresh preview',async()=>{
    directProps();await mount();writeTo('extra@example.com;member@example.com');writeMessage('Announcement','Any day')
    harness.invoke.mockResolvedValueOnce(response({leagues:[{id:'league-2',name:'Monday league'}]}))
    await button('Choose venue or league members').props.onClick();render()
    byId('weekly-email-group').props.onChange({target:{value:'league-2'}});render()
    harness.invoke.mockResolvedValueOnce(response({addresses:['member@example.com','other@example.com'],missing_count:2}))
    await button('Add whole league to To').props.onClick();render()
    expect(harness.invoke).toHaveBeenLastCalledWith('weekly-email',{body:{action:'audience',mode:'direct',location_id:'gbig',source:'league',league_id:'league-2'}})
    expect(byId('weekly-email-to').props.value).toBe('extra@example.com, member@example.com, other@example.com')
    expect(textOf(tree)).toContain('2 member records had no usable email address')
    expect(button('Preview email').props.disabled).toBe(false)
    expect(button('Send to')).toBeUndefined()
  })
  it('starts another message while an old send is pending and restores the exact saved email without sending',async()=>{
    directProps()
    const compose='11111111-1111-4111-8111-111111111111'
    const saved=directDraft(compose,{status:'sending'})
    await mount(saved)
    button('New email').props.onClick();render()
    expect(byId('weekly-email-to').props.value).toBe('')
    expect(nodes(byId('weekly-email-saved')).some(node=>node.props.value===compose)).toBe(true)
    harness.invoke.mockResolvedValueOnce(status(saved))
    byId('weekly-email-saved').props.onChange({target:{value:compose}})
    await settle();render()
    expect(byId('weekly-email-to').props.value).toBe('test@example.com')
    expect(button('Continue sending').props.disabled).toBe(false)
    expect(harness.invoke.mock.calls.every(call=>call[1].body.action==='status')).toBe(true)
  })
  it('processes 500 reviewed recipients from one click with no per-day application cap',async()=>{
    directProps();await mount()
    const addresses=Array.from({length:500},(_,i)=>`p${i}@example.com`)
    writeTo(addresses.join('\n'));writeMessage('Venue announcement','Any day of the week')
    let compose
    const group=overrides=>directDraft(compose,{to:addresses.join(', '),to_addresses:addresses,recipient_count:500,pending_count:500,...overrides})
    harness.invoke.mockImplementationOnce(async(_name,{body})=>{compose=body.compose_id;return response(group())})
    await button('Preview email').props.onClick();render()
    for(let accepted=10;accepted<=500;accepted+=10) harness.invoke.mockResolvedValueOnce(response(group({status:accepted===500?'accepted':'sending',accepted_count:accepted,pending_count:500-accepted})))
    await button('Send to 500 recipients').props.onClick();render()
    expect(harness.invoke.mock.calls.filter(call=>call[1].body.action==='send')).toHaveLength(50)
    expect(textOf(tree)).toContain('All 500 emails accepted')
    expect(textOf(tree)).toContain('There is no app daily cap')
  })
  it('pauses after the current batch and keeps the rest for an explicit Continue',async()=>{
    directProps();await mount();writeTo('a@example.com,b@example.com');writeMessage()
    let compose,resolveSend
    const group=overrides=>directDraft(compose,{to:'a@example.com, b@example.com',to_addresses:['a@example.com','b@example.com'],recipient_count:2,pending_count:2,...overrides})
    harness.invoke.mockImplementationOnce(async(_name,{body})=>{compose=body.compose_id;return response(group())})
    await button('Preview email').props.onClick();render()
    harness.invoke.mockImplementationOnce(()=>new Promise(resolve=>{resolveSend=resolve}))
    const sendPromise=button('Send to 2 recipients').props.onClick();render()
    button('Pause after this batch').props.onClick();render()
    resolveSend(response(group({status:'sending',accepted_count:1,pending_count:1})))
    await sendPromise;render()
    expect(harness.invoke.mock.calls.filter(call=>call[1].body.action==='send')).toHaveLength(1)
    expect(textOf(tree)).toContain('Sending paused. Your progress is saved')
    expect(button('Continue sending').props.disabled).toBe(false)
    expect(button('New email').props.disabled).toBe(false)
  })
})
