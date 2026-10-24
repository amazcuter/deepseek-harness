/**
 * Pure workflow graph model for the workflow scheduler: the JSON-compatible
 * definition document, its validator, predicate routing, and join arithmetic.
 * Nothing here schedules, executes, or mounts a service.
 *
 * @module @metaworkflow/workflow-definition
 */

export { WORKFLOW_DEFINITION_VERSION, parseDefinitionDocument, serializeDefinition } from './document.ts'
export { JOIN_NOT_FIRED, computeJoin } from './join.ts'
export { canonicalJson, isJsonObject, isJsonScalar, jsonValueCategory } from './json.ts'
export type { JsonValueCategory } from './json.ts'
export { parseFieldPath, readFieldPath } from './path.ts'
export { evaluatePredicate } from './predicate.ts'
export { route } from './route.ts'
export type {
  AgentMemory,
  AgentNodeConfig,
  CombinatorOp,
  CombinatorPredicate,
  ComparisonOp,
  DefinitionParseResult,
  DefinitionViolation,
  DefinitionViolationCode,
  FieldPredicate,
  InputBinding,
  InputSource,
  JoinOutcome,
  JoinState,
  LoopSpec,
  NodeConfig,
  NotPredicate,
  Predicate,
  PredicateDiagnostic,
  PredicateDiagnosticCode,
  PredicateEvaluation,
  PredicateOp,
  PythonNodeConfig,
  RoutingDiagnostic,
  RoutingFailure,
  RoutingFailureCode,
  RoutingResult,
  ValidationResult,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEdgeMode,
  WorkflowJoinPolicy,
  WorkflowNode,
  WorkflowNodeKind,
} from './types.ts'
export { validateDefinition } from './validate.ts'
