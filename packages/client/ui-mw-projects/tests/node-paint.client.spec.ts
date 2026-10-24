/**
 * How one drawn node is painted: the fill and stroke its activation status
 * carries, and the heavier stroke that marks the node the inspector shows.
 */
import { describe, expect, it } from 'vitest'
import { nodePaint } from '../src/client/node-paint.ts'

describe('nodePaint', () => {
  it('paints a node no run reached with the neutral layer and border', () => {
    expect(nodePaint('idle', false)).toEqual({
      fill: 'var(--dsw-alias-bg-layer-2)',
      stroke: 'var(--dsw-alias-border-l4)',
      strokeWidth: 1,
    })
  })

  it('paints each activation status with its own state token pair', () => {
    expect(nodePaint('running', false)).toEqual({
      fill: 'var(--dsw-alias-state-business-tertiary)',
      stroke: 'var(--dsw-alias-state-business-primary)',
      strokeWidth: 1,
    })
    expect(nodePaint('waiting', false)).toEqual({
      fill: 'var(--dsw-alias-state-warn-tertiary)',
      stroke: 'var(--dsw-alias-state-warn-primary)',
      strokeWidth: 1,
    })
    expect(nodePaint('succeeded', false)).toEqual({
      fill: 'var(--dsw-alias-state-success-tertiary)',
      stroke: 'var(--dsw-alias-state-success-primary)',
      strokeWidth: 1,
    })
    expect(nodePaint('failed', false)).toEqual({
      fill: 'var(--dsw-alias-file-diff-deleted-bg)',
      stroke: 'var(--dsw-alias-state-error-primary)',
      strokeWidth: 1,
    })
    expect(nodePaint('canceled', false)).toEqual({
      fill: 'var(--dsw-alias-bg-layer-3)',
      stroke: 'var(--dsw-alias-state-idle-primary)',
      strokeWidth: 1,
    })
  })

  it('paints the node the inspector shows with the brand stroke', () => {
    expect(nodePaint('succeeded', true)).toEqual({
      fill: 'var(--dsw-alias-state-success-tertiary)',
      stroke: 'var(--dsw-alias-brand-primary)',
      strokeWidth: 2.5,
    })
  })

  it('falls back to the idle painting for a status it does not know', () => {
    expect(nodePaint('throttled', false)).toEqual(nodePaint('idle', false))
  })
})
