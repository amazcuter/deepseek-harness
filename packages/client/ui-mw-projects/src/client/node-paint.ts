/**
 * How the canvas paints one drawn node.
 *
 * A node's colour states two facts at once: which activation status the newest
 * run reported for it, and whether the inspector currently shows it. Both are
 * painted as inline styles on the shape Mermaid drew, because the generated SVG
 * carries its own theme sheet — a stylesheet rule of ours cannot reliably win
 * over it, while an inline declaration can.
 *
 * Colors are `--dsw-*` token references, so the diagram follows the active
 * light or dark theme instead of pinning literal colors.
 */

/** Final shape painting for one drawn node. */
export interface NodePaint {
  readonly fill: string
  readonly stroke: string
  /** Stroke width in SVG user units; a selected node is drawn heavier. */
  readonly strokeWidth: number
}

/** Painting of a node no run has reached yet; also the fallback for an unknown status. */
const IDLE_PAINT: readonly [string, string] = [
  'var(--dsw-alias-bg-layer-2)',
  'var(--dsw-alias-border-l4)',
]

/** Fill and stroke per activation status. */
const STATUS_PAINT: Readonly<Record<string, readonly [string, string]>> = {
  idle: IDLE_PAINT,
  pending: ['var(--dsw-alias-bg-layer-2)', 'var(--dsw-alias-state-idle-primary)'],
  running: ['var(--dsw-alias-state-business-tertiary)', 'var(--dsw-alias-state-business-primary)'],
  waiting: ['var(--dsw-alias-state-warn-tertiary)', 'var(--dsw-alias-state-warn-primary)'],
  succeeded: ['var(--dsw-alias-state-success-tertiary)', 'var(--dsw-alias-state-success-primary)'],
  failed: ['var(--dsw-alias-file-diff-deleted-bg)', 'var(--dsw-alias-state-error-primary)'],
  canceled: ['var(--dsw-alias-bg-layer-3)', 'var(--dsw-alias-state-idle-primary)'],
}

/** Stroke of the node the inspector shows. */
const SELECTED_STROKE = 'var(--dsw-alias-brand-primary)'

/** Stroke width of an unselected node. */
const BASE_STROKE_WIDTH = 1

/** Stroke width of the node the inspector shows. */
const SELECTED_STROKE_WIDTH = 2.5

/**
 * @param status - activation status of the node's newest activation, or `idle`
 * when the node has none.
 * @param selected - whether the inspector shows this node.
 * @returns the fill, stroke, and stroke width the node's shape is painted with.
 */
export function nodePaint(status: string, selected: boolean): NodePaint {
  const [fill, statusStroke] = STATUS_PAINT[status] ?? IDLE_PAINT
  return {
    fill,
    stroke: selected ? SELECTED_STROKE : statusStroke,
    strokeWidth: selected ? SELECTED_STROKE_WIDTH : BASE_STROKE_WIDTH,
  }
}
