/**
 * Workflow definition vocabulary: the JSON-compatible document a project
 * stores, its node and edge records, and the values exchanged by the
 * validator, predicate router, and join arithmetic.
 *
 * Types only, per the package convention. Every structure here is
 * JSON-compatible so a definition document survives storage as text.
 *
 * @module @metaworkflow/workflow-definition/types
 */

import type { JsonSchemaNode } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'

/** The two kinds of executable node the scheduler understands. */
export type WorkflowNodeKind = 'python' | 'agent'

/**
 * How a node waits for its incoming edges. `all` waits for every activated
 * incoming edge; `first-success` fires on the first successful one.
 */
export type WorkflowJoinPolicy = 'all' | 'first-success'

/**
 * How a node's outgoing edges are selected. `exclusive` selects exactly one
 * edge; `multiple` returns every matching edge.
 */
export type WorkflowEdgeMode = 'exclusive' | 'multiple'

/**
 * Whether an agent node keeps conversation history from its previous
 * activation in the same run.
 */
export type AgentMemory = 'retained' | 'fresh'

/** A Python node: one generated function whose JSON return value is the result. */
export interface PythonNodeConfig {
  /** Config discriminant, always equal to the owning node's `kind`. */
  readonly kind: 'python'
  /** Python source text containing the node entry function `nodemain_<nodeId>`. */
  readonly source: string
}

/** A node's expected result: an object-rooted schema from the shared enforced subset. */
export interface AgentNodeConfig {
  /** Config discriminant, always equal to the owning node's `kind`. */
  readonly kind: 'agent'
  /** Object-rooted schema the agent result is expected to satisfy. */
  readonly outputSchema: JsonSchemaNode
  /** Task instructions sent to the agent. */
  readonly instructions: string
  /** Tool names the agent may use; empty means no tools. */
  readonly tools: readonly string[]
  /** Whether the agent resumes its previous conversation in this run. */
  readonly memory: AgentMemory
}

/** One node's kind-specific configuration. */
export type NodeConfig = PythonNodeConfig | AgentNodeConfig

/** Where one node input comes from. */
export type InputSource =
  | {
    /** Reads a field of an ancestor node's JSON result. */
    readonly kind: 'node'
    /** Id of the producing ancestor node. */
    readonly nodeId: string
    /** Dot-separated field path inside that result, such as `review.passed`. */
    readonly field: string
  }
  | {
    /** Reads a run-scoped value supplied when the run started. */
    readonly kind: 'run'
    /** Non-empty key into the run input object. */
    readonly key: string
  }
  | {
    /** Reads a named artifact produced earlier in the run. */
    readonly kind: 'artifact'
    /** Non-empty artifact name. */
    readonly name: string
  }

/** One named node input and its source. */
export interface InputBinding {
  /** Input name the node's own code receives. */
  readonly name: string
  /** Where the value comes from. */
  readonly source: InputSource
}

/** One executable node. */
export interface WorkflowNode {
  /** Unique node id matching `^[a-z][a-z0-9_-]*$`. */
  readonly id: string
  /** Executable kind; must equal `config.kind`. */
  readonly kind: WorkflowNodeKind
  /** Human-readable title shown in listings. */
  readonly title: string
  /** Kind-specific configuration. */
  readonly config: NodeConfig
  /** Named inputs bound to ancestor results, run inputs, or artifacts. */
  readonly inputs: readonly InputBinding[]
  /** How the node waits for incoming edges. */
  readonly join: WorkflowJoinPolicy
}

/** Comparison operators a predicate can apply to one field. */
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not-in' | 'exists' | 'truthy'

/** Boolean operators combining nested predicates. */
export type CombinatorOp = 'and' | 'or'

/** Every operator a predicate can carry. */
export type PredicateOp = ComparisonOp | CombinatorOp | 'not'

/** A comparison against one dot-separated field of the result value. */
export interface FieldPredicate {
  /** The comparison operator. */
  readonly op: ComparisonOp
  /** Dot-separated field path read from the result; never evaluated as code. */
  readonly field: string
  /** Comparison operand; absent for `exists` and `truthy`, an array for `in`/`not-in`. */
  readonly value?: JsonValue
}

/** A conjunction or disjunction of nested predicates. */
export interface CombinatorPredicate {
  /** `and` matches when every argument matches; `or` matches when one does. */
  readonly op: CombinatorOp
  /** Nested predicates; never empty. */
  readonly args: readonly Predicate[]
}

/** Negation of one nested predicate. */
export interface NotPredicate {
  /** The negation operator. */
  readonly op: 'not'
  /** The predicate to negate. */
  readonly arg: Predicate
}

/** A condition attached to an edge; combinators nest the field comparisons. */
export type Predicate = FieldPredicate | CombinatorPredicate | NotPredicate

/** Bounds on how many times a loop edge may re-enter its target. */
export interface LoopSpec {
  /** Maximum activations, at least 1; the scheduler owns the counter. */
  readonly maxIterations: number
}

/** One directed edge between two nodes. */
export interface WorkflowEdge {
  /** Unique edge id matching `^[a-z][a-z0-9_-]*$`. */
  readonly id: string
  /** Source node id. */
  readonly from: string
  /** Target node id. */
  readonly to: string
  /** Condition gating activation; `null` activates unconditionally. */
  readonly condition: Predicate | null
  /** Selection semantics shared by every outgoing edge of one node. */
  readonly mode: WorkflowEdgeMode
  /**
   * Exclusive-mode fallback: selected when no conditional edge matches. A
   * fallback edge carries no condition, and one node has at most one.
   */
  readonly fallback?: boolean
  /** Present when this edge re-enters an ancestor; absent for forward edges. */
  readonly loop?: LoopSpec
}

/** One JSON-compatible workflow document. */
export interface WorkflowDefinition {
  /** Document format version; only `1` is accepted. */
  readonly version: 1
  /** Executable nodes in document order. */
  readonly nodes: readonly WorkflowNode[]
  /** Directed edges in document order. */
  readonly edges: readonly WorkflowEdge[]
}

/** Stable violation codes reported by the definition validator. */
export type DefinitionViolationCode =
  | 'definition/document-invalid-json'
  | 'definition/document-invalid'
  | 'definition/version-unsupported'
  | 'definition/nodes-invalid'
  | 'definition/edges-invalid'
  | 'definition/node-invalid'
  | 'definition/node-id-invalid'
  | 'definition/duplicate-node'
  | 'definition/node-kind-invalid'
  | 'definition/node-title-empty'
  | 'definition/node-config-invalid'
  | 'definition/node-config-kind-mismatch'
  | 'definition/node-join-invalid'
  | 'definition/node-inputs-invalid'
  | 'definition/duplicate-input'
  | 'definition/input-name-invalid'
  | 'definition/input-source-invalid'
  | 'definition/input-node-not-ancestor'
  | 'definition/input-field-invalid'
  | 'definition/run-key-empty'
  | 'definition/artifact-name-empty'
  | 'definition/python-source-empty'
  | 'definition/python-entry-missing'
  | 'definition/agent-instructions-empty'
  | 'definition/agent-tools-invalid'
  | 'definition/agent-memory-invalid'
  | 'definition/schema-invalid'
  | 'definition/schema-root-not-object'
  | 'definition/schema-unsupported'
  | 'definition/condition-invalid'
  | 'definition/condition-field-invalid'
  | 'definition/condition-value-invalid'
  | 'definition/condition-args-invalid'
  | 'definition/condition-too-deep'
  | 'definition/edge-invalid'
  | 'definition/edge-id-invalid'
  | 'definition/duplicate-edge'
  | 'definition/edge-endpoint-missing'
  | 'definition/edge-mode-invalid'
  | 'definition/self-loop'
  | 'definition/fallback-invalid'
  | 'definition/fallback-condition'
  | 'definition/fallback-mode'
  | 'definition/multiple-fallback-edges'
  | 'definition/loop-invalid'
  | 'definition/loop-max-iterations-invalid'
  | 'definition/loop-edge-mode'
  | 'definition/loop-target-not-ancestor'
  | 'definition/multiple-loop-edges'
  | 'definition/mixed-edge-modes'
  | 'definition/no-entry-node'
  | 'definition/multiple-entry-nodes'
  | 'definition/unreachable-node'
  | 'definition/graph-cycle'
  | 'definition/join-first-success-degree'

/** One rule violation, located by a document path such as `edges[2].condition`. */
export interface DefinitionViolation {
  /** Stable code callers may branch on. */
  readonly code: DefinitionViolationCode
  /** Document path to the offending value; empty for the whole document. */
  readonly path: string
  /** Human-readable description of the rule that failed. */
  readonly message: string
}

/** Result of validating one candidate workflow document. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly DefinitionViolation[] }

/** Result of parsing and validating one stored definition document. */
export type DefinitionParseResult =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly violations: readonly DefinitionViolation[] }

/** Stable diagnostic codes a predicate evaluation can report. */
export type PredicateDiagnosticCode = 'predicate/field-missing' | 'predicate/type-mismatch' | 'predicate/value-missing'

/** One observed reason why a predicate could not be a plain true/false comparison. */
export interface PredicateDiagnostic {
  /** Stable diagnostic code. */
  readonly code: PredicateDiagnosticCode
  /** Dot-separated field path the diagnosis concerns; empty for a missing operand. */
  readonly field: string
  /** Human-readable explanation. */
  readonly message: string
}

/** Outcome of evaluating one edge condition against a node result. */
export interface PredicateEvaluation {
  /** Whether the predicate matched; every incomparable case evaluates false. */
  readonly matched: boolean
  /** Observed incomparabilities, in evaluation order. */
  readonly diagnostics: readonly PredicateDiagnostic[]
}

/** One diagnostic attached to the edge whose condition reported it. */
export interface RoutingDiagnostic extends PredicateDiagnostic {
  /** Id of the edge whose condition observed the diagnosis. */
  readonly edgeId: string
}

/** Stable routing failure codes. */
export type RoutingFailureCode = 'routing/no-match' | 'routing/ambiguous'

/** Why routing could not select a well-defined target set. */
export interface RoutingFailure {
  /** Stable failure code. */
  readonly code: RoutingFailureCode
  /** Id of the node whose outgoing edges were routed. */
  readonly nodeId: string
  /** Human-readable explanation. */
  readonly message: string
  /** Edge ids that caused the failure; empty when nothing matched. */
  readonly candidates: readonly string[]
}

/** Selected targets of one routing decision. */
export interface RoutingResult {
  /** Target node ids in activation order, without duplicates. */
  readonly targets: readonly string[]
  /** Activated edge ids in the same order, one per activated edge. */
  readonly edgeIds: readonly string[]
  /** How many of the activated edges were loop edges. */
  readonly iterationDelta: number
  /** Diagnostics from every evaluated condition. */
  readonly diagnostics: readonly RoutingDiagnostic[]
  /** Routing failure, or `null` when targets were selected. */
  readonly failure: RoutingFailure | null
}

/** Retained join progress handed back to the next {@link computeJoin} call. */
export interface JoinState {
  /** Whether this activation already fired. */
  readonly fired: boolean
}

/** Outcome of one join evaluation. */
export interface JoinOutcome {
  /** Whether the target node should be scheduled now. */
  readonly fire: boolean
  /** Incoming node ids this evaluation accounted for. */
  readonly consumed: readonly string[]
  /** Activated incoming node ids that have not completed yet. */
  readonly pending: readonly string[]
  /** Progress to pass to the next evaluation of this activation. */
  readonly state: JoinState
}
