// @vitest-environment jsdom
/**
 * The workflow canvas: the generated flowchart source it hands Mermaid, the
 * decoration that turns Mermaid's drawn groups into selectable nodes painted by
 * activation status, the zoom controls, and the readable face it keeps when
 * Mermaid refuses the source.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectActivationView } from '@metaworkflow/api-workspace-controller/types'
import { zh } from '../src/client/locales.ts'
import type { WorkbenchPageProps } from '../src/client/WorkbenchPage.tsx'
import { WorkflowCanvas, type WorkflowCanvasProps } from '../src/client/WorkflowCanvas.tsx'
import { initialize, render as renderSvg, resetFakeMermaid, useRenderMode } from './support/fake-mermaid.ts'

vi.mock('mermaid', async () => ({ default: await import('./support/fake-mermaid.ts') }))

afterEach(cleanup)
beforeEach(() => { resetFakeMermaid() })

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): WorkbenchPageProps['t'] => ((key: keyof typeof zh, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as WorkbenchPageProps['t']

/** One localized template with its parameters filled in. */
const copy = (key: keyof typeof zh, params: Record<string, unknown> = {}): string =>
  translate(zh)(key, params)

/** The graph every case draws: fetch, review, and the link between them. */
const GRAPH: WorkflowCanvasProps['graph'] = {
  nodes: [
    { id: 'fetch', title: '抓取' },
    { id: 'review', title: '评审' },
  ],
  edges: [{ from: 'fetch', to: 'review', label: 'ok = true' }],
}

/** One activation of the run the canvas paints. */
function activation(nodeId: string, status: string): ProjectActivationView {
  return { activationId: `a-${nodeId}`, nodeId, iteration: 0, status }
}

function bench(
  activations: readonly ProjectActivationView[] = [],
  selectedNodeId: string | null = null,
) {
  const selectNode = vi.fn<(nodeId: string) => void>()
  const props: WorkflowCanvasProps = {
    t: translate(zh),
    graph: GRAPH,
    activations,
    selectedNodeId,
    selectNode,
  }
  const view = render(<WorkflowCanvas {...props} />)
  return { selectNode, ...view }
}

/** The drawn node group of one definition node, once the diagram is on screen. */
async function drawnNode(nodeId: string): Promise<SVGElement> {
  const selector = `[data-node-id="${nodeId}"]`
  await waitFor(() => { expect(document.querySelector(selector)).not.toBeNull() })
  const element = document.querySelector<SVGElement>(selector)
  if (element === null) throw new Error(`no drawn node ${nodeId}`)
  return element
}

describe('WorkflowCanvas rendering', () => {
  it('hands Mermaid the generated source under the strict security settings', async () => {
    bench()
    await drawnNode('fetch')
    expect(initialize).toHaveBeenCalledOnce()
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      flowchart: expect.objectContaining({ htmlLabels: false }) as Readonly<Record<string, unknown>>,
    }))
    const [id, source] = renderSvg.mock.calls.at(-1) ?? []
    expect(id).toMatch(/^mwf-flowchart-\d+$/)
    expect(source).toContain('flowchart TD')
    expect(source).toContain('fetch -->|"ok = true"| review')
  })

  it('resolves the diagram theme from the tokens the document currently paints', async () => {
    const body = document.body.style
    body.setProperty('--dsw-alias-bg-layer-2', 'rgb(1, 2, 3)')
    body.setProperty('--dsw-alias-label-primary', 'rgb(4, 5, 6)')
    bench()
    await drawnNode('fetch')
    body.removeProperty('--dsw-alias-bg-layer-2')
    body.removeProperty('--dsw-alias-label-primary')
    const [config] = initialize.mock.calls.at(-1) ?? []
    expect(config).toMatchObject({
      themeVariables: {
        primaryColor: 'rgb(1, 2, 3)',
        primaryTextColor: 'rgb(4, 5, 6)',
        // A token the stylesheet does not define keeps its own fallback.
        tertiaryColor: '#f7f8fa',
      },
    })
  })

  it('says the diagram is being drawn before the render settles', () => {
    bench()
    expect(screen.getByText(zh['workbench.canvas.rendering'])).toBeTruthy()
    expect(screen.getByRole('group', { name: zh['workbench.canvas.figure'] }).getAttribute('aria-busy'))
      .toBe('true')
  })

  it('marks the diagram busy only until the render settles', async () => {
    bench()
    await drawnNode('fetch')
    await waitFor(() => {
      expect(screen.getByRole('group', { name: zh['workbench.canvas.figure'] }).getAttribute('aria-busy'))
        .toBe('false')
    })
    expect(screen.queryByText(zh['workbench.canvas.rendering'])).toBeNull()
  })

  it('publishes nothing when the panel unmounts before Mermaid answers', async () => {
    const onError = vi.spyOn(console, 'error')
    const view = bench()
    view.unmount()
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
    onError.mockRestore()
  })
})

describe('WorkflowCanvas node decoration', () => {
  it('paints each drawn node by its activation status and reads the inspector selection', async () => {
    bench([activation('fetch', 'succeeded'), activation('review', 'waiting')], 'fetch')
    const fetch = await drawnNode('fetch')
    const review = await drawnNode('review')
    expect(fetch.getAttribute('data-status')).toBe('succeeded')
    expect(review.getAttribute('data-status')).toBe('waiting')
    expect(fetch.getAttribute('aria-pressed')).toBe('true')
    expect(review.getAttribute('aria-pressed')).toBe('false')
    expect(fetch.getAttribute('role')).toBe('button')
    expect(fetch.getAttribute('tabindex')).toBe('0')
    expect(fetch.getAttribute('aria-label')).toBe(copy('workbench.canvas.selectNode', { name: '抓取' }))
    const shape = fetch.querySelector('rect')
    expect(shape?.getAttribute('style')).toContain('fill: var(--dsw-alias-state-success-tertiary)')
    expect(shape?.getAttribute('style')).toContain('stroke: var(--dsw-alias-brand-primary)')
    expect(shape?.getAttribute('style')).toContain('stroke-width: 2.5')
    expect(review.querySelector('rect')?.getAttribute('style'))
      .toContain('stroke: var(--dsw-alias-state-warn-primary)')
  })

  it('leaves a node no activation reached uncoloured', async () => {
    bench()
    const fetch = await drawnNode('fetch')
    expect(fetch.getAttribute('data-status')).toBe('idle')
    expect(fetch.querySelector('rect')?.getAttribute('style'))
      .toContain('fill: var(--dsw-alias-bg-layer-2)')
  })

  it('resolves the drawn id the way the diagram was generated', async () => {
    useRenderMode('id-only')
    bench()
    // The stand-in omits data-id, so the canvas reads the group id Mermaid derives.
    const fetch = await drawnNode('fetch')
    expect(fetch.getAttribute('aria-label')).toBe(copy('workbench.canvas.selectNode', { name: '抓取' }))
  })

  it('skips a drawn group that names no definition node', async () => {
    useRenderMode('unresolvable')
    const b = bench()
    const fetch = await drawnNode('fetch')
    expect(fetch.getAttribute('data-status')).toBe('idle')
    expect(document.querySelector('[data-node-id="ghost"]')).toBeNull()
    expect(document.querySelector('[id$="-cluster-0"]')?.getAttribute('role')).toBeNull()
    // A group Mermaid drew without any identity selects nothing.
    fireEvent.click(document.querySelector('g.node:not([data-node-id])') as Element)
    expect(b.selectNode).not.toHaveBeenCalled()
  })

  it('keeps a node selectable even when Mermaid drew no shape for it', async () => {
    useRenderMode('shapeless')
    const b = bench()
    const fetch = await drawnNode('fetch')
    expect(fetch.querySelector('rect')).toBeNull()
    fireEvent.click(fetch)
    expect(b.selectNode).toHaveBeenCalledExactlyOnceWith('fetch')
  })
})

describe('WorkflowCanvas selection', () => {
  it('selects a node from a click on it or on a shape inside it', async () => {
    const b = bench()
    const review = await drawnNode('review')
    fireEvent.click(review.querySelector('text') as Element)
    expect(b.selectNode).toHaveBeenCalledExactlyOnceWith('review')
  })

  it('selects nothing when the click misses every node', async () => {
    const b = bench()
    const fetch = await drawnNode('fetch')
    fireEvent.click(screen.getByRole('group', { name: zh['workbench.canvas.figure'] }))
    // A click landing on a text node has no element to resolve.
    const label = fetch.querySelector('text')?.firstChild
    if (label !== null && label !== undefined) fireEvent.click(label)
    expect(b.selectNode).not.toHaveBeenCalled()
  })

  it('selects a node from Enter or Space on it', async () => {
    const b = bench()
    const fetch = await drawnNode('fetch')
    fireEvent.keyDown(fetch, { key: 'Enter' })
    fireEvent.keyDown(fetch, { key: ' ' })
    expect(b.selectNode).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(fetch, { key: 'Tab' })
    expect(b.selectNode).toHaveBeenCalledTimes(2)
  })
})

describe('WorkflowCanvas zoom', () => {
  /** The scale the canvas currently draws at. */
  const scale = (): string | null | undefined =>
    document.querySelector('[data-canvas-scale]')?.getAttribute('data-canvas-scale')

  it('zooms in, out, and back to the initial scale', async () => {
    bench()
    await drawnNode('fetch')
    expect(scale()).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.canvas.zoomIn'] }))
    expect(scale()).toBe('1.25')
    expect(screen.getByText(copy('workbench.canvas.zoom', { percent: 125 }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.canvas.zoomReset'] }))
    expect(scale()).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.canvas.zoomOut'] }))
    expect(scale()).toBe('0.75')
  })

  it('clamps the zoom and disables the control that would pass the bound', async () => {
    bench()
    await drawnNode('fetch')
    const zoomIn = screen.getByRole('button', { name: zh['workbench.canvas.zoomIn'] })
    const zoomOut = screen.getByRole('button', { name: zh['workbench.canvas.zoomOut'] })
    const reset = screen.getByRole('button', { name: zh['workbench.canvas.zoomReset'] })
    expect(reset).toHaveProperty('disabled', true)
    for (let step = 0; step < 6; step += 1) fireEvent.click(zoomIn)
    expect(scale()).toBe('2')
    expect(zoomIn).toHaveProperty('disabled', true)
    expect(reset).toHaveProperty('disabled', false)
    for (let step = 0; step < 8; step += 1) fireEvent.click(zoomOut)
    expect(scale()).toBe('0.5')
    expect(zoomOut).toHaveProperty('disabled', true)
  })
})

describe('WorkflowCanvas refusal', () => {
  it('keeps the reason, the generated source, and a retry on screen', async () => {
    useRenderMode('refused')
    bench()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(zh['workbench.canvas.renderedFailed'])
    expect(alert.textContent).toContain('Parse error on line 2: unexpected token')
    expect(alert.textContent).toContain(zh['workbench.canvas.sourceHint'])
    expect(alert.querySelector('pre')?.textContent).toContain('flowchart TD')
    expect(screen.getByRole('group', { name: zh['workbench.canvas.figure'] }).textContent).toBe('')
  })

  it('reports a refusal Mermaid threw as a bare value', async () => {
    useRenderMode('non-error')
    bench()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Parse error on line 1')
  })

  it('draws the diagram again on retry', async () => {
    useRenderMode('refused')
    bench()
    fireEvent.click(await screen.findByRole('button', { name: zh['error.retry'] }))
    await waitFor(() => { expect(renderSvg).toHaveBeenCalledTimes(2) })
    useRenderMode('data-id')
    fireEvent.click(await screen.findByRole('button', { name: zh['error.retry'] }))
    await drawnNode('fetch')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
