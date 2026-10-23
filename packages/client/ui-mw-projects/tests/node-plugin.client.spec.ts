import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-mw-projects node half', () => {
  it('mounts no Host row: the dashboard is a browser surface', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
