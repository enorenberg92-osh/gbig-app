import { describe, expect, it } from 'vitest'
import { fetchAllRows } from './supabasePaging'

function fakeTable(total, { failAt = null } = {}) {
  const calls = []
  const makeQuery = () => ({
    range(from, to) {
      calls.push([from, to])
      if (failAt != null && from >= failAt) return Promise.resolve({ data: null, error: { message: 'boom' } })
      const data = []
      for (let i = from; i <= Math.min(to, total - 1); i++) data.push({ id: i })
      return Promise.resolve({ data, error: null })
    },
  })
  return { makeQuery, calls }
}

describe('fetchAllRows', () => {
  it('pages past the row cap until a short page', async () => {
    const { makeQuery, calls } = fakeTable(2500)
    const { data, error } = await fetchAllRows(makeQuery, 1000)
    expect(error).toBe(null)
    expect(data).toHaveLength(2500)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops after one extra empty page on an exact multiple', async () => {
    const { makeQuery, calls } = fakeTable(2000)
    const { data } = await fetchAllRows(makeQuery, 1000)
    expect(data).toHaveLength(2000)
    expect(calls).toHaveLength(3)
  })

  it('surfaces errors', async () => {
    const { makeQuery } = fakeTable(5000, { failAt: 1000 })
    const { data, error } = await fetchAllRows(makeQuery, 1000)
    expect(data).toBe(null)
    expect(error.message).toBe('boom')
  })
})
