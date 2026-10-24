/**
 * Shared fixtures for the definition suites. Documents are built as plain JSON
 * records so an invalid case can differ from a valid one by exactly one value.
 */

import type { JsonSchemaNode } from '@metaworkflow/tools'
import type { AgentNodeConfig, PythonNodeConfig, WorkflowDefinition } from '../../src/types.ts'

/** Result of a shell-style id probe used by the validator suites. */
export interface DocumentSpec {
  /** Human-readable case name. */
  readonly name: string
  /** Candidate document of unknown origin. */
  readonly document: unknown
}

/**
 * Build a Python node config for one node id.
 * @param id - node id whose entry function the source must define.
 * @returns the config every python fixture node uses.
 */
export function pythonConfig(id: string): PythonNodeConfig {
  return { kind: 'python', source: `def nodemain_${id}(inputs):\n    return {"ok": True}\n` }
}

/**
 * Build a closed object schema.
 * @returns an object schema with one required boolean property.
 */
export function objectSchema(): JsonSchemaNode {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  }
}

/**
 * Build an agent node config.
 * @param schema - output schema; defaults to {@link objectSchema}.
 * @returns the config every agent fixture node uses.
 */
export function agentConfig(schema: JsonSchemaNode = objectSchema()): AgentNodeConfig {
  return { kind: 'agent', outputSchema: schema, instructions: 'Summarize the fetch result.', tools: ['read'], memory: 'fresh' }
}

/**
 * Build an agent node config around an arbitrary schema value, for invalid-shape cases.
 * @param outputSchema - the schema value to embed, valid or not.
 * @returns a plain JSON record the node fixtures can embed.
 */
export function rawAgentConfig(outputSchema: unknown): Record<string, unknown> {
  return { kind: 'agent', outputSchema, instructions: 'Summarize the fetch result.', tools: [], memory: 'fresh' }
}

/**
 * Build one python node document as a plain JSON record.
 * @param id - node id; the generated source names its entry function.
 * @param extra - additional or overriding node fields.
 * @returns a mutable node record.
 */
export function pythonNode(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'python', title: `Run ${id}`, config: pythonConfig(id), inputs: [], join: 'all', ...extra }
}

/**
 * Build one agent node document as a plain JSON record.
 * @param id - node id.
 * @param extra - additional or overriding node fields.
 * @returns a mutable node record.
 */
export function agentNode(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'agent', title: `Ask ${id}`, config: agentConfig(), inputs: [], join: 'all', ...extra }
}

/**
 * Build one edge document as a plain JSON record.
 * @param id - edge id.
 * @param from - source node id.
 * @param to - target node id.
 * @param extra - additional or overriding edge fields.
 * @returns a mutable edge record.
 */
export function edge(id: string, from: string, to: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from, to, condition: null, mode: 'multiple', ...extra }
}

/**
 * Build one complete document record.
 * @param nodes - node records.
 * @param edges - edge records.
 * @param extra - additional or overriding document fields.
 * @returns a mutable document record.
 */
export function documentOf(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 1, nodes, edges, ...extra }
}

/**
 * The rich valid definition: python and agent nodes, exclusive fallback
 * selection, a loop back edge, a `first-success` join, and all three input
 * source kinds.
 * @returns a fresh definition in document order.
 */
export function validDefinition(): WorkflowDefinition {
  return {
    version: 1,
    nodes: [
      {
        id: 'fetch',
        kind: 'python',
        title: 'Fetch the report',
        config: pythonConfig('fetch'),
        inputs: [{ name: 'mode', source: { kind: 'run', key: 'mode' } }],
        join: 'all',
      },
      {
        id: 'gate',
        kind: 'python',
        title: 'Decide what to do next',
        config: pythonConfig('gate'),
        inputs: [{ name: 'count', source: { kind: 'node', nodeId: 'fetch', field: 'count' } }],
        join: 'all',
      },
      {
        id: 'retry',
        kind: 'agent',
        title: 'Retry the weak sections',
        config: agentConfig(),
        inputs: [{ name: 'retryable', source: { kind: 'node', nodeId: 'gate', field: 'retryable' } }],
        join: 'all',
      },
      {
        id: 'merge',
        kind: 'python',
        title: 'Merge the branches',
        config: pythonConfig('merge'),
        inputs: [],
        join: 'first-success',
      },
      {
        id: 'report',
        kind: 'agent',
        title: 'Write the final report',
        config: agentConfig(),
        inputs: [
          { name: 'value', source: { kind: 'node', nodeId: 'merge', field: 'value' } },
          { name: 'source', source: { kind: 'artifact', name: 'raw-report' } },
        ],
        join: 'all',
      },
    ],
    edges: [
      { id: 'fetch-to-gate', from: 'fetch', to: 'gate', condition: null, mode: 'exclusive' },
      {
        id: 'gate-to-retry',
        from: 'gate',
        to: 'retry',
        condition: { op: 'eq', field: 'retryable', value: true },
        mode: 'exclusive',
      },
      { id: 'gate-to-merge', from: 'gate', to: 'merge', condition: null, mode: 'exclusive', fallback: true },
      { id: 'retry-to-merge', from: 'retry', to: 'merge', condition: null, mode: 'multiple' },
      {
        id: 'merge-to-report',
        from: 'merge',
        to: 'report',
        condition: { op: 'and', args: [{ op: 'exists', field: 'value' }, { op: 'ne', field: 'value', value: null }] },
        mode: 'multiple',
      },
      { id: 'retry-again', from: 'retry', to: 'gate', condition: null, mode: 'multiple', loop: { maxIterations: 3 } },
    ],
  }
}
