/**
 * Mermaid flowchart import for workflow projects: parse the step-and-arrow
 * subset of a flowchart into a graph, then translate that graph into a workflow
 * definition the validator accepts.
 *
 * The package is pure: it reads text, returns JSON-compatible values, mounts no
 * service, and parses Mermaid itself instead of depending on it.
 *
 * @module @metaworkflow/workflow-mermaid-import
 */

export { toDefinition } from './definition.ts'
export { parseMermaidFlowchart } from './parse.ts'
export type {
  MermaidDirection,
  MermaidFlowchartGraph,
  MermaidGraphEdge,
  MermaidGraphError,
  MermaidGraphErrorCode,
  MermaidGraphNode,
  MermaidNodeContext,
  MermaidParseError,
  MermaidParseErrorCode,
  MermaidParseResult,
  MermaidWarning,
  MermaidWarningCode,
  ToDefinitionOptions,
  ToDefinitionResult,
} from './types.ts'
