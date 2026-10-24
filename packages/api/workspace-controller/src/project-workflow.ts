/**
 * Projections the `projects` Remote namespace serves to the workbench: a stored
 * definition document reduced to the nodes and violations the inspector
 * renders, the writable part of one node, and the decision and attempt rows the
 * canvas and the results tab list.
 *
 * The workflow packages own the graph model and the scheduler owns runs, so
 * everything here is a reduction of their values, never a second copy of their
 * rules. The one write this module performs — `applyNodePatch` — mutates the
 * parsed document and leaves title and tool validation to the definition
 * validator, so an edit the scheduler would refuse never reaches storage.
 *
 * @module @metaworkflow/api-workspace-controller/project-workflow
 */

import type { DefinitionViolation, WorkflowDefinition, WorkflowNode } from '@metaworkflow/workflow-definition'
import type { ProjectNodePatch } from './types.ts'
import type {
  ProjectNodeInputView,
  ProjectNodeView,
  ProjectPendingDecisionView,
} from './types.ts'
import type { DecisionRecord } from '@metaworkflow/workflow-project-store'

/**
 * Project one input binding as the inspector lists it.
 * @param binding - the node's declared input.
 * @returns the input name and the source it reads.
 */
function inputView(binding: WorkflowNode['inputs'][number]): ProjectNodeInputView {
  const { source } = binding
  switch (source.kind) {
    case 'node':
      return { name: binding.name, kind: 'node', ref: source.nodeId, field: source.field }
    case 'run':
      return { name: binding.name, kind: 'run', ref: source.key, field: '' }
    case 'artifact':
      return { name: binding.name, kind: 'artifact', ref: source.name, field: '' }
  }
}

/**
 * Project one definition node for the inspector.
 * @param node - the stored node.
 * @returns its title, kind-specific configuration, tools, and inputs.
 */
export function nodeView(node: WorkflowNode): ProjectNodeView {
  const inputs = node.inputs.map(inputView)
  if (node.config.kind === 'agent') {
    return {
      id: node.id,
      title: node.title,
      kind: 'agent',
      source: null,
      instructions: node.config.instructions,
      memory: node.config.memory,
      outputSchema: JSON.stringify(node.config.outputSchema, null, 2),
      tools: [...node.config.tools],
      inputs,
      join: node.join,
    }
  }
  return {
    id: node.id,
    title: node.title,
    kind: 'python',
    source: node.config.source,
    instructions: null,
    memory: null,
    outputSchema: null,
    tools: [],
    inputs,
    join: node.join,
  }
}

/**
 * Project one stored definition for the inspector.
 * @param definition - the parsed document.
 * @returns every node in document order.
 */
export function nodeViews(definition: WorkflowDefinition): ProjectNodeView[] {
  return definition.nodes.map(nodeView)
}

/**
 * Reduce one validator violation to the copy the inspector renders.
 * @param violation - the validator's report.
 * @returns its code, document path, and message.
 */
export function violationView(violation: DefinitionViolation): {
  readonly code: string
  readonly path: string
  readonly message: string
} {
  return { code: violation.code, path: violation.path, message: violation.message }
}

/**
 * Apply one node edit to a parsed definition.
 *
 * Only the title and the tool list are writable: instructions, source, schema,
 * inputs, and edges belong to the project coordinator's own edits, and
 * accepting them through an inspector write would let a stale form overwrite a
 * concurrent change.
 * @param definition - the parsed definition to copy.
 * @param node - the stored node the patch addresses.
 * @param patch - the fields to replace; an omitted field keeps its stored value.
 * @returns the definition with that node replaced.
 */
export function patchNode(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  patch: ProjectNodePatch,
): WorkflowDefinition {
  const titled = patch.title === undefined ? node : { ...node, title: patch.title }
  const patched = patch.tools === undefined || titled.config.kind !== 'agent'
    ? titled
    : { ...titled, config: { ...titled.config, tools: [...patch.tools] } }
  return {
    ...definition,
    nodes: definition.nodes.map(candidate => (candidate.id === node.id ? patched : candidate)),
  }
}

/**
 * Project one recorded decision request for the workbench.
 * @param record - the stored request.
 * @returns the question and the run and node waiting on it.
 */
export function pendingDecisionView(record: DecisionRecord): ProjectPendingDecisionView {
  return {
    requestId: record.requestId,
    runId: record.runId,
    nodeId: record.nodeId,
    question: record.payload.question,
    options: record.payload.options === undefined ? [] : [...record.payload.options],
    createdAt: record.createdAt,
  }
}
