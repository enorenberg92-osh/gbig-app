import { describe, expect, it, vi, afterEach } from 'vitest'
import { readScoreDraft, saveScoreDraft, clearScoreDraft, scoreDraftKey } from './scoreDraft'

const context = {
  userId: 'golfer-a', locationId: 'green-bay', leagueId: 'fall', eventId: 'week-2',
  teamId: 'team-a', playerIds: ['a', 'b'], courseId: 'course-a', numHoles: 2,
  startHole: 1, holePars: [4, 3],
}
const draft = {
  scores: { p1: [5, null], p2: [4, 3] },
  stats: { p1: [{ putts: 2, fir: false, gir: true }, {}], p2: [{}, {}] },
  currentHole: 1, showStats: true,
}
function memoryStorage() {
  const items = new Map()
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('unfinished scorecard recovery', () => {
  it('restores both golfers, unplayed holes, false stats, and the current hole after reopening', () => {
    const storage = memoryStorage()
    expect(saveScoreDraft(context, draft, storage)).toBe('saved')
    expect(readScoreDraft(context, storage)).toEqual({ status: 'restored', ...draft })
  })

  it.each(['userId', 'locationId', 'leagueId', 'eventId', 'teamId'])('never restores a different %s', field => {
    const storage = memoryStorage()
    saveScoreDraft(context, draft, storage)
    expect(readScoreDraft({ ...context, [field]: 'different' }, storage).status).toBe('empty')
  })

  it('keeps scores with their golfer if the roster query returns the opposite order', () => {
    const storage = memoryStorage()
    saveScoreDraft(context, draft, storage)
    const restored = readScoreDraft({ ...context, playerIds: ['b', 'a'] }, storage)
    expect(restored.scores).toEqual({ p1: draft.scores.p2, p2: draft.scores.p1 })
    expect(restored.stats).toEqual({ p1: draft.stats.p2, p2: draft.stats.p1 })
  })

  it.each([
    { playerIds: ['a', 'sub'] }, { courseId: 'course-b' }, { numHoles: 9 },
    { startHole: 10 }, { holePars: [3, 4] },
  ])('does not apply a draft to changed round setup: %j', changes => {
    const storage = memoryStorage()
    saveScoreDraft(context, draft, storage)
    expect(readScoreDraft({ ...context, ...changes }, storage).status).toBe('incompatible')
  })

  it('discards only this draft after a confirmed submission', () => {
    const storage = memoryStorage()
    const other = { ...context, eventId: 'week-3' }
    saveScoreDraft(context, draft, storage)
    saveScoreDraft(other, draft, storage)
    clearScoreDraft(context, storage)
    expect(readScoreDraft(context, storage).status).toBe('empty')
    expect(readScoreDraft(other, storage).status).toBe('restored')
  })

  it('survives corrupt JSON and malformed score values', () => {
    const storage = memoryStorage()
    storage.setItem(scoreDraftKey(context), '{bad')
    expect(readScoreDraft(context, storage).status).toBe('incompatible')
    saveScoreDraft(context, draft, storage)
    const corrupt = JSON.parse(storage.getItem(scoreDraftKey(context)))
    corrupt.players[0].scores[0] = 400
    storage.setItem(scoreDraftKey(context), JSON.stringify(corrupt))
    expect(readScoreDraft(context, storage).status).toBe('incompatible')
  })

  it('reports storage failure without crashing or losing the previous saved card', () => {
    const storage = memoryStorage()
    saveScoreDraft(context, draft, storage)
    storage.setItem = () => { throw new Error('Quota exceeded') }
    expect(saveScoreDraft(context, { ...draft, currentHole: 0 }, storage)).toBe('unavailable')
    expect(readScoreDraft(context, storage).currentHole).toBe(1)
  })

  it('handles browsers that throw when accessing localStorage itself', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked') } })
    expect(readScoreDraft(context).status).toBe('unavailable')
    expect(saveScoreDraft(context, draft)).toBe('unavailable')
    expect(() => clearScoreDraft(context)).not.toThrow()
  })

  it('does not create a draft for a round the golfer merely opened', () => {
    const storage = memoryStorage()
    const blank = { scores: { p1: [null, null], p2: [null, null] }, stats: { p1: [{}, {}], p2: [{}, {}] }, currentHole: 0, showStats: false }
    expect(saveScoreDraft(context, blank, storage)).toBe('empty')
    expect(readScoreDraft(context, storage).status).toBe('empty')
  })
})
