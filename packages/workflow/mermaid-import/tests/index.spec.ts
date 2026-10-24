import { describe, expect, it } from 'vitest'
import { parseDefinitionDocument, serializeDefinition, validateDefinition } from '@metaworkflow/workflow-definition'
import { parseMermaidFlowchart, toDefinition } from '../src/index.ts'

describe('@metaworkflow/workflow-mermaid-import', () => {
  it('exposes a parse and translate round trip that stores as canonical JSON', () => {
    const parsed = parseMermaidFlowchart(`flowchart TD
      Start[Fetch the invoice] --> Review{Review}
      Review -->|approved| Done[File it]`)
    if (!parsed.ok) throw new Error(`expected a parsed flowchart, got ${parsed.error.code}`)
    expect(parsed.warnings).toEqual([])
    const translated = toDefinition(parsed.graph)
    if (!translated.ok) throw new Error('expected a definition')
    expect(validateDefinition(translated.definition)).toEqual({ ok: true })
    expect(translated.mapping).toEqual({ Start: 'fetch-the-invoice', Review: 'review', Done: 'file-it' })
    const stored = serializeDefinition(translated.definition)
    const reread = parseDefinitionDocument(stored)
    expect(reread.ok).toBe(true)
    expect(stored).toBe(serializeDefinition(translated.definition))
  })

  it('reports a parse refusal with its code and line', () => {
    const parsed = parseMermaidFlowchart('flowchart TD\n  A --> B\n  subgraph later')
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: 'mermaid/unsupported-syntax',
        message: 'unsupported statement "subgraph"; the importer reads node statements, links, and comments only',
        line: 3,
      },
    })
  })
})
