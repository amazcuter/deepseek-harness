import { describe, expect, it } from 'vitest'
import { JOIN_NOT_FIRED, computeJoin } from '../src/join.ts'

describe('computeJoin', () => {
  it('fires an all-join once every activated edge completed', () => {
    expect(computeJoin('all', ['a', 'b'], ['a', 'b'])).toEqual({
      fire: true,
      consumed: ['a', 'b'],
      pending: [],
      state: { fired: true },
    })
  })

  it('waits while an activated edge is still pending', () => {
    expect(computeJoin('all', ['a', 'b'], ['a'])).toEqual({
      fire: false,
      consumed: [],
      pending: ['b'],
      state: { fired: false },
    })
  })

  it('ignores completions from edges that were never activated', () => {
    const outcome = computeJoin('all', ['a'], ['a', 'unactivated'])
    expect(outcome.fire).toBe(true)
    expect(outcome.consumed).toEqual(['a'])
  })

  it('does not fire an all-join with no activated incoming edges', () => {
    expect(computeJoin('all', [], [])).toEqual({ fire: false, consumed: [], pending: [], state: { fired: false } })
  })

  it('fires an all-join at most once per activation', () => {
    const first = computeJoin('all', ['a'], ['a'])
    const second = computeJoin('all', ['a'], ['a'], first.state)
    expect(second).toEqual({ fire: false, consumed: [], pending: [], state: first.state })
  })

  it('reports pending ids in activated order and deduplicates them', () => {
    const outcome = computeJoin('all', ['b', 'a', 'b'], [])
    expect(outcome.pending).toEqual(['b', 'a'])
    expect(outcome.state).toBe(JOIN_NOT_FIRED)
  })

  it('fires a first-success join on the first completion', () => {
    expect(computeJoin('first-success', ['a', 'b'], ['a'])).toEqual({
      fire: true,
      consumed: ['a'],
      pending: [],
      state: { fired: true },
    })
  })

  it('consumes later first-success completions without firing again', () => {
    const first = computeJoin('first-success', ['a', 'b'], ['a'])
    const second = computeJoin('first-success', ['a', 'b'], ['a', 'b'], first.state)
    expect(second).toEqual({ fire: false, consumed: ['a', 'b'], pending: [], state: first.state })
  })

  it('does not fire a first-success join without a completion', () => {
    expect(computeJoin('first-success', ['a', 'b'], [])).toEqual({
      fire: false,
      consumed: [],
      pending: [],
      state: JOIN_NOT_FIRED,
    })
  })

  it('does not fire a first-success join with no activated incoming edges', () => {
    const outcome = computeJoin('first-success', [], ['a'])
    expect(outcome.fire).toBe(false)
    expect(outcome.consumed).toEqual([])
  })

  it('reuses the shared not-fired state object', () => {
    expect(computeJoin('all', ['a'], []).state).toBe(JOIN_NOT_FIRED)
    expect(JOIN_NOT_FIRED.fired).toBe(false)
  })

  it('accepts an explicit state that already fired', () => {
    const outcome = computeJoin('first-success', ['a'], ['a'], { fired: true })
    expect(outcome.fire).toBe(false)
    expect(outcome.consumed).toEqual(['a'])
  })
})
