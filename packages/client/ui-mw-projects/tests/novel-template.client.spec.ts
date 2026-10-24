/**
 * The shipped novel template: the document the dashboard's **Use the novel
 * template** action hands to `projects.importDefinition`, checked against the
 * authored JSON file and for the graph the dashboard's copy promises — a draft,
 * two parallel reviews with different tool selections, a Python gate, and the
 * bounded revision loop back to the draft.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOVEL_TEMPLATE_DOCUMENT } from '../src/client/templates/novel.ts'

/** One node of the template document, as the test reads it. */
interface TemplateNode {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly join: string
  readonly inputs: readonly {
    readonly name: string
    readonly source: { readonly kind: string; readonly nodeId?: string; readonly field?: string }
  }[]
  readonly config: {
    readonly kind: string
    readonly source?: string
    readonly instructions?: string
    readonly tools?: readonly string[]
    readonly memory?: string
    readonly outputSchema?: { readonly type?: string }
  }
}

/** One edge of the template document, as the test reads it. */
interface TemplateEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly mode: string
  readonly condition: { readonly op: string; readonly field?: string; readonly value?: unknown } | null
  readonly loop?: { readonly maxIterations: number }
}

/** The template document, as the test reads it. */
interface TemplateDocument {
  readonly version: number
  readonly nodes: readonly TemplateNode[]
  readonly edges: readonly TemplateEdge[]
}

/** The authored file beside the module that serializes it. */
const authored = readFileSync(new URL('../src/client/templates/novel.json', import.meta.url), 'utf8')

const document: TemplateDocument = JSON.parse(NOVEL_TEMPLATE_DOCUMENT) as TemplateDocument

/** One node by id, or the fixture that should have declared it. */
function node(id: string): TemplateNode {
  const found = document.nodes.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the template declares no node ${id}`)
  return found
}

/** One edge by id, or the fixture that should have declared it. */
function edge(id: string): TemplateEdge {
  const found = document.edges.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the template declares no edge ${id}`)
  return found
}

describe('the novel template document', () => {
  it('serializes the authored JSON file without dropping or reshaping a member', () => {
    expect(JSON.parse(authored)).toEqual(document)
    expect(document.version).toBe(1)
  })

  it('runs prepare, draft, both reviews, the gate, and publish', () => {
    expect(document.nodes.map(entry => entry.id)).toEqual([
      'prepare', 'draft', 'review-style', 'review-consistency', 'gate', 'publish',
    ])
    expect(document.nodes.map(entry => entry.kind)).toEqual([
      'python', 'agent', 'agent', 'agent', 'python', 'python',
    ])
    for (const entry of document.nodes) {
      expect(entry.config.kind).toBe(entry.kind)
      expect(entry.title.length).toBeGreaterThan(0)
    }
  })

  it('branches into the two reviews in parallel and joins them in the gate', () => {
    expect(edge('draft-review-style')).toMatchObject({ from: 'draft', to: 'review-style', condition: null })
    expect(edge('draft-review-consistency')).toMatchObject({ from: 'draft', to: 'review-consistency', condition: null })
    expect(edge('style-gate')).toMatchObject({ from: 'review-style', to: 'gate', condition: null })
    expect(edge('consistency-gate')).toMatchObject({ from: 'review-consistency', to: 'gate', condition: null })
    // The gate waits for both reviews instead of firing on the first one back.
    expect(node('gate').join).toBe('all')
    expect(node('gate').inputs.map(input => input.source)).toEqual([
      { kind: 'node', nodeId: 'review-style', field: 'passed' },
      { kind: 'node', nodeId: 'review-consistency', field: 'passed' },
    ])
  })

  it('publishes on a pass and loops back to the draft on a rejection, bounded at three revisions', () => {
    expect(edge('gate-publish')).toMatchObject({
      from: 'gate',
      to: 'publish',
      condition: { op: 'truthy', field: 'passed' },
    })
    expect(edge('gate-draft')).toMatchObject({
      from: 'gate',
      to: 'draft',
      condition: { op: 'eq', field: 'passed', value: false },
      loop: { maxIterations: 3 },
    })
    // A loop edge must be a multiple-mode edge, so its source keeps one mode.
    expect(edge('gate-draft').mode).toBe('multiple')
    expect(edge('gate-publish').mode).toBe(edge('gate-draft').mode)
    expect(document.edges.filter(candidate => candidate.loop !== undefined)).toHaveLength(1)
  })

  it('gives the two review nodes different tool selections', () => {
    expect(node('draft').config.tools).toEqual(['read', 'write'])
    expect(node('review-style').config.tools).toEqual(['read'])
    expect(node('review-consistency').config.tools).toEqual(['read', 'grep'])
    // The draft keeps its conversation so a revision round remembers the last one.
    expect(node('draft').config.memory).toBe('retained')
    expect(node('review-style').config.memory).toBe('fresh')
    expect(node('review-consistency').config.memory).toBe('fresh')
  })

  it('gives every agent node instructions and an object-rooted output schema', () => {
    for (const entry of document.nodes.filter(candidate => candidate.kind === 'agent')) {
      expect(entry.config.instructions?.length).toBeGreaterThan(0)
      expect(entry.config.outputSchema?.type).toBe('object')
      expect(entry.config.tools?.length).toBeGreaterThan(0)
    }
  })

  it('defines the entry function each Python node declares', () => {
    for (const entry of document.nodes.filter(candidate => candidate.kind === 'python')) {
      expect(entry.config.source).toContain(`def nodemain_${entry.id}(`)
    }
  })

  it('binds every node input to an upstream node, never to a run value the workbench cannot supply', () => {
    for (const entry of document.nodes) {
      for (const input of entry.inputs) {
        expect(input.name.length).toBeGreaterThan(0)
        expect(input.source.kind).toBe('node')
        expect(document.nodes.some(candidate => candidate.id === input.source.nodeId)).toBe(true)
      }
    }
  })
})
