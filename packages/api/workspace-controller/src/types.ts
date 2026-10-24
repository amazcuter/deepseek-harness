/**
 * Browser-safe request, result, and state-stream vocabulary for the Workspace
 * and directory-picking Remote namespaces this package owns. The picking seam
 * declares its own listing types, so they are re-exported here rather than
 * restated: a browser consumer reads the very declaration the backend answers.
 */

import type { SessionId } from '@metaworkflow/session/types'
import type { SessionActivity, WorkspaceId } from '@metaworkflow/workspace/types'

export type { WorkspaceId } from '@metaworkflow/workspace/types'
export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap,
} from '@metaworkflow/workspace/types'
export type { DirectoryEntry, DirectoryListing } from '@metaworkflow/host-directory-picker/types'

/** One durable Workspace projected for browser consumers. */
export interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  /** Canonical host directory path. */
  readonly path: string
  /** User-visible title. */
  readonly title: string
  /** Sessions accounted to this Workspace in manual order. */
  readonly sessionIds: readonly SessionId[]
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

declare module '@metaworkflow/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested directory cannot back a Workspace. */
    'workspace/invalid-path': { readonly path: string }
    /** Another Workspace already uses the requested name. */
    'workspace/name-conflict': { readonly name: string }
    /**
     * The Session still has running work — its own turn, a subagent, a
     * background job, or an active schedule — so archiving was refused
     * without a write; `activity` names what must stop first.
     */
    'workspace/session-active': {
      readonly sessionId: SessionId
      readonly activity: readonly SessionActivity[]
    }
    /** The Session or its anchor is not in the Workspace's manual order. */
    'workspace/move-invalid': {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
      readonly beforeSessionId?: SessionId
    }
    /** No registration carries that project identity. */
    'project/not-found': {}
    /** The requested directory cannot back a project. */
    'project/invalid-path': { readonly path: string }
    /** Another project already claims the requested directory. */
    'project/path-in-use': { readonly path: string }
    /** The project has no stored definition to read, run, or edit. */
    'project/definition-missing': {}
    /** The stored definition rejects execution; `violations` names every reason. */
    'project/definition-invalid': { readonly violations: readonly string[] }
    /** No node of the stored definition carries that id. */
    'project/node-not-found': { readonly nodeId: string }
    /** The project has no such run. */
    'project/run-unavailable': { readonly runId: string }
    /** No pending decision carries that request id. */
    'project/decision-unavailable': { readonly requestId: string }
    /** The Host composition serves no workflow runtime (scheduler or coordinator). */
    'project/workflow-unavailable': { readonly capability: string }
    /** The flowchart source is not a graph the importer can translate; exactly one field is present. */
    'project/mermaid-invalid': {
      /** Parser or translation refusal, located by source line when it names one. */
      readonly error?: ProjectMermaidErrorView
      /** Definition validator messages for a graph that translated but cannot run. */
      readonly violations?: readonly string[]
    }
    /** The verb needs an interaction the composed backend does not serve. */
    'directory-picker/unavailable': { readonly capability: string }
    /** The target is not fully qualified, or the backend cannot list it. */
    'directory-picker/unreadable': { readonly path: string }
    /** A child of that name is already there. */
    'directory-picker/exists': { readonly path: string }
    /** The parent is not fully qualified, the name is not one segment, or creation failed. */
    'directory-picker/create-failed': { readonly path: string }
  }
}

/** Existing directory requested for Workspace adoption. */
export interface WorkspaceCreateRequest {
  readonly path: string
}

/** Created or previously registered Workspace. */
export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

/** Workspace title mutation. */
export interface WorkspaceRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** Workspace mutation returning the complete changed row. */
export interface WorkspaceValue {
  readonly workspace: WorkspaceView
}

/** Workspace registration deletion. */
export interface WorkspaceDeleteRequest {
  readonly workspaceId: WorkspaceId
}

/** Receipt after one Workspace registration is deleted. */
export interface WorkspaceDeleteValue {
  readonly deleted: true
}

/** DOM-insertBefore-like Workspace order mutation. */
export interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}

/** Complete Workspace registry order after a mutation. */
export interface WorkspaceOrderValue {
  readonly workspaceIds: readonly WorkspaceId[]
}

/** DOM-insertBefore-like Session membership order mutation. */
export interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}

/** Session requested for archival from Workspace grouping surfaces. */
export interface WorkspaceArchiveSessionRequest {
  readonly sessionId: SessionId
  /**
   * Stop the Session's running work — its turn, subagent descendants, owned
   * background jobs, and active schedules — instead of refusing the archive
   * as `workspace/session-active`. The stops are requested before the
   * archive write and are not awaited; the response arrives once the archive
   * set is durable.
   */
  readonly stopActivity?: boolean
}

/** Session requested for restoration from the archived Session list. */
export interface WorkspaceUnarchiveSessionRequest {
  readonly sessionId: SessionId
}

/** Complete archived Session set after a mutation. */
export interface WorkspaceArchiveValue {
  readonly archivedSessionIds: readonly SessionId[]
}

/** Session requested for pinning ahead of unpinned Sessions on grouping surfaces. */
export interface WorkspacePinSessionRequest {
  readonly sessionId: SessionId
}

/** Session requested for removal from the pin set. */
export interface WorkspaceUnpinSessionRequest {
  readonly sessionId: SessionId
}

/** Complete pinned Session set after a mutation, most recently pinned first. */
export interface WorkspacePinValue {
  readonly pinnedSessionIds: readonly SessionId[]
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
  /** Registry-global pin set, most recently pinned first. */
  readonly pinnedSessionIds: readonly SessionId[]
}

/**
 * One ordered Workspace change after a generation's baseline. `replace`
 * carries the complete state that supersedes everything delivered before it
 * in the generation; it is a change, not a new generation's opening frame.
 */
export type WorkspaceFollowIncrement =
  | { readonly type: 'replace'; readonly value: WorkspaceBaseline }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly SessionId[] }

/** Workspace state stream; every generation starts with exactly one baseline. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement

/** One registered workflow project as a dashboard row. */
export interface ProjectSummary {
  /** Project identity; the same value the workspace Remote namespace calls `workspaceId`. */
  readonly id: WorkspaceId
  /** Display title owned by the project registry. */
  readonly title: string
  /** Absolute project directory. */
  readonly path: string
  /** Live directory state: `'missing-dir'` when the directory is gone, never a rename. */
  readonly status: 'ok' | 'missing-dir'
  /** Latest stored definition revision; `0` while the project has no definition. */
  readonly definitionRevision: number
  /** Sessions this project currently accounts to, filtered by the registry's header index. */
  readonly sessionCount: number
}

/** Every registered project. */
export interface ProjectListValue {
  readonly items: readonly ProjectSummary[]
}

/** Project registration request: a title plus an optional existing directory. */
export interface ProjectCreateRequest {
  readonly title: string
  /** Existing directory; omitted registers a project in the project store's own project root. */
  readonly path?: string
}

/** One mutated project. */
export interface ProjectValue {
  readonly project: ProjectSummary
}

/** Project title mutation. */
export interface ProjectRenameRequest {
  readonly id: WorkspaceId
  readonly title: string
}

/** Project address for open and remove. */
export interface ProjectTargetRequest {
  readonly id: WorkspaceId
}

/** Project deregistration receipt; the directory and every Session stay. */
export interface ProjectRemoveValue {
  readonly deleted: true
}

/** One named input binding of a definition node, as the inspector lists it. */
export interface ProjectNodeInputView {
  /** Input name the node's own code receives. */
  readonly name: string
  /** Where the value comes from. */
  readonly kind: 'node' | 'run' | 'artifact'
  /** Node id, run key, or artifact name the binding reads. */
  readonly ref: string
  /** Dot-separated field path inside a node result; empty for the other kinds. */
  readonly field: string
}

/** One executable node of a project's stored definition, projected for the inspector. */
export interface ProjectNodeView {
  /** Node id, unique within the definition. */
  readonly id: string
  readonly title: string
  readonly kind: 'python' | 'agent'
  /** Python source of a `python` node; `null` for an agent node. */
  readonly source: string | null
  /** Task instructions of an `agent` node; `null` for a python node. */
  readonly instructions: string | null
  /** Conversation policy of an `agent` node; `null` for a python node. */
  readonly memory: 'retained' | 'fresh' | null
  /** Object-rooted result schema of an `agent` node as JSON text; `null` for a python node. */
  readonly outputSchema: string | null
  /** Tool names the agent may use, in declaration order. */
  readonly tools: readonly string[]
  readonly inputs: readonly ProjectNodeInputView[]
  /** How the node waits for its incoming edges. */
  readonly join: 'all' | 'first-success'
}

/** One reason a stored definition document is not executable. */
export interface ProjectDefinitionViolationView {
  /** Stable validator code, such as `definition/node-title-empty`. */
  readonly code: string
  /** Document path the violation names; empty for a whole-document violation. */
  readonly path: string
  /** Actionable description. */
  readonly message: string
}

/** One project's stored definition as the workbench reads it. */
export interface ProjectDefinitionValue {
  /** Newest stored revision, `0` when the project has no definition. */
  readonly revision: number
  /** Stored document text, `null` when the project has no definition. */
  readonly document: string | null
  /** Whether the stored document parses and validates. */
  readonly valid: boolean
  /** Every violation that prevents execution; empty when the document is valid. */
  readonly violations: readonly ProjectDefinitionViolationView[]
  /** Nodes in document order; empty when the document does not parse. */
  readonly nodes: readonly ProjectNodeView[]
}

/** One project's coordinator Session. */
export interface ProjectCoordinatorValue {
  /**
   * Coordinator Session identity, or `null` when the Host composition serves no
   * coordinator (`ctx.mwfCoordinator` absent).
   */
  readonly sessionId: string | null
}

/** One question a node asked and the coordinator has not answered yet. */
export interface ProjectPendingDecisionView {
  /** Identity an answer is recorded against. */
  readonly requestId: string
  readonly runId: string
  /** Definition node whose attempt waits for the answer. */
  readonly nodeId: string
  readonly question: string
  /** Candidate answers the node proposed; empty when it proposed none. */
  readonly options: readonly string[]
  /** Epoch milliseconds of the request. */
  readonly createdAt: number
}

/** Every unanswered decision of one project, oldest first. */
export interface ProjectPendingDecisionsValue {
  readonly items: readonly ProjectPendingDecisionView[]
}

/** Answer to one pending decision. */
export interface ProjectAnswerDecisionRequest {
  readonly id: WorkspaceId
  readonly requestId: string
  /** The answer text the waiting node receives as its next input. */
  readonly answer: string
}

/** Receipt of one recorded answer and the run it resumed. */
export interface ProjectAnswerDecisionValue {
  readonly answered: true
  /** Run status once the resumed activation settled or the call returned. */
  readonly runStatus: string
}

/** One tool switch of a definition node. */
export interface ProjectToolView {
  /** Tool name the node's agent may use. */
  readonly name: string
  /** What the tool does, as the Host describes it. */
  readonly description: string
  /** Whether the node's current definition lists this tool. */
  readonly enabled: boolean
}

/** Every tool switch of one node. */
export interface ProjectToolsValue {
  readonly items: readonly ProjectToolView[]
}

/** Address of one definition node. */
export interface ProjectNodeTargetRequest {
  readonly id: WorkspaceId
  readonly nodeId: string
}

/** Writable part of one definition node. */
export interface ProjectNodePatch {
  /** Replacement title; a blank title is refused. */
  readonly title?: string
  /** Complete replacement tool list, in the order it should be stored. */
  readonly tools?: readonly string[]
}

/** One node edit. */
export interface ProjectUpdateNodeRequest extends ProjectNodeTargetRequest {
  readonly patch: ProjectNodePatch
}

/** Receipt of one node edit: the definition revision it was stored under. */
export interface ProjectUpdateNodeValue {
  /** Revision the patched definition was written as. */
  readonly revision: number
}

/** One attempt of the run the workbench shows. */
export interface ProjectAttemptView {
  readonly attemptId: string
  readonly activationId: string
  /** Definition node the activation runs. */
  readonly nodeId: string
  /** 1-based attempt number within its activation. */
  readonly attemptNo: number
  readonly status: string
  readonly startedAt: number
  /** When the attempt reached a terminal status; `null` while it runs. */
  readonly endedAt: number | null
  /** The failure the executor reported; `null` unless the attempt failed. */
  readonly error: string | null
}

/** One activation of the run the workbench shows. */
export interface ProjectActivationView {
  readonly activationId: string
  readonly nodeId: string
  readonly iteration: number
  readonly status: string
}

/** One run as the workbench reads it. */
export interface ProjectRunView {
  readonly runId: string
  /** Definition revision the run executes. */
  readonly definitionRevision: number
  readonly status: string
  /** Why the run reached its status, when the scheduler recorded a reason. */
  readonly reason: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly activations: readonly ProjectActivationView[]
}

/** Which run the workbench reads. */
export interface ProjectAttemptsRequest {
  readonly id: WorkspaceId
  /** Run to read; omitted reads the project's newest run. */
  readonly runId?: string
}

/** One project's newest run, or its named run, with that run's attempts. */
export interface ProjectAttemptsValue {
  /** The run read; `null` when the project has no run yet. */
  readonly run: ProjectRunView | null
  /** Attempts of that run, newest first. */
  readonly items: readonly ProjectAttemptView[]
}

/** Address of one run. */
export interface ProjectRunTargetRequest {
  readonly id: WorkspaceId
  readonly runId: string
}

/** Receipt of one run control call. */
export interface ProjectRunControlValue {
  readonly runId: string
  readonly status: string
}

/** Receipt of one run start. */
export interface ProjectRunStartValue {
  readonly runId: string
  /** Run status once the first tick returned. */
  readonly status: string
}

/** One flowchart refusal, as the import verb reports it. */
export interface ProjectMermaidErrorView {
  /** Stable parser or translation code, such as `mermaid/unsupported-syntax`. */
  readonly code: string
  /** Actionable description naming the offending source text. */
  readonly message: string
  /** 1-based source line, when the refusal names one. */
  readonly line?: number
}

/** One observation the flowchart importer made without refusing the text. */
export interface ProjectMermaidWarningView {
  /** Stable importer code, such as `mermaid/implicit-node`. */
  readonly code: string
  /** What the importer decided instead. */
  readonly message: string
}

/** One hand-written definition document written into a project. */
export interface ProjectImportDefinitionRequest {
  readonly id: WorkspaceId
  /** Definition document text; it must parse and validate before it is stored. */
  readonly document: string
}

/** Receipt of one imported definition. */
export interface ProjectImportDefinitionValue {
  /** Revision the document was stored under. */
  readonly revision: number
  /** Nodes the stored document declares. */
  readonly nodeCount: number
}

/** One Mermaid flowchart requested for import into a project. */
export interface ProjectImportMermaidRequest {
  /** Project to write into; omitted registers a new project under `title`. */
  readonly id?: WorkspaceId
  /** Title of the project to register when `id` is omitted. */
  readonly title?: string
  /** Mermaid flowchart source; only the node-and-link subset is accepted. */
  readonly mermaid: string
}

/** Receipt of one imported flowchart. */
export interface ProjectImportMermaidValue {
  /** Project the definition was written to. */
  readonly projectId: WorkspaceId
  /** The stored revision with its canonical document and its nodes, as the inspector lists them. */
  readonly definition: ProjectDefinitionValue
  /** Mermaid node id to generated definition node id. */
  readonly mapping: Readonly<Record<string, string>>
  /** Observations that adjusted the import without refusing it. */
  readonly warnings: readonly ProjectMermaidWarningView[]
}
