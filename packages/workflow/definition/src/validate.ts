/**
 * Definition validation: the single authority for every rule the JSON document
 * must satisfy. `validateDefinition` accepts a value of unknown origin (stored
 * text, a model-written file) and reports stable violation codes with document
 * paths; it never throws and never coerces.
 *
 * @module @metaworkflow/workflow-definition/validate
 */

import { assertSupportedJsonSchema, JsonSchemaError } from '@metaworkflow/tools'
import { isJsonObject, isJsonScalar } from './json.ts'
import { parseFieldPath } from './path.ts'
import type { DefinitionViolation, ValidationResult } from './types.ts'

/** Node and edge ids: lower-case identifiers starting with a letter. */
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/

/** Field comparison operators a predicate can declare. */
const FIELD_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not-in', 'exists', 'truthy'])

/** Nesting depth accepted for a predicate. */
const MAX_PREDICATE_DEPTH = 32

/** Shared empty ancestor set, so ancestor lookups never allocate. */
const EMPTY_ANCESTORS: ReadonlySet<string> = new Set<string>()

/** One decoded input binding, kept for the graph pass. */
interface InputView {
  /** Document path of the input binding. */
  readonly path: string
  /** Source discriminant when readable. */
  readonly sourceKind: string | undefined
  /** Referenced node id, run key, or artifact name. */
  readonly reference: string | undefined
  /** Field path for a node source. */
  readonly field: string | undefined
}

/** One decoded node, kept for the graph pass. */
interface NodeView {
  /** Document path of the node. */
  readonly path: string
  /** Node id when it is a valid identifier. */
  readonly id: string | undefined
  /** Declared join policy when it is a known one. */
  readonly join: string | undefined
  /** Decoded input bindings. */
  readonly inputs: readonly InputView[]
}

/** One decoded edge, kept for the graph pass. */
interface EdgeView {
  /** Document path of the edge. */
  readonly path: string
  /** Source node id when it names an existing node. */
  readonly from: string | undefined
  /** Target node id when it names an existing node. */
  readonly to: string | undefined
  /** Whether the edge is a loop (re-entry) edge. */
  readonly loop: boolean
}

/** Accumulator threaded through the validation passes. */
type Violations = DefinitionViolation[]

/**
 * Validate one candidate workflow definition.
 *
 * The rules cover the document envelope, node and edge identity, node
 * configuration, the agent output-schema subset, conditions, edge semantics,
 * loop back edges, graph structure, and input provenance. Violations are reported in
 * document order per pass; validation never throws.
 *
 * @param value - a value of unknown origin, such as parsed document text.
 * @returns `{ ok: true }`, or the violations that reject the document.
 */
export function validateDefinition(value: unknown): ValidationResult {
  const violations: Violations = []
  if (!isJsonObject(value)) {
    violations.push({ code: 'definition/document-invalid', path: '', message: 'a workflow definition must be a JSON object' })
    return { ok: false, violations }
  }
  validateVersion(value['version'], violations)
  const nodes = value['nodes']
  const edges = value['edges']
  if (!Array.isArray(nodes)) violations.push({ code: 'definition/nodes-invalid', path: 'nodes', message: 'nodes must be an array' })
  if (!Array.isArray(edges)) violations.push({ code: 'definition/edges-invalid', path: 'edges', message: 'edges must be an array' })
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return { ok: false, violations }
  const nodeViews = validateNodes(nodes, violations)
  const edgeViews = validateEdges(edges, nodeViews, violations)
  validateGraph(nodeViews, edgeViews, violations)
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/**
 * Check the document format version.
 * @param version - raw `version` value.
 * @param violations - accumulator for reported violations.
 */
function validateVersion(version: unknown, violations: Violations): void {
  if (version !== 1) {
    violations.push({
      code: 'definition/version-unsupported',
      path: 'version',
      message: `document version must be 1, got ${describeValue(version)}`,
    })
  }
}

/**
 * Validate every node and decode the identifiers later passes need.
 * @param nodes - raw node array.
 * @param violations - accumulator for reported violations.
 * @returns one view per node in document order.
 */
function validateNodes(nodes: readonly unknown[], violations: Violations): NodeView[] {
  const views: NodeView[] = []
  const ids = new Map<string, string>()
  for (const [index, raw] of nodes.entries()) {
    const path = `nodes[${index}]`
    if (!isJsonObject(raw)) {
      violations.push({ code: 'definition/node-invalid', path, message: 'a node must be a JSON object' })
      views.push({ path, id: undefined, join: undefined, inputs: [] })
      continue
    }
    const id = validateNodeId(raw['id'], path, ids, violations)
    const kind = validateNodeKind(raw['kind'], path, violations)
    validateNodeTitle(raw['title'], path, violations)
    const join = validateNodeJoin(raw['join'], path, violations)
    validateNodeConfig(raw['config'], path, kind, id, violations)
    const inputs = validateInputs(raw['inputs'], path, violations)
    views.push({ path, id, join, inputs })
  }
  return views
}

/**
 * Validate one node id and record it for duplicate detection.
 * @param raw - raw `id` value.
 * @param nodePath - document path of the owning node.
 * @param ids - ids already declared, mapped to their declaring node path.
 * @param violations - accumulator for reported violations.
 * @returns the id when it is a valid, previously unseen identifier.
 */
function validateNodeId(
  raw: unknown,
  nodePath: string,
  ids: Map<string, string>,
  violations: Violations,
): string | undefined {
  if (typeof raw !== 'string') {
    violations.push({ code: 'definition/node-id-invalid', path: `${nodePath}.id`, message: 'node id must be a string' })
    return undefined
  }
  if (!ID_PATTERN.test(raw)) {
    violations.push({
      code: 'definition/node-id-invalid',
      path: `${nodePath}.id`,
      message: `node id ${JSON.stringify(raw)} must match ${ID_PATTERN.source}`,
    })
    return undefined
  }
  const declaredAt = ids.get(raw)
  if (declaredAt !== undefined) {
    violations.push({
      code: 'definition/duplicate-node',
      path: `${nodePath}.id`,
      message: `node id ${JSON.stringify(raw)} is already declared at ${declaredAt}`,
    })
    return undefined
  }
  ids.set(raw, nodePath)
  return raw
}

/**
 * Validate one node kind.
 * @param raw - raw `kind` value.
 * @param nodePath - document path of the owning node.
 * @param violations - accumulator for reported violations.
 * @returns the kind when it is `python` or `agent`.
 */
function validateNodeKind(raw: unknown, nodePath: string, violations: Violations): string | undefined {
  if (raw === 'python' || raw === 'agent') return raw
  violations.push({
    code: 'definition/node-kind-invalid',
    path: `${nodePath}.kind`,
    message: 'node kind must be "python" or "agent"',
  })
  return undefined
}

/**
 * Validate the node title.
 * @param raw - raw `title` value.
 * @param nodePath - document path of the owning node.
 * @param violations - accumulator for reported violations.
 */
function validateNodeTitle(raw: unknown, nodePath: string, violations: Violations): void {
  if (typeof raw === 'string' && raw.trim().length > 0) return
  violations.push({ code: 'definition/node-title-empty', path: `${nodePath}.title`, message: 'node title must be a non-empty string' })
}

/**
 * Validate the node join policy.
 * @param raw - raw `join` value.
 * @param nodePath - document path of the owning node.
 * @param violations - accumulator for reported violations.
 * @returns the policy when it is a known one.
 */
function validateNodeJoin(raw: unknown, nodePath: string, violations: Violations): string | undefined {
  if (raw === 'all' || raw === 'first-success') return raw
  violations.push({
    code: 'definition/node-join-invalid',
    path: `${nodePath}.join`,
    message: 'node join must be "all" or "first-success"',
  })
  return undefined
}

/**
 * Validate one node's configuration against its declared kind.
 * @param raw - raw `config` value.
 * @param nodePath - document path of the owning node.
 * @param kind - the node's declared kind, when valid.
 * @param nodeId - the node's id, when valid.
 * @param violations - accumulator for reported violations.
 */
function validateNodeConfig(
  raw: unknown,
  nodePath: string,
  kind: string | undefined,
  nodeId: string | undefined,
  violations: Violations,
): void {
  const path = `${nodePath}.config`
  if (!isJsonObject(raw)) {
    violations.push({ code: 'definition/node-config-invalid', path, message: 'node config must be a JSON object' })
    return
  }
  const configKind = raw['kind']
  if (kind !== undefined && configKind !== kind) {
    violations.push({
      code: 'definition/node-config-kind-mismatch',
      path: `${path}.kind`,
      message: `node config kind must match the node kind ${JSON.stringify(kind)}`,
    })
  }
  if (kind === 'python') validatePythonConfig(raw, path, nodeId, violations)
  else if (kind === 'agent') validateAgentConfig(raw, path, violations)
}

/**
 * Validate a Python node's config.
 * @param config - the node config object.
 * @param path - document path of the config.
 * @param nodeId - the node's id, when valid.
 * @param violations - accumulator for reported violations.
 */
function validatePythonConfig(
  config: Record<string, unknown>,
  path: string,
  nodeId: string | undefined,
  violations: Violations,
): void {
  const source = config['source']
  if (typeof source !== 'string' || source.trim().length === 0) {
    violations.push({
      code: 'definition/python-source-empty',
      path: `${path}.source`,
      message: 'python node source must be a non-empty string',
    })
    return
  }
  if (nodeId === undefined) return
  const marker = `def nodemain_${nodeId}(`
  if (!source.includes(marker)) {
    violations.push({
      code: 'definition/python-entry-missing',
      path: `${path}.source`,
      message: `python node source must define ${JSON.stringify(marker)}`,
    })
  }
}

/**
 * Validate an agent node's config.
 * @param config - the node config object.
 * @param path - document path of the config.
 * @param violations - accumulator for reported violations.
 */
function validateAgentConfig(config: Record<string, unknown>, path: string, violations: Violations): void {
  const instructions = config['instructions']
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    violations.push({
      code: 'definition/agent-instructions-empty',
      path: `${path}.instructions`,
      message: 'agent node instructions must be a non-empty string',
    })
  }
  const memory = config['memory']
  if (memory !== 'retained' && memory !== 'fresh') {
    violations.push({
      code: 'definition/agent-memory-invalid',
      path: `${path}.memory`,
      message: 'agent node memory must be "retained" or "fresh"',
    })
  }
  validateAgentTools(config['tools'], path, violations)
  validateOutputSchema(config['outputSchema'], path, violations)
}

/**
 * Validate the agent tool list.
 * @param raw - raw `tools` value.
 * @param path - document path of the config.
 * @param violations - accumulator for reported violations.
 */
function validateAgentTools(raw: unknown, path: string, violations: Violations): void {
  if (!Array.isArray(raw)) {
    violations.push({
      code: 'definition/agent-tools-invalid',
      path: `${path}.tools`,
      message: 'agent node tools must be an array of tool names',
    })
    return
  }
  const seen = new Set<string>()
  for (const [index, tool] of raw.entries()) {
    const toolPath = `${path}.tools[${index}]`
    if (typeof tool !== 'string' || tool.trim().length === 0) {
      violations.push({ code: 'definition/agent-tools-invalid', path: toolPath, message: 'tool name must be a non-empty string' })
      continue
    }
    if (seen.has(tool)) {
      violations.push({ code: 'definition/agent-tools-invalid', path: toolPath, message: `tool ${JSON.stringify(tool)} is declared twice` })
      continue
    }
    seen.add(tool)
  }
}

/**
 * Validate the agent output schema against the shared enforced JSON Schema
 * subset and require an object root.
 * @param raw - raw `outputSchema` value.
 * @param path - document path of the config.
 * @param violations - accumulator for reported violations.
 */
function validateOutputSchema(raw: unknown, path: string, violations: Violations): void {
  const schemaPath = `${path}.outputSchema`
  if (!isJsonObject(raw)) {
    violations.push({
      code: 'definition/schema-invalid',
      path: schemaPath,
      message: 'agent node requires an outputSchema object',
    })
    return
  }
  const details = schemaViolations(raw)
  if (details.length > 0) {
    for (const detail of details) {
      violations.push({ code: 'definition/schema-unsupported', path: schemaPath, message: detail })
    }
    return
  }
  if (raw['type'] !== 'object') {
    violations.push({
      code: 'definition/schema-root-not-object',
      path: `${schemaPath}.type`,
      message: 'an agent outputSchema must describe an object at the root',
    })
  }
}

/**
 * Collect the shared validator's violations for one candidate schema.
 * @param schema - schema value of unknown origin.
 * @returns the violation paths and reasons; empty means the schema is supported.
 */
function schemaViolations(schema: unknown): readonly string[] {
  try {
    assertSupportedJsonSchema(schema)
    return []
  } catch (error) {
    /* v8 ignore next -- assertSupportedJsonSchema throws only JsonSchemaError. */
    if (!(error instanceof JsonSchemaError)) throw error
    return error.violations
  }
}

/**
 * Validate one node's input bindings.
 * @param raw - raw `inputs` value.
 * @param nodePath - document path of the owning node.
 * @param violations - accumulator for reported violations.
 * @returns the decoded bindings the graph pass needs.
 */
function validateInputs(raw: unknown, nodePath: string, violations: Violations): InputView[] {
  if (!Array.isArray(raw)) {
    violations.push({
      code: 'definition/node-inputs-invalid',
      path: `${nodePath}.inputs`,
      message: 'node inputs must be an array',
    })
    return []
  }
  const views: InputView[] = []
  const names = new Set<string>()
  for (const [index, binding] of raw.entries()) {
    const path = `${nodePath}.inputs[${index}]`
    if (!isJsonObject(binding)) {
      violations.push({ code: 'definition/node-inputs-invalid', path, message: 'an input binding must be a JSON object' })
      continue
    }
    const name = binding['name']
    if (typeof name !== 'string' || name.trim().length === 0) {
      violations.push({ code: 'definition/input-name-invalid', path: `${path}.name`, message: 'input name must be a non-empty string' })
    } else if (names.has(name)) {
      violations.push({ code: 'definition/duplicate-input', path: `${path}.name`, message: `input name ${JSON.stringify(name)} is declared twice` })
    } else {
      names.add(name)
    }
    const source = binding['source']
    if (!isJsonObject(source)) {
      violations.push({ code: 'definition/input-source-invalid', path: `${path}.source`, message: 'input source must be a JSON object' })
      continue
    }
    const sourceKind = source['kind']
    if (sourceKind === 'node') {
      const nodeId = source['nodeId']
      const reference = typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined
      if (reference === undefined) {
        violations.push({
          code: 'definition/input-source-invalid',
          path: `${path}.source.nodeId`,
          message: 'a node input source must name a producing node',
        })
      }
      const fieldRaw = source['field']
      const field = typeof fieldRaw === 'string' && parseFieldPath(fieldRaw) !== undefined ? fieldRaw : undefined
      if (field === undefined) {
        violations.push({
          code: 'definition/input-field-invalid',
          path: `${path}.source.field`,
          message: 'an input field must be a dot-separated path such as "review.passed"',
        })
      }
      views.push({ path, sourceKind, reference, field })
      continue
    }
    if (sourceKind === 'run') {
      const key = source['key']
      const reference = typeof key === 'string' && key.trim().length > 0 ? key : undefined
      if (reference === undefined) {
        violations.push({ code: 'definition/run-key-empty', path: `${path}.source.key`, message: 'a run input key must be a non-empty string' })
      }
      views.push({ path, sourceKind, reference, field: undefined })
      continue
    }
    if (sourceKind === 'artifact') {
      const artifact = source['name']
      const reference = typeof artifact === 'string' && artifact.trim().length > 0 ? artifact : undefined
      if (reference === undefined) {
        violations.push({ code: 'definition/artifact-name-empty', path: `${path}.source.name`, message: 'an artifact input must name a non-empty artifact' })
      }
      views.push({ path, sourceKind, reference, field: undefined })
      continue
    }
    violations.push({
      code: 'definition/input-source-invalid',
      path: `${path}.source.kind`,
      message: 'an input source kind must be "node", "run", or "artifact"',
    })
  }
  return views
}

/**
 * Validate every edge and decode the endpoints later passes need.
 * @param edges - raw edge array.
 * @param nodes - decoded nodes, used for endpoint and mode checks.
 * @param violations - accumulator for reported violations.
 * @returns one view per edge in document order.
 */
function validateEdges(edges: readonly unknown[], nodes: readonly NodeView[], violations: Violations): EdgeView[] {
  const views: EdgeView[] = []
  const nodeIds = new Set(nodes.flatMap(node => (node.id === undefined ? [] : [node.id])))
  const edgeIds = new Map<string, string>()
  const modes = new Map<string, { readonly mode: string; readonly path: string }>()
  const fallbackSources = new Set<string>()
  const loopSources = new Set<string>()
  for (const [index, raw] of edges.entries()) {
    const path = `edges[${index}]`
    if (!isJsonObject(raw)) {
      violations.push({ code: 'definition/edge-invalid', path, message: 'an edge must be a JSON object' })
      views.push({ path, from: undefined, to: undefined, loop: false })
      continue
    }
    validateEdgeId(raw['id'], path, edgeIds, violations)
    const from = readEndpoint(raw['from'], nodeIds, `${path}.from`, 'from', violations)
    const to = readEndpoint(raw['to'], nodeIds, `${path}.to`, 'to', violations)
    const mode = validateEdgeMode(raw['mode'], path, violations)
    if (from !== undefined && mode !== undefined) validateSourceMode(from, mode, path, modes, violations)
    const condition = raw['condition']
    if (condition === undefined) {
      violations.push({
        code: 'definition/condition-invalid',
        path: `${path}.condition`,
        message: 'an edge condition must be a predicate or null',
      })
    } else if (condition !== null) {
      validatePredicate(condition, `${path}.condition`, 0, violations)
    }
    validateFallback(raw, path, from, mode, condition, fallbackSources, violations)
    const loop = validateLoop(raw, path, from, mode, loopSources, violations)
    if (from !== undefined && from === to && !loop) {
      violations.push({
        code: 'definition/self-loop',
        path: `${path}.to`,
        message: `edge ${JSON.stringify(from)} targets its own source; only a loop edge may re-enter its source`,
      })
    }
    views.push({ path, from, to, loop })
  }
  return views
}

/**
 * Validate one edge id and record it for duplicate detection.
 * @param raw - raw `id` value.
 * @param edgePath - document path of the owning edge.
 * @param ids - ids already declared, mapped to their declaring edge path.
 * @param violations - accumulator for reported violations.
 */
function validateEdgeId(raw: unknown, edgePath: string, ids: Map<string, string>, violations: Violations): void {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    violations.push({
      code: 'definition/edge-id-invalid',
      path: `${edgePath}.id`,
      message: `edge id must match ${ID_PATTERN.source}`,
    })
    return
  }
  const declaredAt = ids.get(raw)
  if (declaredAt !== undefined) {
    violations.push({
      code: 'definition/duplicate-edge',
      path: `${edgePath}.id`,
      message: `edge id ${JSON.stringify(raw)} is already declared at ${declaredAt}`,
    })
    return
  }
  ids.set(raw, edgePath)
}

/**
 * Resolve one edge endpoint against the declared nodes.
 * @param raw - raw endpoint value.
 * @param nodeIds - declared node ids.
 * @param path - document path of the endpoint.
 * @param field - endpoint field name, for the message.
 * @param violations - accumulator for reported violations.
 * @returns the endpoint node id when it names a declared node.
 */
function readEndpoint(
  raw: unknown,
  nodeIds: ReadonlySet<string>,
  path: string,
  field: string,
  violations: Violations,
): string | undefined {
  if (typeof raw === 'string' && nodeIds.has(raw)) return raw
  violations.push({
    code: 'definition/edge-endpoint-missing',
    path,
    message: `edge ${field} must name an existing node`,
  })
  return undefined
}

/**
 * Validate the edge selection mode.
 * @param raw - raw `mode` value.
 * @param edgePath - document path of the owning edge.
 * @param violations - accumulator for reported violations.
 * @returns the mode when it is a known one.
 */
function validateEdgeMode(raw: unknown, edgePath: string, violations: Violations): string | undefined {
  if (raw === 'exclusive' || raw === 'multiple') return raw
  violations.push({
    code: 'definition/edge-mode-invalid',
    path: `${edgePath}.mode`,
    message: 'edge mode must be "exclusive" or "multiple"',
  })
  return undefined
}

/**
 * Require one selection mode per source node.
 * @param from - the edge's source node id.
 * @param mode - the edge's valid mode.
 * @param path - document path of the edge.
 * @param modes - modes already declared per source, with their first edge path.
 * @param violations - accumulator for reported violations.
 */
function validateSourceMode(
  from: string,
  mode: string,
  path: string,
  modes: Map<string, { readonly mode: string; readonly path: string }>,
  violations: Violations,
): void {
  const declared = modes.get(from)
  if (declared === undefined) {
    modes.set(from, { mode, path })
    return
  }
  if (declared.mode === mode) return
  violations.push({
    code: 'definition/mixed-edge-modes',
    path: `${path}.mode`,
    message: `node ${JSON.stringify(from)} mixes edge modes; its first edge at ${declared.path} is ${JSON.stringify(declared.mode)}`,
  })
}

/**
 * Validate the optional fallback flag.
 * @param raw - the edge object.
 * @param path - document path of the edge.
 * @param from - the edge's source node id, when valid.
 * @param mode - the edge's mode, when valid.
 * @param condition - the raw condition value.
 * @param fallbackSources - source nodes that already declared a fallback.
 * @param violations - accumulator for reported violations.
 */
function validateFallback(
  raw: Record<string, unknown>,
  path: string,
  from: string | undefined,
  mode: string | undefined,
  condition: unknown,
  fallbackSources: Set<string>,
  violations: Violations,
): void {
  if (!Object.hasOwn(raw, 'fallback')) return
  const fallback = raw['fallback']
  if (typeof fallback !== 'boolean') {
    violations.push({ code: 'definition/fallback-invalid', path: `${path}.fallback`, message: 'fallback must be a boolean' })
    return
  }
  if (!fallback) return
  if (condition !== null) {
    violations.push({
      code: 'definition/fallback-condition',
      path: `${path}.condition`,
      message: 'a fallback edge must not carry a condition; it is selected without evaluation',
    })
  }
  if (mode === 'multiple') {
    violations.push({
      code: 'definition/fallback-mode',
      path: `${path}.fallback`,
      message: 'fallback is only meaningful for an exclusive edge',
    })
  }
  if (from === undefined) return
  if (fallbackSources.has(from)) {
    violations.push({
      code: 'definition/multiple-fallback-edges',
      path: `${path}.fallback`,
      message: `node ${JSON.stringify(from)} already declares a fallback edge`,
    })
    return
  }
  fallbackSources.add(from)
}

/**
 * Validate the optional loop specification.
 * @param raw - the edge object.
 * @param path - document path of the edge.
 * @param from - the edge's source node id, when valid.
 * @param mode - the edge's mode, when valid.
 * @param loopSources - source nodes that already declared a loop edge.
 * @param violations - accumulator for reported violations.
 * @returns whether the edge declares a loop.
 */
function validateLoop(
  raw: Record<string, unknown>,
  path: string,
  from: string | undefined,
  mode: string | undefined,
  loopSources: Set<string>,
  violations: Violations,
): boolean {
  if (!Object.hasOwn(raw, 'loop')) return false
  const loop = raw['loop']
  if (!isJsonObject(loop)) {
    violations.push({
      code: 'definition/loop-invalid',
      path: `${path}.loop`,
      message: 'loop must be an object with maxIterations',
    })
    return true
  }
  for (const key of Object.keys(loop)) {
    if (key === 'maxIterations') continue
    violations.push({ code: 'definition/loop-invalid', path: `${path}.loop.${key}`, message: `loop field ${JSON.stringify(key)} is not supported` })
  }
  const maxIterations = loop['maxIterations']
  if (typeof maxIterations !== 'number' || !Number.isInteger(maxIterations) || maxIterations < 1) {
    violations.push({
      code: 'definition/loop-max-iterations-invalid',
      path: `${path}.loop.maxIterations`,
      message: 'loop maxIterations must be an integer of at least 1',
    })
  }
  if (mode === 'exclusive') {
    violations.push({
      code: 'definition/loop-edge-mode',
      path: `${path}.mode`,
      message: 'a loop edge must use mode "multiple"; an exclusive group cannot mix re-entry with forward selection',
    })
  }
  if (from !== undefined) {
    if (loopSources.has(from)) {
      violations.push({
        code: 'definition/multiple-loop-edges',
        path: `${path}.loop`,
        message: `node ${JSON.stringify(from)} already declares a loop edge`,
      })
    } else {
      loopSources.add(from)
    }
  }
  return true
}

/**
 * Validate one predicate tree.
 * @param raw - candidate predicate value.
 * @param path - document path of the predicate.
 * @param depth - nesting depth reached so far.
 * @param violations - accumulator for reported violations.
 */
function validatePredicate(raw: unknown, path: string, depth: number, violations: Violations): void {
  if (depth > MAX_PREDICATE_DEPTH) {
    violations.push({
      code: 'definition/condition-too-deep',
      path,
      message: `condition nesting exceeds the supported depth of ${MAX_PREDICATE_DEPTH}`,
    })
    return
  }
  if (!isJsonObject(raw)) {
    violations.push({ code: 'definition/condition-invalid', path, message: 'a condition must be a JSON object' })
    return
  }
  const op = raw['op']
  if (op === 'and' || op === 'or') {
    validateCombinator(raw, op, path, depth, violations)
    return
  }
  if (op === 'not') {
    if (!Object.hasOwn(raw, 'arg')) {
      violations.push({ code: 'definition/condition-args-invalid', path: `${path}.arg`, message: '"not" requires an arg predicate' })
      return
    }
    validatePredicate(raw['arg'], `${path}.arg`, depth + 1, violations)
    return
  }
  if (typeof op !== 'string') {
    violations.push({ code: 'definition/condition-invalid', path: `${path}.op`, message: 'a condition must declare an op' })
    return
  }
  validateFieldPredicate(raw, op, path, violations)
}

/**
 * Validate a combinator predicate's argument list.
 * @param raw - the predicate object.
 * @param op - `and` or `or`.
 * @param path - document path of the predicate.
 * @param depth - nesting depth reached so far.
 * @param violations - accumulator for reported violations.
 */
function validateCombinator(
  raw: Record<string, unknown>,
  op: 'and' | 'or',
  path: string,
  depth: number,
  violations: Violations,
): void {
  const args = raw['args']
  if (!Array.isArray(args) || args.length === 0) {
    violations.push({
      code: 'definition/condition-args-invalid',
      path: `${path}.args`,
      message: `"${op}" requires a non-empty args array of predicates`,
    })
    return
  }
  for (const [index, arg] of args.entries()) validatePredicate(arg, `${path}.args[${index}]`, depth + 1, violations)
}

/**
 * Validate a field comparison predicate.
 * @param raw - the predicate object.
 * @param op - the declared operator name.
 * @param path - document path of the predicate.
 * @param violations - accumulator for reported violations.
 */
function validateFieldPredicate(raw: Record<string, unknown>, op: string, path: string, violations: Violations): void {
  if (!FIELD_OPS.has(op)) {
    violations.push({
      code: 'definition/condition-invalid',
      path: `${path}.op`,
      message: `unknown condition op ${JSON.stringify(op)}`,
    })
    return
  }
  const field = raw['field']
  if (typeof field !== 'string' || parseFieldPath(field) === undefined) {
    violations.push({
      code: 'definition/condition-field-invalid',
      path: `${path}.field`,
      message: 'a condition field must be a dot-separated path such as "review.passed"',
    })
  }
  const value = raw['value']
  if (Object.hasOwn(raw, 'value')) validateConditionValue(op, value, path, violations)
  else if (op !== 'exists' && op !== 'truthy') {
    violations.push({
      code: 'definition/condition-value-invalid',
      path,
      message: `condition op ${JSON.stringify(op)} requires a value`,
    })
  }
}

/**
 * Validate the operand of one field comparison.
 * @param op - the declared field operator.
 * @param value - the raw operand.
 * @param path - document path of the predicate.
 * @param violations - accumulator for reported violations.
 */
function validateConditionValue(op: string, value: unknown, path: string, violations: Violations): void {
  if (op === 'exists' || op === 'truthy') {
    violations.push({
      code: 'definition/condition-value-invalid',
      path: `${path}.value`,
      message: `condition op ${JSON.stringify(op)} takes no value`,
    })
    return
  }
  if (op === 'in' || op === 'not-in') {
    if (!Array.isArray(value) || !value.every(item => isJsonScalar(item))) {
      violations.push({
        code: 'definition/condition-value-invalid',
        path: `${path}.value`,
        message: `condition op ${JSON.stringify(op)} requires an array of JSON scalars`,
      })
    }
    return
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      violations.push({
        code: 'definition/condition-value-invalid',
        path: `${path}.value`,
        message: `condition op ${JSON.stringify(op)} requires a finite number`,
      })
    }
    return
  }
  if (!isJsonScalar(value)) {
    violations.push({
      code: 'definition/condition-value-invalid',
      path: `${path}.value`,
      message: 'an equality condition value must be a JSON scalar',
    })
  }
}

/**
 * Validate graph-level rules: entry node, reachability, acyclicity, loop back
 * edges, join eligibility, and input provenance.
 * @param nodes - decoded nodes in document order.
 * @param edges - decoded edges in document order.
 * @param violations - accumulator for reported violations.
 */
function validateGraph(nodes: readonly NodeView[], edges: readonly EdgeView[], violations: Violations): void {
  const ids = nodes.flatMap(node => (node.id === undefined ? [] : [node.id]))
  const incoming = countIncoming(edges)
  const order = topologicalOrder(ids, edges)
  const entries = ids.filter(id => !incoming.has(id))
  if (entries.length === 0) {
    violations.push({ code: 'definition/no-entry-node', path: 'nodes', message: 'the graph has no entry node; every node has an incoming edge' })
  } else if (entries.length > 1) {
    violations.push({
      code: 'definition/multiple-entry-nodes',
      path: 'nodes',
      message: `the graph has ${entries.length} entry nodes (${entries.map(id => JSON.stringify(id)).join(', ')}); exactly one node must have no incoming edge`,
    })
  }
  reportUnreachableNodes(nodes, incoming, entries[0], edges, violations)
  const acyclic = order.length === ids.length
  if (!acyclic) {
    const cyclic = ids.filter(id => !order.includes(id))
    violations.push({
      code: 'definition/graph-cycle',
      path: 'edges',
      message: `nodes ${cyclic.map(id => JSON.stringify(id)).join(', ')} take part in a cycle that is not a loop edge`,
    })
  }
  reportJoinPolicies(nodes, incoming, violations)
  if (!acyclic) return
  const ancestors = computeAncestors(order, edges)
  for (const edge of edges) {
    if (!edge.loop || edge.from === undefined || edge.to === undefined) continue
    if (isAncestor(ancestors, edge.from, edge.to)) continue
    violations.push({
      code: 'definition/loop-target-not-ancestor',
      path: `${edge.path}.to`,
      message: `loop target ${JSON.stringify(edge.to)} is not an ancestor of ${JSON.stringify(edge.from)}`,
    })
  }
  for (const node of nodes) {
    if (node.id === undefined) continue
    for (const input of node.inputs) {
      if (input.sourceKind !== 'node' || input.reference === undefined) continue
      if (isAncestor(ancestors, node.id, input.reference)) continue
      violations.push({
        code: 'definition/input-node-not-ancestor',
        path: `${input.path}.source.nodeId`,
        message: `input source ${JSON.stringify(input.reference)} is not an ancestor of ${JSON.stringify(node.id)}`,
      })
    }
  }
}

/**
 * Count incoming edges per node id, keeping only ids that have at least one.
 * @param edges - decoded edges in document order.
 * @returns incoming edge counts for nodes with an incoming edge.
 */
function countIncoming(edges: readonly EdgeView[]): Map<string, number> {
  const incoming = new Map<string, number>()
  for (const edge of edges) {
    if (edge.from === undefined || edge.to === undefined) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }
  return incoming
}

/**
 * List the forward (non-loop) parents of one node id.
 * @param edges - decoded edges in document order.
 * @param id - the node id whose parents are collected.
 * @returns parent node ids in document order.
 */
function forwardParents(edges: readonly EdgeView[], id: string): string[] {
  const parents: string[] = []
  for (const edge of edges) {
    if (edge.loop || edge.to !== id || edge.from === undefined) continue
    parents.push(edge.from)
  }
  return parents
}

/**
 * Report nodes that the single entry node cannot reach.
 * @param nodes - decoded nodes in document order.
 * @param incoming - incoming edge counts, only for nodes that have an incoming edge.
 * @param entry - the entry node id, when the graph has exactly one candidate.
 * @param edges - decoded edges in document order.
 * @param violations - accumulator for reported violations.
 */
function reportUnreachableNodes(
  nodes: readonly NodeView[],
  incoming: ReadonlyMap<string, number>,
  entry: string | undefined,
  edges: readonly EdgeView[],
  violations: Violations,
): void {
  if (entry === undefined) return
  const reachable = new Set<string>([entry])
  const queue = [entry]
  for (const current of queue) {
    for (const edge of edges) {
      if (edge.from !== current || edge.to === undefined) continue
      if (reachable.has(edge.to)) continue
      reachable.add(edge.to)
      queue.push(edge.to)
    }
  }
  for (const node of nodes) {
    if (node.id === undefined || reachable.has(node.id)) continue
    if (!incoming.has(node.id)) continue
    violations.push({
      code: 'definition/unreachable-node',
      path: node.path,
      message: `node ${JSON.stringify(node.id)} is not reachable from the entry node`,
    })
  }
}

/**
 * Report `first-success` policies on nodes with fewer than two incoming edges.
 * @param nodes - decoded nodes in document order.
 * @param incoming - incoming edge counts, only for nodes that have an incoming edge.
 * @param violations - accumulator for reported violations.
 */
function reportJoinPolicies(
  nodes: readonly NodeView[],
  incoming: ReadonlyMap<string, number>,
  violations: Violations,
): void {
  for (const node of nodes) {
    if (node.id === undefined || node.join !== 'first-success') continue
    if ((incoming.get(node.id) ?? 0) >= 2) continue
    violations.push({
      code: 'definition/join-first-success-degree',
      path: `${node.path}.join`,
      message: `node ${JSON.stringify(node.id)} selects first-success but has fewer than two incoming edges`,
    })
  }
}

/**
 * Order the acyclic part of the graph parents-first. Nodes still waiting on an
 * unplaced parent when the scan stalls are the cycle members.
 * @param ids - every declared node id.
 * @param edges - decoded edges in document order.
 * @returns ids in topological order; a cyclic graph returns the acyclic prefix only.
 */
function topologicalOrder(ids: readonly string[], edges: readonly EdgeView[]): string[] {
  const pending = ids.map(id => ({ id, parents: forwardParents(edges, id), placed: false }))
  const placed = new Set<string>()
  const order: string[] = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const entry of pending) {
      if (entry.placed) continue
      if (!entry.parents.every(parent => placed.has(parent))) continue
      entry.placed = true
      placed.add(entry.id)
      order.push(entry.id)
      progressed = true
    }
  }
  return order
}

/**
 * Collect every ancestor of every node, following forward edges.
 * @param order - node ids in topological order.
 * @param edges - decoded edges in document order.
 * @returns ancestor ids per node id; a node without ancestors has no entry.
 */
function computeAncestors(order: readonly string[], edges: readonly EdgeView[]): Map<string, ReadonlySet<string>> {
  const ancestors = new Map<string, ReadonlySet<string>>()
  for (const id of order) {
    const collected = new Set<string>()
    for (const parent of forwardParents(edges, id)) {
      collected.add(parent)
      for (const ancestor of ancestors.get(parent) ?? EMPTY_ANCESTORS) collected.add(ancestor)
    }
    if (collected.size > 0) ancestors.set(id, collected)
  }
  return ancestors
}

/**
 * Whether one node id is an ancestor of another.
 * @param ancestors - ancestor ids per node id.
 * @param nodeId - the node whose ancestors are searched.
 * @param candidate - the possible ancestor.
 * @returns true only when `candidate` is a recorded ancestor of `nodeId`.
 */
function isAncestor(
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  nodeId: string,
  candidate: string,
): boolean {
  const set = ancestors.get(nodeId)
  return set !== undefined && set.has(candidate)
}

/**
 * Describe a value's JSON form for a diagnostic message.
 * @param value - any value.
 * @returns a short type description, quoting scalars.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  switch (typeof value) {
    case 'object': return 'an object'
    case 'string': return JSON.stringify(value)
    case 'number':
    case 'boolean': return String(value)
    default: return typeof value
  }
}
