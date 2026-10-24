/**
 * Mermaid flowchart import vocabulary: the parsed graph, the diagnostics that
 * accompany it, and the option and result values of the translation into a
 * workflow definition.
 *
 * Types only, per the package convention. Every value here is JSON-compatible
 * except the translation options, which carry a caller-supplied builder.
 *
 * @module @metaworkflow/workflow-mermaid-import/types
 */

import type { DefinitionViolation, WorkflowDefinition } from '@metaworkflow/workflow-definition'

/** Directions a supported flowchart header may declare. */
export type MermaidDirection = 'TD' | 'LR' | 'BT' | 'RL'

/** One node the flowchart mentions, in first-mention order. */
export interface MermaidGraphNode {
  /** Mermaid node id exactly as written, such as `A` or `review_1`. */
  readonly id: string
  /** Bracketed label when the node declares one, otherwise the id itself. */
  readonly label: string
  /** 1-based source line the node was first mentioned on. */
  readonly line: number
}

/** One directed connection between two nodes, in source order. */
export interface MermaidGraphEdge {
  /** Id of the node the link leaves. */
  readonly from: string
  /** Id of the node the link enters. */
  readonly to: string
  /** Text between the link's pipes; absent for an unlabelled link. */
  readonly label?: string
  /** 1-based source line the link was written on. */
  readonly line: number
}

/** One parsed flowchart: a direction, its nodes, and its links. */
export interface MermaidFlowchartGraph {
  /** Layout direction the header declared. */
  readonly direction: MermaidDirection
  /** Nodes in first-mention order. */
  readonly nodes: readonly MermaidGraphNode[]
  /** Links in source order, repeated links included. */
  readonly edges: readonly MermaidGraphEdge[]
}

/** Stable codes the flowchart parser reports instead of a graph. */
export type MermaidParseErrorCode =
  | 'mermaid/missing-header'
  | 'mermaid/invalid-direction'
  | 'mermaid/unsupported-syntax'
  | 'mermaid/syntax-error'
  | 'mermaid/duplicate-node'

/** One parse refusal, located by source line when the parser can name it. */
export interface MermaidParseError {
  /** Stable code callers may branch on. */
  readonly code: MermaidParseErrorCode
  /** Actionable description naming the offending source text. */
  readonly message: string
  /** 1-based source line; absent when the refusal concerns the whole text. */
  readonly line?: number
}

/** Stable codes for observations that changed the graph without stopping it. */
export type MermaidWarningCode =
  | 'mermaid/implicit-node'
  | 'mermaid/label-collision'
  | 'mermaid/duplicate-edge'

/** One observation that adjusted the result without refusing it. */
export interface MermaidWarning {
  /** Stable code callers may branch on. */
  readonly code: MermaidWarningCode
  /** What the importer decided instead. */
  readonly message: string
}

/** Result of parsing one Mermaid flowchart text. */
export type MermaidParseResult =
  | {
    readonly ok: true
    /** The parsed graph, with implicit nodes created and duplicate labels merged. */
    readonly graph: MermaidFlowchartGraph
    /** Nodes the parser created because only a link mentioned them. */
    readonly warnings: readonly MermaidWarning[]
  }
  | {
    readonly ok: false
    readonly error: MermaidParseError
  }

/** Stable code the translation reports for a flowchart it cannot linearize. */
export type MermaidGraphErrorCode = 'mermaid/cycle-unsupported'

/** Refusal for a flowchart whose links form a cycle. */
export interface MermaidGraphError {
  /** Stable code callers may branch on. */
  readonly code: MermaidGraphErrorCode
  /** Which nodes close the cycle and what to do instead. */
  readonly message: string
}

/** One node, as a caller-supplied instructions builder sees it. */
export interface MermaidNodeContext {
  /** Mermaid node id the flowchart wrote. */
  readonly mermaidId: string
  /** Generated definition node id. */
  readonly id: string
  /** Node label, which also becomes the definition node title. */
  readonly label: string
}

/** Options accepted by the translation into a workflow definition. */
export interface ToDefinitionOptions {
  /**
   * Agent instructions for one node, replacing the default placeholder
   * `Complete the "<label>" step.`. Every imported node is an agent node whose
   * instructions a later editing pass or a coordinator turn replaces.
   * @param node - the mermaid id, generated id, and label of one node.
   * @returns the instructions text stored on that node.
   */
  readonly instructions?: (node: MermaidNodeContext) => string
}

/** Result of translating one parsed flowchart into a workflow definition. */
export type ToDefinitionResult =
  | {
    readonly ok: true
    /** The definition that passed `validateDefinition`. */
    readonly definition: WorkflowDefinition
    /** Mermaid node id to generated definition node id. */
    readonly mapping: Readonly<Record<string, string>>
    /** Observations that changed the result without refusing it. */
    readonly warnings: readonly MermaidWarning[]
  }
  | {
    readonly ok: false
    /** Cycle refusal, or `null` when validation rejected the translated graph. */
    readonly error: MermaidGraphError | null
    /** Every validator violation; empty for a cycle refusal. */
    readonly violations: readonly DefinitionViolation[]
  }
