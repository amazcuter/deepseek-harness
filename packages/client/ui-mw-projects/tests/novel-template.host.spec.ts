/**
 * The shipped novel template against the definition validator: the JSON the
 * dashboard hands to `projects.importDefinition` must parse and validate, and
 * the graph it describes must be the one the dashboard copy promises — one
 * entry, a parallel review pair, one loop edge bounded at three revisions.
 *
 * Host tier because the validator belongs to `@metaworkflow/workflow-definition`,
 * a Host package the Client bundle never reaches: the Client reads the same file
 * as data in `novel-template.client.spec.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDefinitionDocument } from '@metaworkflow/workflow-definition'
import type { WorkflowDefinition } from '@metaworkflow/workflow-definition'

const authored = readFileSync(
  new URL('../src/client/templates/novel.json', import.meta.url),
  'utf8',
)

const parsed = parseDefinitionDocument(authored)

/** The parsed definition, or the violations that reject the shipped template. */
function definition(): WorkflowDefinition {
  if (!parsed.ok) throw new Error(`the shipped template does not validate: ${JSON.stringify(parsed.violations)}`)
  return parsed.definition
}

describe('the shipped novel template definition', () => {
  it('parses and validates', () => {
    expect(parsed.ok).toBe(true)
  })

  it('is one executable graph with a single entry and a bounded revision loop', () => {
    const graph = definition()
    expect(graph.nodes.map(node => node.id)).toEqual([
      'prepare', 'draft', 'review-style', 'review-consistency', 'gate', 'publish',
    ])
    const loops = graph.edges.filter(edge => edge.loop !== undefined)
    expect(loops.map(edge => edge.id)).toEqual(['gate-draft'])
    expect(loops[0]?.loop?.maxIterations).toBe(3)
    expect(graph.edges.filter(edge => edge.to === 'prepare')).toHaveLength(0)
  })

  it('declares the tool selections the two review nodes use', () => {
    const tools = new Map(graphNodes().map(node => [node.id, node.config.kind === 'agent' ? [...node.config.tools] : []]))
    expect(Object.fromEntries(tools)).toEqual({
      'prepare': [],
      'draft': ['read', 'write'],
      'review-style': ['read'],
      'review-consistency': ['read', 'grep'],
      'gate': [],
      'publish': [],
    })
  })
})

/** The parsed definition's nodes; a separate accessor keeps the failure local. */
function graphNodes(): WorkflowDefinition['nodes'] {
  return definition().nodes
}
