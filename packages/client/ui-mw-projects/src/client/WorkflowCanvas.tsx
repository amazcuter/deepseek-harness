/**
 * The workflow canvas: one stored definition drawn as a Mermaid flowchart.
 *
 * The diagram is Mermaid's DOM, not React's: this component asks Mermaid for the
 * SVG, inserts it into its own container, and then decorates the drawn `g.node`
 * groups with the definition node each one represents, the activation status
 * that colors it, and the node the inspector shows. React never re-renders that
 * subtree — a re-render would replace Mermaid's output with a foreign tree — so
 * the decoration runs as an effect keyed on the facts it paints and the click
 * handling is delegated from the stable container.
 *
 * A refused render leaves the panel readable instead of blank: the reason and
 * the exact Mermaid source the canvas generated stay on screen, because that
 * source is the only way to tell an unsupported definition from a Mermaid fault.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@metaworkflow/client-ui-primitives'
import type { TranslateNS } from '@metaworkflow/client-ui-slots'
import type { ProjectActivationView } from '@metaworkflow/api-workspace-controller/types'
import type { DefinitionGraph } from './definition-graph.ts'
import { flowchartSource, type FlowchartSource } from './mermaid-graph.ts'
import { renderFlowchart } from './mermaid-render.ts'
import { nodePaint } from './node-paint.ts'
import css from './WorkflowCanvas.module.css'

/** The bound translator this component receives from the workbench panel. */
type Translate = TranslateNS<'mw.projects'>

/** Zoom steps the canvas offers, clamped to this range. */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2
const ZOOM_STEP = 0.25

/** What the canvas currently shows in place of the diagram. */
type RenderState =
  | { readonly status: 'rendering' }
  /** `id` is the render id Mermaid prefixed every drawn element id with. */
  | { readonly status: 'ready'; readonly svg: string; readonly id: string }
  | { readonly status: 'refused'; readonly message: string }

/** Props of the workflow canvas. */
export interface WorkflowCanvasProps {
  /** Panel translator. */
  readonly t: Translate
  /** The definition graph to draw. */
  readonly graph: DefinitionGraph
  /** Activations of the run the workbench shows; their statuses color the nodes. */
  readonly activations: readonly ProjectActivationView[]
  /** Definition node the inspector shows, or `null` when none is selected. */
  readonly selectedNodeId: string | null
  /** Select one node from the diagram. */
  readonly selectNode: (nodeId: string) => void
}

/**
 * @param activations - activations of the run the workbench shows.
 * @param nodeId - definition node to read.
 * @returns the status of that node's newest activation, or `idle` when the run
 * never reached it.
 */
function latestStatus(activations: readonly ProjectActivationView[], nodeId: string): string {
  return activations.filter(activation => activation.nodeId === nodeId).at(-1)?.status ?? 'idle'
}

/**
 * @param element - one `g.node` group of the rendered diagram.
 * @param renderId - id the canvas handed Mermaid for this render.
 * @returns the Mermaid node id that group was drawn with: its `data-id` when the
 * version sets one, otherwise the tail of the `"<render>/flowchart-<node>-<n>"`
 * id it builds. Generated ids never contain `-`, so the trailing index is the
 * only suffix to strip.
 */
function mermaidIdOf(element: Element, renderId: string): string | undefined {
  const dataId = element.getAttribute('data-id')
  if (dataId !== null && dataId !== '') return dataId
  const drawn = element.getAttribute('id')
  const prefix = `${renderId}-flowchart-`
  if (drawn === null || !drawn.startsWith(prefix)) return undefined
  return drawn.slice(prefix.length).replace(/-\d+$/, '')
}

/**
 * @param element - one `g.node` group.
 * @returns the shape Mermaid drew the node body with, when it drew one.
 */
function shapeOf(element: Element): SVGElement | undefined {
  const shape = element.querySelector('rect, polygon, path, circle, ellipse')
  return shape instanceof SVGElement ? shape : undefined
}

/**
 * Draw one definition as a flowchart, with the run's statuses painted on it.
 * @param props - the graph, the run's activations, the selection, and the selector.
 * @returns the canvas element tree, including the zoom controls and the
 * readable failure face.
 */
export function WorkflowCanvas({
  t, graph, activations, selectedNodeId, selectNode,
}: WorkflowCanvasProps): ReactNode {
  const source = useMemo<FlowchartSource>(() => flowchartSource(graph), [graph])
  const [state, setState] = useState<RenderState>({ status: 'rendering' })
  const [attempt, setAttempt] = useState(0)
  const [zoom, setZoom] = useState(1)
  const host = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)

  useEffect(() => {
    let live = true
    setState({ status: 'rendering' })
    sequence.current += 1
    const id = `mwf-flowchart-${sequence.current}`
    void renderFlowchart(id, source.text).then((result) => {
      if (!live) return
      setState(result.ok
        ? { status: 'ready', svg: result.svg, id }
        : { status: 'refused', message: result.message })
    })
    return () => { live = false }
  }, [source, attempt])

  // Mermaid's SVG is a foreign subtree: assigning the markup is the handover,
  // and decorating it below is the only way its drawn nodes learn their identity.
  useEffect(() => {
    /* v8 ignore next -- this effect runs only while the container ref is attached. */
    if (host.current === null) return
    host.current.innerHTML = state.status === 'ready' ? state.svg : ''
  }, [state])

  useEffect(() => {
    const container = host.current
    if (container === null || state.status !== 'ready') return
    for (const element of container.querySelectorAll('g.node')) {
      const mermaidId = mermaidIdOf(element, state.id)
      const node = mermaidId === undefined ? undefined : source.nodeIds.get(mermaidId)
      if (node === undefined) continue
      const status = latestStatus(activations, node.id)
      const selected = node.id === selectedNodeId
      element.setAttribute('data-node-id', node.id)
      element.setAttribute('data-status', status)
      element.setAttribute('role', 'button')
      element.setAttribute('tabindex', '0')
      element.setAttribute('aria-pressed', selected ? 'true' : 'false')
      element.setAttribute('aria-label', t('workbench.canvas.selectNode', { name: node.title }))
      const shape = shapeOf(element)
      if (shape === undefined) continue
      const paint = nodePaint(status, selected)
      shape.style.setProperty('fill', paint.fill)
      shape.style.setProperty('stroke', paint.stroke)
      shape.style.setProperty('stroke-width', String(paint.strokeWidth))
    }
  }, [state, source, activations, selectedNodeId, t])

  useEffect(() => {
    const container = host.current
    /* v8 ignore next -- this effect runs only while the container ref is attached. */
    if (container === null) return
    // Only a group the decoration pass bound carries an id, so Mermaid's own
    // cluster and edge-label groups stay inert.
    const activate = (target: EventTarget | null): void => {
      const drawn = target instanceof Element ? target.closest('g.node') : null
      if (drawn === null) return
      const nodeId = drawn.getAttribute('data-node-id')
      if (nodeId !== null) selectNode(nodeId)
    }
    const onClick = (event: MouseEvent): void => { activate(event.target) }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      activate(event.target)
      event.preventDefault()
    }
    container.addEventListener('click', onClick)
    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('click', onClick)
      container.removeEventListener('keydown', onKeyDown)
    }
  }, [selectNode])

  const zoomBy = (delta: number): void => {
    setZoom(current => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta)))
  }

  return (
    <>
      <div className={css.controls} role="group" aria-label={t('workbench.canvas.zoomGroup')}>
        <Button
          variant="outline"
          size="sm"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => { zoomBy(-ZOOM_STEP) }}
        >
          {t('workbench.canvas.zoomOut')}
        </Button>
        <span className={css.zoomValue} data-zoom={zoom}>
          {t('workbench.canvas.zoom', { percent: Math.round(zoom * 100) })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => { zoomBy(ZOOM_STEP) }}
        >
          {t('workbench.canvas.zoomIn')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={zoom === 1}
          onClick={() => { setZoom(1) }}
        >
          {t('workbench.canvas.zoomReset')}
        </Button>
      </div>
      <div className={css.scroll}>
        <div className={css.scale} style={{ transform: `scale(${zoom})` }} data-canvas-scale={zoom}>
          <div
            ref={host}
            className={css.diagram}
            role="group"
            aria-label={t('workbench.canvas.figure')}
            aria-busy={state.status === 'rendering'}
            data-canvas=""
          />
        </div>
      </div>
      {state.status === 'rendering' && (
        <p className={css.note}>{t('workbench.canvas.rendering')}</p>
      )}
      {state.status === 'refused' && (
        <div className={css.refused} role="alert">
          <p className={css.refusedTitle}>{t('workbench.canvas.renderedFailed')}</p>
          <p className={css.note}>{state.message}</p>
          <p className={css.note}>{t('workbench.canvas.sourceHint')}</p>
          <pre className={css.source}>{source.text}</pre>
          <Button variant="outline" size="sm" onClick={() => { setAttempt(count => count + 1) }}>
            {t('error.retry')}
          </Button>
        </div>
      )}
    </>
  )
}
