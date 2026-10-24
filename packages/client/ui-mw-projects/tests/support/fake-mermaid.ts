/**
 * Mermaid stand-in for the canvas specs.
 *
 * The real library lays out a diagram by measuring text in a browser, which
 * jsdom cannot do, so these specs drive the canvas through this module instead:
 * it reads the generated flowchart source and answers with the same SVG shape
 * Mermaid produces — one `g.node` per drawn node, carrying the Mermaid id and
 * the label text. `useRenderMode` selects the variants the canvas must survive:
 * a Mermaid that only puts the id on the group, a refused render, groups that
 * resolve to no definition node, and a node drawn without a shape.
 */
import { vi, type Mock } from 'vitest'

/** How the stand-in answers the next render. */
export type FakeRenderMode =
  | 'data-id'
  | 'id-only'
  | 'refused'
  | 'non-error'
  | 'unresolvable'
  | 'shapeless'

/** One `  <id>["<label>"]` node line of a generated flowchart source. */
const NODE_LINE = /^ {2}([A-Za-z][A-Za-z0-9_]*)\["(.*)"\]$/

/** Groups Mermaid draws that belong to no definition node. */
const unresolvable = (id: string): string => `<g class="node" id="${id}-cluster-0"></g>`
  + `<g class="node" id="${id}-flowchart-ghost-0" data-id="ghost"></g>`
  + '<g class="node"></g>'

let mode: FakeRenderMode = 'data-id'

/** @param next - how the stand-in answers renders from now on. */
export function useRenderMode(next: FakeRenderMode): void {
  mode = next
}

/** Restore the default answer and forget every recorded call. */
export function resetFakeMermaid(): void {
  mode = 'data-id'
  initialize.mockClear()
  render.mockClear()
}

/** Mermaid's configuration entry, recorded so a spec can assert the security settings. */
export const initialize: Mock<(config: Readonly<Record<string, unknown>>) => void> = vi.fn()

/** Mermaid's render entry, answering with SVG built from the generated source. */
export const render = vi.fn(async (id: string, text: string): Promise<{ readonly svg: string }> => {
  if (mode === 'refused') throw new Error('Parse error on line 2: unexpected token')
  // Mermaid's own refusals are not always Error instances.
  if (mode === 'non-error') throw 'Parse error on line 1'
  const drawn = text.split('\n')
    .map(line => NODE_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
  // Mermaid prefixes every drawn id with the render id it was handed.
  const nodes = drawn.map(([, nodeId, label], index) => {
    const drawnId = `id="${id}-flowchart-${nodeId}-${index}"`
    const identity = mode === 'id-only' ? drawnId : `${drawnId} data-id="${nodeId}"`
    const shape = mode === 'shapeless' && index === 0 ? '' : '<rect width="120" height="40"></rect>'
    return `<g class="node" ${identity}>${shape}<g class="label"><text>${label}</text></g></g>`
  })
  if (mode === 'unresolvable') nodes.push(unresolvable(id))
  return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg">${nodes.join('')}</svg>` }
})
