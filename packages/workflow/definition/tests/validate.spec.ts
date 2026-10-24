import { describe, expect, it } from 'vitest'
import type { DefinitionViolation, DefinitionViolationCode } from '../src/types.ts'
import { validateDefinition } from '../src/validate.ts'
import {
  agentConfig,
  agentNode,
  documentOf,
  edge,
  objectSchema,
  pythonNode,
  rawAgentConfig,
  validDefinition,
} from './support/definitions.ts'

/** One non-matchable document case. */
interface InvalidCase {
  /** Case name, shown by the runner. */
  readonly name: string
  /** Candidate document. */
  readonly document: unknown
  /** Violation code the case must produce. */
  readonly code: DefinitionViolationCode
  /** Exact document path the violation must carry. */
  readonly path?: string
  /** Whether this must be the only violation reported. */
  readonly only?: boolean
}

/** Codes reported for one document. */
function codesOf(document: unknown): DefinitionViolationCode[] {
  const result = validateDefinition(document)
  return result.ok ? [] : result.violations.map(violation => violation.code)
}

/** One violation of a document, when present. */
function findViolation(document: unknown, code: DefinitionViolationCode): DefinitionViolation | undefined {
  const result = validateDefinition(document)
  return result.ok ? undefined : result.violations.find(violation => violation.code === code)
}

/** A nested predicate tree of the given depth, used for the depth cap. */
function nestedPredicate(depth: number): Record<string, unknown> {
  let predicate: Record<string, unknown> = { op: 'exists', field: 'value' }
  for (let index = 0; index < depth; index += 1) predicate = { op: 'not', arg: predicate }
  return predicate
}

const VALID: readonly { readonly name: string; readonly document: unknown }[] = [
  { name: 'the rich fixture', document: validDefinition() },
  { name: 'a single node with no edges', document: documentOf([pythonNode('solo')], []) },
  {
    name: 'two exclusive conditional edges without a fallback',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a-to-b', 'a', 'b', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 1 } }),
        edge('a-to-c', 'a', 'c', { mode: 'exclusive', condition: { op: 'lte', field: 'score', value: 1 } }),
      ],
    ),
  },
  {
    name: 'a fallback explicitly declined',
    document: documentOf(
      [pythonNode('a'), pythonNode('b')],
      [edge('a-to-b', 'a', 'b', { mode: 'exclusive', condition: { op: 'exists', field: 'ok' }, fallback: false })],
    ),
  },
  {
    name: 'a schema using the shared subset',
    document: documentOf([
      agentNode('ask', {
        config: agentConfig({
          type: 'object',
          description: 'A review outcome',
          properties: {
            passed: { type: 'boolean', const: true },
            level: { type: 'string', enum: ['low', 'high'] },
            notes: { type: 'array' },
            scored: { type: 'array', items: { type: 'number' } },
            choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            annotated: { type: 'object', title: 'Free form', default: { any: 1 } },
          },
          required: ['passed'],
          additionalProperties: true,
        }),
      }),
    ], []),
  },
  {
    name: 'every predicate op in one condition',
    document: documentOf(
      [pythonNode('a'), pythonNode('b')],
      [edge('a-to-b', 'a', 'b', {
        condition: {
          op: 'and',
          args: [
            { op: 'or', args: [{ op: 'eq', field: 's', value: 'x' }, { op: 'not', arg: { op: 'ne', field: 'n', value: 2 } }] },
            { op: 'gte', field: 'n', value: 0 },
            { op: 'lt', field: 'n', value: 10 },
            { op: 'in', field: 's', value: ['x', 'y'] },
            { op: 'not-in', field: 's', value: ['z'] },
            { op: 'exists', field: 'deep.value' },
            { op: 'truthy', field: 'flag' },
          ],
        },
      })],
    ),
  },
  {
    name: 'input provenance from every source kind',
    document: documentOf(
      [
        pythonNode('source', { inputs: [{ name: 'seed', source: { kind: 'run', key: 'seed' } }] }),
        pythonNode('sink', {
          inputs: [
            { name: 'value', source: { kind: 'node', nodeId: 'source', field: 'value' } },
            { name: 'file', source: { kind: 'artifact', name: 'report' } },
          ],
        }),
      ],
      [edge('source-to-sink', 'source', 'sink')],
    ),
  },
]

const INVALID: readonly InvalidCase[] = [
  { name: 'the document is an array', document: [], code: 'definition/document-invalid', path: '', only: true },
  { name: 'the version is absent', document: { nodes: [], edges: [] }, code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is a string', document: documentOf([], [], { version: '1' }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is an array', document: documentOf([], [], { version: [] }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is an object', document: documentOf([], [], { version: {} }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is null', document: documentOf([], [], { version: null }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is a boolean', document: documentOf([], [], { version: true }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'the version is not a JSON value', document: documentOf([], [], { version: () => 1 }), code: 'definition/version-unsupported', path: 'version' },
  { name: 'nodes is not an array', document: { version: 1, nodes: {}, edges: [] }, code: 'definition/nodes-invalid', path: 'nodes' },
  { name: 'edges is not an array', document: { version: 1, nodes: [], edges: {} }, code: 'definition/edges-invalid', path: 'edges' },
  { name: 'a node is not an object', document: documentOf(['x'], []), code: 'definition/node-invalid', path: 'nodes[0]' },
  { name: 'a node id is not a string', document: documentOf([pythonNode('ok', { id: 7 })], []), code: 'definition/node-id-invalid', path: 'nodes[0].id' },
  { name: 'a node id has a bad pattern', document: documentOf([pythonNode('ok', { id: 'Bad' })], []), code: 'definition/node-id-invalid', path: 'nodes[0].id' },
  { name: 'a node id starts with a digit', document: documentOf([pythonNode('ok', { id: '1st' })], []), code: 'definition/node-id-invalid', path: 'nodes[0].id' },
  {
    name: 'two nodes share an id',
    document: documentOf([pythonNode('dup'), pythonNode('dup')], []),
    code: 'definition/duplicate-node',
    path: 'nodes[1].id',
    only: true,
  },
  { name: 'a node kind is unknown', document: documentOf([pythonNode('ok', { kind: 'shell' })], []), code: 'definition/node-kind-invalid', path: 'nodes[0].kind' },
  { name: 'a node title is whitespace', document: documentOf([pythonNode('ok', { title: '   ' })], []), code: 'definition/node-title-empty', path: 'nodes[0].title' },
  { name: 'a node title is not a string', document: documentOf([pythonNode('ok', { title: 3 })], []), code: 'definition/node-title-empty', path: 'nodes[0].title' },
  { name: 'a node join is unknown', document: documentOf([pythonNode('ok', { join: 'any' })], []), code: 'definition/node-join-invalid', path: 'nodes[0].join' },
  { name: 'a node config is not an object', document: documentOf([pythonNode('ok', { config: 'python' })], []), code: 'definition/node-config-invalid', path: 'nodes[0].config' },
  {
    name: 'a node config kind differs from the node kind',
    document: documentOf([pythonNode('ok', { config: { kind: 'agent' } })], []),
    code: 'definition/node-config-kind-mismatch',
    path: 'nodes[0].config.kind',
  },
  {
    name: 'python source is empty',
    document: documentOf([pythonNode('ok', { config: { kind: 'python', source: '  ' } })], []),
    code: 'definition/python-source-empty',
    path: 'nodes[0].config.source',
  },
  {
    name: 'python source lacks the entry function',
    document: documentOf([pythonNode('ok', { config: { kind: 'python', source: 'def other(x):\n    return x\n' } })], []),
    code: 'definition/python-entry-missing',
    path: 'nodes[0].config.source',
  },
  {
    name: 'agent instructions are empty',
    document: documentOf([agentNode('ask', { config: { ...agentConfig(), instructions: ' ' } })], []),
    code: 'definition/agent-instructions-empty',
    path: 'nodes[0].config.instructions',
  },
  {
    name: 'agent memory is unknown',
    document: documentOf([agentNode('ask', { config: { ...agentConfig(), memory: 'session' } })], []),
    code: 'definition/agent-memory-invalid',
    path: 'nodes[0].config.memory',
  },
  {
    name: 'agent tools are not an array',
    document: documentOf([agentNode('ask', { config: { ...agentConfig(), tools: 'read' } })], []),
    code: 'definition/agent-tools-invalid',
    path: 'nodes[0].config.tools',
  },
  {
    name: 'an agent tool name is empty',
    document: documentOf([agentNode('ask', { config: { ...agentConfig(), tools: ['read', ''] } })], []),
    code: 'definition/agent-tools-invalid',
    path: 'nodes[0].config.tools[1]',
  },
  {
    name: 'an agent tool name is duplicated',
    document: documentOf([agentNode('ask', { config: { ...agentConfig(), tools: ['read', 'read'] } })], []),
    code: 'definition/agent-tools-invalid',
    path: 'nodes[0].config.tools[1]',
  },
  {
    name: 'an agent node has no output schema',
    document: documentOf([agentNode('ask', {
      config: { kind: 'agent', instructions: 'x', tools: [], memory: 'fresh' },
    })], []),
    code: 'definition/schema-invalid',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'an output schema is not an object',
    document: documentOf([agentNode('ask', { config: rawAgentConfig('object') })], []),
    code: 'definition/schema-invalid',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'an output schema root is not an object',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'string' }) })], []),
    code: 'definition/schema-root-not-object',
    path: 'nodes[0].config.outputSchema.type',
    only: true,
  },
  {
    name: 'an output schema is annotation-only',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ description: 'unconstrained' }) })], []),
    code: 'definition/schema-root-not-object',
    path: 'nodes[0].config.outputSchema.type',
    only: true,
  },
  {
    name: 'a schema keyword is unsupported',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'object', $ref: '#/x' }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a schema type is unknown',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'union' }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a schema description is not a string',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'object', description: 7 }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a schema enum is empty',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { level: { type: 'string', enum: [] } } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a schema enum member is not a scalar',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { level: { type: 'string', enum: [{ a: 1 }] } } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'additionalProperties is not a boolean',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', additionalProperties: {} }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'schema properties is not an object',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'object', properties: [] }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a nested property schema is invalid',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { value: { type: 'nope' } } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'schema required is not an array',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'object', required: 'ok' }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a required entry is empty',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { ok: { type: 'boolean' } }, required: [''] }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a required entry names an undeclared property',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['missing'] }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'required is declared without properties',
    document: documentOf([agentNode('ask', { config: rawAgentConfig({ type: 'object', required: ['ok'] }) })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'an object schema declares items',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', items: { type: 'string' } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a non-object schema declares properties',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'string', properties: { a: { type: 'string' } } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a non-object schema declares required',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'string', required: ['a'] }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'a non-array schema declares items',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'string', items: { type: 'string' } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'an array items schema is invalid',
    document: documentOf([agentNode('ask', {
      config: rawAgentConfig({ type: 'object', properties: { notes: { type: 'array', items: { type: 'nope' } } } }),
    })], []),
    code: 'definition/schema-unsupported',
    path: 'nodes[0].config.outputSchema',
  },
  {
    name: 'node inputs are not an array',
    document: documentOf([pythonNode('ok', { inputs: {} })], []),
    code: 'definition/node-inputs-invalid',
    path: 'nodes[0].inputs',
  },
  {
    name: 'an input binding is not an object',
    document: documentOf([pythonNode('ok', { inputs: ['seed'] })], []),
    code: 'definition/node-inputs-invalid',
    path: 'nodes[0].inputs[0]',
  },
  {
    name: 'an input name is empty',
    document: documentOf([pythonNode('ok', { inputs: [{ name: ' ', source: { kind: 'run', key: 'seed' } }] })], []),
    code: 'definition/input-name-invalid',
    path: 'nodes[0].inputs[0].name',
  },
  {
    name: 'an input name is duplicated',
    document: documentOf([pythonNode('ok', {
      inputs: [
        { name: 'seed', source: { kind: 'run', key: 'seed' } },
        { name: 'seed', source: { kind: 'run', key: 'other' } },
      ],
    })], []),
    code: 'definition/duplicate-input',
    path: 'nodes[0].inputs[1].name',
  },
  {
    name: 'an input source is not an object',
    document: documentOf([pythonNode('ok', { inputs: [{ name: 'seed', source: 'run' }] })], []),
    code: 'definition/input-source-invalid',
    path: 'nodes[0].inputs[0].source',
  },
  {
    name: 'a node input source names no node',
    document: documentOf([pythonNode('ok', {
      inputs: [{ name: 'value', source: { kind: 'node', nodeId: '', field: 'value' } }],
    })], []),
    code: 'definition/input-source-invalid',
    path: 'nodes[0].inputs[0].source.nodeId',
  },
  {
    name: 'a node input field is not a path',
    document: documentOf([pythonNode('ok', {
      inputs: [{ name: 'value', source: { kind: 'node', nodeId: 'ok', field: 'a..b' } }],
    })], []),
    code: 'definition/input-field-invalid',
    path: 'nodes[0].inputs[0].source.field',
  },
  {
    name: 'a run input key is empty',
    document: documentOf([pythonNode('ok', { inputs: [{ name: 'seed', source: { kind: 'run', key: ' ' } }] })], []),
    code: 'definition/run-key-empty',
    path: 'nodes[0].inputs[0].source.key',
  },
  {
    name: 'an artifact name is empty',
    document: documentOf([pythonNode('ok', { inputs: [{ name: 'seed', source: { kind: 'artifact', name: '' } }] })], []),
    code: 'definition/artifact-name-empty',
    path: 'nodes[0].inputs[0].source.name',
  },
  {
    name: 'an input source kind is unknown',
    document: documentOf([pythonNode('ok', { inputs: [{ name: 'seed', source: { kind: 'env', key: 'HOME' } }] })], []),
    code: 'definition/input-source-invalid',
    path: 'nodes[0].inputs[0].source.kind',
  },
  {
    name: 'a node input source is not an ancestor',
    document: documentOf(
      [
        pythonNode('a'),
        pythonNode('b', { inputs: [{ name: 'value', source: { kind: 'node', nodeId: 'c', field: 'value' } }] }),
        pythonNode('c'),
      ],
      [edge('a-to-b', 'a', 'b'), edge('a-to-c', 'a', 'c')],
    ),
    code: 'definition/input-node-not-ancestor',
    path: 'nodes[1].inputs[0].source.nodeId',
    only: true,
  },
  { name: 'an edge is not an object', document: documentOf([pythonNode('a')], ['x']), code: 'definition/edge-invalid', path: 'edges[0]' },
  {
    name: 'an edge id has a bad pattern',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('Bad', 'a', 'b')]),
    code: 'definition/edge-id-invalid',
    path: 'edges[0].id',
  },
  {
    name: 'two edges share an id',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('dup', 'a', 'b'), edge('dup', 'a', 'b')]),
    code: 'definition/duplicate-edge',
    path: 'edges[1].id',
  },
  {
    name: 'an edge source names no node',
    document: documentOf([pythonNode('a')], [edge('e', 'zzz', 'a')]),
    code: 'definition/edge-endpoint-missing',
    path: 'edges[0].from',
  },
  {
    name: 'an edge target names no node',
    document: documentOf([pythonNode('a')], [edge('e', 'a', 'zzz')]),
    code: 'definition/edge-endpoint-missing',
    path: 'edges[0].to',
  },
  {
    name: 'an edge source is not a string',
    document: documentOf([pythonNode('a')], [edge('e', 'a', 'a', { from: 7 })]),
    code: 'definition/edge-endpoint-missing',
    path: 'edges[0].from',
  },
  {
    name: 'an edge mode is unknown',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { mode: 'any' })]),
    code: 'definition/edge-mode-invalid',
    path: 'edges[0].mode',
    only: true,
  },
  {
    name: 'one node mixes edge modes',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a-to-b', 'a', 'b'), edge('a-to-c', 'a', 'c', { mode: 'exclusive' })],
    ),
    code: 'definition/mixed-edge-modes',
    path: 'edges[1].mode',
    only: true,
  },
  {
    name: 'an edge declares no condition field',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { condition: undefined })]),
    code: 'definition/condition-invalid',
    path: 'edges[0].condition',
  },
  {
    name: 'an edge condition is not a predicate object',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { condition: 'passed' })]),
    code: 'definition/condition-invalid',
    path: 'edges[0].condition',
  },
  {
    name: 'a condition declares no op',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { condition: { field: 'x' } })]),
    code: 'definition/condition-invalid',
    path: 'edges[0].condition.op',
  },
  {
    name: 'a condition op is unknown',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'between', field: 'x', value: 1 } }),
    ]),
    code: 'definition/condition-invalid',
    path: 'edges[0].condition.op',
  },
  {
    name: 'a condition field is empty',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'eq', field: '', value: 1 } }),
    ]),
    code: 'definition/condition-field-invalid',
    path: 'edges[0].condition.field',
  },
  {
    name: 'a condition field path is invalid',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'eq', field: 'a..b', value: 1 } }),
    ]),
    code: 'definition/condition-field-invalid',
    path: 'edges[0].condition.field',
  },
  {
    name: 'a comparison condition has no value',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'eq', field: 'x' } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition',
  },
  {
    name: 'an exists condition carries a value',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'exists', field: 'x', value: true } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'an in condition value is not an array',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'in', field: 'x', value: 1 } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'an in condition array holds a non-scalar',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'not-in', field: 'x', value: [{}] } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'a numeric condition value is a string',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'gt', field: 'x', value: '1' } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'a numeric condition value is not finite',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'lt', field: 'x', value: Number.NaN } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'an equality condition value is not a scalar',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'eq', field: 'x', value: { a: 1 } } }),
    ]),
    code: 'definition/condition-value-invalid',
    path: 'edges[0].condition.value',
  },
  {
    name: 'an and condition has no arguments',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'and', args: [] } }),
    ]),
    code: 'definition/condition-args-invalid',
    path: 'edges[0].condition.args',
  },
  {
    name: 'an or condition arguments are not an array',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'or', args: 'x' } }),
    ]),
    code: 'definition/condition-args-invalid',
    path: 'edges[0].condition.args',
  },
  {
    name: 'a not condition has no argument',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'not' } }),
    ]),
    code: 'definition/condition-args-invalid',
    path: 'edges[0].condition.arg',
  },
  {
    name: 'a nested condition argument is invalid',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: { op: 'and', args: [{ op: 'exists', field: 'x' }, { op: 'bogus', field: 'y' }] } }),
    ]),
    code: 'definition/condition-invalid',
    path: 'edges[0].condition.args[1].op',
  },
  {
    name: 'condition nesting is too deep',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { condition: nestedPredicate(40) }),
    ]),
    code: 'definition/condition-too-deep',
  },
  {
    name: 'a fallback flag is not a boolean',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { mode: 'exclusive', fallback: 'yes' })]),
    code: 'definition/fallback-invalid',
    path: 'edges[0].fallback',
  },
  {
    name: 'a fallback edge carries a condition',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('e', 'a', 'b', { mode: 'exclusive', fallback: true, condition: { op: 'exists', field: 'x' } }),
    ]),
    code: 'definition/fallback-condition',
    path: 'edges[0].condition',
  },
  {
    name: 'a multiple edge declares a fallback',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('e', 'a', 'b', { fallback: true })]),
    code: 'definition/fallback-mode',
    path: 'edges[0].fallback',
  },
  {
    name: 'one node declares two fallback edges',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a-to-b', 'a', 'b', { mode: 'exclusive', fallback: true }),
        edge('a-to-c', 'a', 'c', { mode: 'exclusive', fallback: true }),
      ],
    ),
    code: 'definition/multiple-fallback-edges',
    path: 'edges[1].fallback',
    only: true,
  },
  {
    name: 'a fallback edge names no source',
    document: documentOf([pythonNode('a')], [edge('e', 'zzz', 'a', { mode: 'exclusive', fallback: true })]),
    code: 'definition/edge-endpoint-missing',
    path: 'edges[0].from',
  },
  {
    name: 'a loop edge names no source',
    document: documentOf([pythonNode('a')], [edge('e', 'zzz', 'a', { loop: { maxIterations: 2 } })]),
    code: 'definition/edge-endpoint-missing',
    path: 'edges[0].from',
  },
  {
    name: 'a loop specification is not an object',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('a-to-b', 'a', 'b'),
      edge('b-again', 'b', 'a', { loop: 'until-done' }),
    ]),
    code: 'definition/loop-invalid',
    path: 'edges[1].loop',
  },
  {
    name: 'a loop declares an unsupported field',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('a-to-b', 'a', 'b'),
      edge('b-again', 'b', 'a', { loop: { maxIterations: 2, until: 'done' } }),
    ]),
    code: 'definition/loop-invalid',
    path: 'edges[1].loop.until',
  },
  {
    name: 'loop maxIterations is below one',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('a-to-b', 'a', 'b'),
      edge('b-again', 'b', 'a', { loop: { maxIterations: 0 } }),
    ]),
    code: 'definition/loop-max-iterations-invalid',
    path: 'edges[1].loop.maxIterations',
  },
  {
    name: 'loop maxIterations is not an integer',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('a-to-b', 'a', 'b'),
      edge('b-again', 'b', 'a', { loop: { maxIterations: 1.5 } }),
    ]),
    code: 'definition/loop-max-iterations-invalid',
    path: 'edges[1].loop.maxIterations',
  },
  {
    name: 'loop maxIterations is not a number',
    document: documentOf([pythonNode('a'), pythonNode('b')], [
      edge('a-to-b', 'a', 'b'),
      edge('b-again', 'b', 'a', { loop: { maxIterations: '2' } }),
    ]),
    code: 'definition/loop-max-iterations-invalid',
    path: 'edges[1].loop.maxIterations',
  },
  {
    name: 'a loop edge is exclusive',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a-to-b', 'a', 'b'),
        edge('b-to-c', 'b', 'c'),
        edge('c-again', 'c', 'b', { mode: 'exclusive', loop: { maxIterations: 2 } }),
      ],
    ),
    code: 'definition/loop-edge-mode',
    path: 'edges[2].mode',
    only: true,
  },
  {
    name: 'one node declares two loop edges',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a-to-b', 'a', 'b'),
        edge('a-to-c', 'a', 'c'),
        edge('b-again', 'b', 'a', { loop: { maxIterations: 2 } }),
        edge('b-back', 'b', 'a', { loop: { maxIterations: 2 } }),
      ],
    ),
    code: 'definition/multiple-loop-edges',
    path: 'edges[3].loop',
  },
  {
    name: 'a loop target is not an ancestor',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a-to-b', 'a', 'b'), edge('a-to-c', 'a', 'c'), edge('b-to-c', 'b', 'c', { loop: { maxIterations: 2 } })],
    ),
    code: 'definition/loop-target-not-ancestor',
    path: 'edges[2].to',
    only: true,
  },
  {
    name: 'an edge returns to its own source without a loop',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('a-to-b', 'a', 'b'), edge('b-to-b', 'b', 'b')]),
    code: 'definition/self-loop',
    path: 'edges[1].to',
  },
  {
    name: 'the graph has no entry node',
    document: documentOf([pythonNode('a'), pythonNode('b')], [edge('a-to-b', 'a', 'b'), edge('b-to-a', 'b', 'a')]),
    code: 'definition/no-entry-node',
    path: 'nodes',
  },
  {
    name: 'the graph has several entry nodes',
    document: documentOf([pythonNode('a'), pythonNode('b')], []),
    code: 'definition/multiple-entry-nodes',
    path: 'nodes',
    only: true,
  },
  {
    name: 'a node is unreachable',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('b-to-c', 'b', 'c'), edge('c-to-b', 'c', 'b')],
    ),
    code: 'definition/unreachable-node',
    path: 'nodes[1]',
  },
  {
    name: 'the graph has a cycle',
    document: documentOf(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a-to-b', 'a', 'b'), edge('b-to-c', 'b', 'c'), edge('c-to-b', 'c', 'b')],
    ),
    code: 'definition/graph-cycle',
    path: 'edges',
    only: true,
  },
  {
    name: 'first-success is used on a node with no incoming edge',
    document: documentOf([pythonNode('solo', { join: 'first-success' })], []),
    code: 'definition/join-first-success-degree',
    path: 'nodes[0].join',
    only: true,
  },
  {
    name: 'an entry node reads a descendant result',
    document: documentOf(
      [
        pythonNode('entry', { inputs: [{ name: 'value', source: { kind: 'node', nodeId: 'later', field: 'value' } }] }),
        pythonNode('later'),
      ],
      [edge('entry-to-later', 'entry', 'later')],
    ),
    code: 'definition/input-node-not-ancestor',
    path: 'nodes[0].inputs[0].source.nodeId',
    only: true,
  },
  {
    name: 'first-success is used on a node with one incoming edge',
    document: documentOf([pythonNode('a'), pythonNode('b', { join: 'first-success' })], [edge('a-to-b', 'a', 'b')]),
    code: 'definition/join-first-success-degree',
    path: 'nodes[1].join',
    only: true,
  },
]

describe('validateDefinition', () => {
  it.each([...VALID])('accepts $name', ({ document }) => {
    const result = validateDefinition(document)
    expect(result.ok ? [] : result.violations).toEqual([])
    expect(result).toEqual({ ok: true })
  })

  it.each([...INVALID])('reports $code for $name', ({ document, code, path, only }) => {
    const result = validateDefinition(document)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const found = result.violations.find(violation => violation.code === code)
    expect(found, `violations: ${JSON.stringify(result.violations)}`).toBeDefined()
    if (path !== undefined) expect(found?.path).toBe(path)
    if (only === true) expect(result.violations.map(violation => violation.code)).toEqual([code])
    expect(codesOf(document)).toContain(code)
    expect(findViolation(document, code)?.message.length).toBeGreaterThan(0)
  })

  it('reports the parsed document version when it is not 1', () => {
    expect(findViolation({ version: 2, nodes: [], edges: [] }, 'definition/version-unsupported')?.message)
      .toContain('got 2')
  })

  it('reports every violation instead of stopping at the first pass', () => {
    const result = validateDefinition(documentOf([pythonNode('a', { title: '' })], [edge('Bad', 'a', 'missing')]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.map(violation => violation.code)).toEqual([
      'definition/node-title-empty',
      'definition/edge-id-invalid',
      'definition/edge-endpoint-missing',
    ])
  })

  it('accepts a definition whose python node id is valid but whose config is not checked', () => {
    const result = validateDefinition(documentOf([pythonNode('ok', { id: 'Bad' })], []))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some(violation => violation.code === 'definition/python-entry-missing')).toBe(false)
  })

  it('accepts a reused schema instance in two agent nodes', () => {
    const shared = objectSchema()
    const result = validateDefinition(documentOf(
      [agentNode('first', { config: agentConfig(shared) }), agentNode('second', { config: agentConfig(shared) })],
      [edge('first-to-second', 'first', 'second')],
    ))
    expect(result).toEqual({ ok: true })
  })
})
