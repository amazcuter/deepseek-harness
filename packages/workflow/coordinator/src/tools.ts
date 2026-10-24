/**
 * The coordinator's model-facing tools: answer one waiting decision, list the
 * questions still waiting, and report the project's runs and activations.
 *
 * Every tool closes over one project's store and scheduler, so the coordinator
 * Session of a project can only answer that project's decisions. The tools are
 * registered in that Session's scope, which is what keeps them out of a node's
 * own tool allow list.
 *
 * @module @metaworkflow/workflow-coordinator/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'
import type ProjectStore from '@metaworkflow/workflow-project-store'
import type { DecisionRecord, ProjectId } from '@metaworkflow/workflow-project-store'
import type Scheduler from '@metaworkflow/workflow-scheduler'
import type { CoordinatorProjectState, DecisionAnsweredInfo } from './types.ts'

/** Model-facing name of the tool that answers one waiting decision. */
export const ANSWER_DECISION_TOOL_NAME = 'answer_decision'

/** Model-facing name of the tool that lists every waiting decision. */
export const LIST_DECISIONS_TOOL_NAME = 'list_pending_decisions'

/** Model-facing name of the tool that reports the project's state. */
export const PROJECT_STATE_TOOL_NAME = 'get_project_state'

/** What the coordinator's tools read and write for one project. */
export interface CoordinatorToolDeps {
  /** Project whose coordinator Session registers these tools. */
  readonly projectId: ProjectId
  /** Store that owns the decision rows. */
  readonly store: ProjectStore
  /** Scheduler that resumes the activation a decision wakes. */
  readonly scheduler: Scheduler
  /**
   * Announce one recorded answer to host observers.
   * @param info - the answered decision and the run it resumes.
   */
  announce(info: DecisionAnsweredInfo): void
}

/**
 * One pending decision as the coordinator's tools report it: the question in
 * the form the answering tool documents, without the attempt bookkeeping a
 * model never acts on.
 * @param record - the stored request.
 * @returns the pending summary.
 */
function pendingSummary(record: DecisionRecord): {
  readonly requestId: string
  readonly runId: string
  readonly nodeId: string
  readonly question: string
  readonly options?: string[]
  readonly detail?: JsonValue
  readonly createdAt: number
} {
  const { payload } = record
  return {
    requestId: record.requestId,
    runId: record.runId,
    nodeId: record.nodeId,
    question: payload.question,
    ...payload.options === undefined ? {} : { options: [...payload.options] },
    ...payload.detail === undefined ? {} : { detail: payload.detail },
    createdAt: record.createdAt,
  }
}

/**
 * The model-facing text of one pending decision.
 * @param decision - the pending summary.
 * @returns one bullet naming the question, its run, and its node.
 */
function pendingLine(decision: ReturnType<typeof pendingSummary>): string {
  const choices = decision.options === undefined ? '' : ` (options: ${decision.options.join(', ')})`
  return `- ${decision.requestId} — node "${decision.nodeId}", run ${decision.runId}: ${decision.question}${choices}`
}

/**
 * Register the coordinator's tools in one project Session's scope.
 * @param agentCtx - the coordinator Agent's scope context, during its creation window.
 * @param deps - the project, its store, its scheduler, and the answer announcer.
 * @returns nothing; every registration belongs to the coordinator Session's scope.
 */
export function registerCoordinatorTools(agentCtx: Context, deps: CoordinatorToolDeps): void {
  agentCtx.tools.register(defineTool({
    name: ANSWER_DECISION_TOOL_NAME,
    description:
      'Answer one pending decision request from a waiting workflow node. Supply the request id '
      + 'from list_pending_decisions and the answer that node needs; the node resumes with your answer '
      + 'as its next input. A request can be answered once: a repeated call reports the recorded answer '
      + 'instead of changing what the node received.',
    parameters: {
      requestId: {
        type: 'string',
        required: true,
        description: 'The request id a waiting decision reports.',
      },
      answer: {
        type: 'json',
        required: true,
        description: 'The answer the waiting node continues with. Prefer one of the options the node proposed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', required: true },
          nodeId: { type: 'string', required: true },
          runId: { type: 'string', required: true },
          activationId: { type: 'string', required: true },
          runStatus: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Answered decision ${value.requestId} for node "${value.nodeId}"; its run is now ${value.runStatus}.`,
      }],
    },
    async execute(args) {
      const outcome = await deps.store.answerDecision(deps.projectId, args.requestId, args.answer)
      if (outcome.kind === 'unknown') {
        throw new Error(`this project records no decision request "${args.requestId}"`)
      }
      if (outcome.kind === 'already-answered') {
        throw new Error(
          `decision "${args.requestId}" was already answered at ${String(outcome.decision.answeredAt)}; `
          + 'the waiting node received that answer and a second one is not applied',
        )
      }
      const { decision } = outcome
      const resumed = await deps.scheduler.resumeActivation({
        projectId: deps.projectId,
        runId: decision.runId,
        activationId: decision.activationId,
        decision: args.answer,
      })
      deps.announce({
        projectId: deps.projectId,
        runId: decision.runId,
        activationId: decision.activationId,
        requestId: decision.requestId,
        answer: args.answer,
        runStatus: resumed.status,
      })
      return {
        requestId: decision.requestId,
        nodeId: decision.nodeId,
        runId: decision.runId,
        activationId: decision.activationId,
        runStatus: resumed.status,
      }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: LIST_DECISIONS_TOOL_NAME,
    description:
      'List every decision request this project is still waiting on, oldest first, with the question '
      + 'each node asked and the options it proposed. Answer one with answer_decision.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decisions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requestId: { type: 'string', required: true },
                runId: { type: 'string', required: true },
                nodeId: { type: 'string', required: true },
                question: { type: 'string', required: true },
                options: { type: 'array', items: { type: 'string' } },
                detail: { type: 'json' },
                createdAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.decisions.length === 0
          ? 'No decision requests are waiting in this project.'
          : value.decisions.map(decision => pendingLine(decision)).join('\n'),
      }],
    },
    async execute() {
      const pending = await deps.store.listPendingDecisions(deps.projectId)
      return { decisions: pending.map(record => pendingSummary(record)) }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: PROJECT_STATE_TOOL_NAME,
    description:
      'Report this project\'s workflow state: its working directory, every run with its status and reason, '
      + 'and the activations of the newest run with the attempts recorded for each.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          runs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                reason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              },
            },
          },
          activations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                activationId: { type: 'string', required: true },
                nodeId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                attempts: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Project "${value.title}" at ${value.path} (${value.projectId}).`,
          value.runs.length === 0 ? 'No run has started yet.' : 'Runs, newest first:',
          ...value.runs.map(run => `- ${run.runId}: ${run.status}${run.reason === null ? '' : ` (${run.reason})`}`),
          ...value.activations.map(activation => `- ${activation.nodeId} [${activation.activationId}]: ${activation.status}, ${String(activation.attempts)} attempt(s)`),
        ].join('\n'),
      }],
    },
    async execute(): Promise<CoordinatorProjectState> {
      const project = await deps.store.openProject(deps.projectId)
      const runs = await deps.store.listRuns(deps.projectId)
      const newest = runs[0]
      const activations = newest === undefined
        ? []
        : await deps.scheduler.listActivations({ projectId: deps.projectId, runId: newest.runId })
      const attempts = newest === undefined
        ? []
        : await deps.scheduler.listAttempts({ projectId: deps.projectId, runId: newest.runId })
      return {
        projectId: project.id,
        title: project.title,
        path: project.path,
        runs: runs.map(run => ({
          runId: run.runId,
          status: run.status,
          reason: run.reason,
        })),
        activations: activations.map(activation => ({
          activationId: activation.activationId,
          nodeId: activation.nodeId,
          status: activation.status,
          attempts: attempts.filter(attempt => attempt.activationId === activation.activationId).length,
        })),
      }
    },
  }))
}
