/**
 * The project workbench: the panel a project opens onto.
 *
 * Every region reads the Host. The canvas lists the nodes of the project's
 * newest stored definition and drives the run controls; the inspector shows one
 * selected node across its three tabs — its configuration (with a writable
 * title), its tool switches, and its input bindings with the attempts recorded
 * for the newest run; the coordinator column shows the decisions the project
 * waits on and hosts the project's coordinator Session as an embedded
 * Conversation.
 *
 * A wide frame lays the canvas and the inspector in the middle column with the
 * coordinator beside them. A narrow frame collapses to one column, where the
 * segmented control and the section's `data-active` marker decide which of the
 * three sections is visible, so the three columns never squeeze into each
 * other.
 */
import { useState, type ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, Input, Menu, MenuItemButton,
  SegmentedControl, SegmentedTabs, Switch, type SegmentedTab,
} from '@metaworkflow/client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@metaworkflow/client-ui-slots'
import type { ProjectNodeView } from '@metaworkflow/api-workspace-controller/types'
import { failureText } from './failures.ts'
import type { ProjectsKey } from './locales.ts'
import type { ProjectId, ProjectsSnapshot } from './projects.ts'
import type { WorkbenchSnapshot } from './workbench.ts'
import css from './WorkbenchPage.module.css'

/** The three workbench views a narrow frame switches between. */
type WorkbenchSection = 'canvas' | 'details' | 'chat'

/** The node inspector's tabs. */
type NodeDetailTab = 'configuration' | 'tools' | 'results'

/** Base id of the narrow-frame segmented control; its tabs and panels derive from it. */
const SECTION_CONTROL_ID = 'workbench-section'

/** Base id of the node inspector's tab list; its tabs and panels derive from it. */
const DETAIL_TAB_BASE_ID = 'workbench-node'

/** Workbench sections in display order. */
const SECTIONS: readonly WorkbenchSection[] = ['canvas', 'details', 'chat']

/** Node inspector tabs in display order. */
const DETAIL_TAB_ORDER: readonly NodeDetailTab[] = ['configuration', 'tools', 'results']

/** Segment copy key per workbench section. */
const SECTION_LABEL: Readonly<Record<WorkbenchSection, ProjectsKey>> = {
  canvas: 'workbench.section.canvas',
  details: 'workbench.section.details',
  chat: 'workbench.section.chat',
}

/** Tab copy key per node inspector tab. */
const DETAIL_TAB_LABEL: Readonly<Record<NodeDetailTab, ProjectsKey>> = {
  configuration: 'workbench.detail.tab.configuration',
  tools: 'workbench.detail.tab.tools',
  results: 'workbench.detail.tab.results',
}

/** One label per status an activation or attempt can carry. */
const STATE_LABEL: Readonly<Record<string, ProjectsKey>> = {
  pending: 'workbench.nodeState.pending',
  running: 'workbench.nodeState.running',
  waiting: 'workbench.nodeState.waiting',
  succeeded: 'workbench.nodeState.succeeded',
  failed: 'workbench.nodeState.failed',
  canceled: 'workbench.nodeState.canceled',
  interrupted: 'workbench.attemptState.interrupted',
}

/** One label per status a run can carry. */
const RUN_STATE_LABEL: Readonly<Record<string, ProjectsKey>> = {
  pending: 'workbench.runState.pending',
  running: 'workbench.runState.running',
  paused: 'workbench.runState.paused',
  succeeded: 'workbench.runState.succeeded',
  failed: 'workbench.runState.failed',
  canceled: 'workbench.runState.canceled',
}

/** Callbacks the workbench needs from the composition that mounts it. */
export interface WorkbenchPageInjected {
  /** The dashboard and workbench snapshots, bound as `useProjects` and `useWorkbench`. */
  readonly hooks: {
    readonly projects: HostObservable<ProjectsSnapshot>
    readonly workbench: HostObservable<WorkbenchSnapshot>
  }
  /** Open one registered project, replacing the one on screen. */
  readonly openProject: (id: ProjectId) => void
  /** Return to the project list panel. */
  readonly backToProjects: () => void
  /** Select one node in the inspector. */
  readonly selectNode: (nodeId: string) => void
  /** Replace one node's title through the Host. */
  readonly saveNodeTitle: (nodeId: string, title: string) => void
  /** Add or remove one tool from a node's list. */
  readonly toggleTool: (nodeId: string, name: string, enabled: boolean) => void
  /** Start a run from the newest stored definition. */
  readonly startRun: () => void
  /** Pause the run the workbench shows. */
  readonly pauseRun: () => void
  /** Resume the paused run the workbench shows. */
  readonly resumeRun: () => void
  /** Answer one pending decision. */
  readonly answerDecision: (requestId: string, answer: string) => void
  /** Re-read the open project's definition, decisions, and run. */
  readonly refreshWorkbench: () => void
  /** Show one coordinator Session in the shared conversation panel. */
  readonly openCoordinator: (sessionId: string) => void
}

/** Full component props assembled by the main slot renderer. */
export type WorkbenchPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mw.projects'>
  & InjectFace<WorkbenchPageInjected>

/** The bound translator this component hands to its own sections. */
type Translate = WorkbenchPageProps['t']

/** The callbacks once the hook compartment is bound away. */
type WorkbenchActions = Omit<WorkbenchPageInjected, 'hooks'>

/**
 * @param section - one workbench section.
 * @returns the id its narrow-frame segment names.
 */
function sectionTabId(section: WorkbenchSection): string {
  return `${SECTION_CONTROL_ID}-${section}`
}

/**
 * @param section - one workbench section.
 * @returns the id of the section element the segment controls.
 */
function sectionPanelId(section: WorkbenchSection): string {
  return `${sectionTabId(section)}-panel`
}

/**
 * @param t - the panel's translator.
 * @param value - one node inspector tab.
 * @returns that tab's labelled tab-strip entry, paired with its panel id.
 */
function detailTabItem(t: Translate, value: NodeDetailTab): SegmentedTab<NodeDetailTab> {
  return {
    value,
    label: t(DETAIL_TAB_LABEL[value]),
    id: `${DETAIL_TAB_BASE_ID}-${value}-tab`,
    panelId: `${DETAIL_TAB_BASE_ID}-${value}-panel`,
  }
}

/**
 * @param t - the panel's translator.
 * @param status - a status the Host reported.
 * @returns its localized label, or the raw status when the vocabulary is newer than this panel.
 */
function stateLabel(t: Translate, status: string): string {
  const key = STATE_LABEL[status]
  return key === undefined ? status : t(key)
}

/**
 * @param t - the panel's translator.
 * @param status - a run status the Host reported.
 * @returns its localized label, or the raw status when the vocabulary is newer than this panel.
 */
function runStateLabel(t: Translate, status: string): string {
  const key = RUN_STATE_LABEL[status]
  return key === undefined ? status : t(key)
}

/** The one-line empty state shared by the canvas and the node inspector. */
function EmptyState({ title, description }: {
  readonly title: string
  readonly description: string
}): ReactNode {
  return (
    <div className={css.empty}>
      <p className={css.emptyTitle}>{title}</p>
      <p className={css.emptyDescription}>{description}</p>
    </div>
  )
}

/** One labelled read-only field of the configuration tab. */
function Field({ label, children }: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <div className={css.fieldValue}>{children}</div>
    </div>
  )
}

/** One block of read-only source text or JSON. */
function Source({ label, text }: { readonly label: string; readonly text: string }): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <pre className={css.source}>{text}</pre>
    </div>
  )
}

/**
 * @param snapshot - the workbench state.
 * @param node - one node of the stored definition.
 * @returns the status of that node's newest activation, or `idle`.
 */
function nodeStatus(snapshot: WorkbenchSnapshot, node: { readonly id: string }): string {
  const activations = snapshot.run?.activations ?? []
  const latest = activations.filter(activation => activation.nodeId === node.id).at(-1)
  return latest?.status ?? 'idle'
}

/** The canvas: the node list of the stored definition and the run controls. */
function Canvas({
  t, snapshot, disabled, startRun, pauseRun, resumeRun, selectNode,
}: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'startRun' | 'pauseRun' | 'resumeRun' | 'selectNode'>): ReactNode {
  const { definition, run } = snapshot
  const runnable = definition.valid && definition.nodes.length > 0
  const paused = run?.status === 'paused'
  const runNote = runnable ? t('workbench.run.note') : t('workbench.run.unavailable')
  return (
    <>
      <div className={css.sectionHead}>
        <h2 className={css.sectionTitle}>{t('workbench.canvas.title')}</h2>
        <div
          className={css.runControls}
          role="group"
          aria-label={t('workbench.run.group')}
          aria-describedby="workbench-run-note"
        >
          <Button variant="primary" size="sm" disabled={disabled || !runnable} onClick={startRun}>
            {t('workbench.run.start')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || run === null || paused || !runnable}
            onClick={pauseRun}
          >
            {t('workbench.run.pause')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !paused}
            onClick={resumeRun}
          >
            {t('workbench.run.resume')}
          </Button>
        </div>
      </div>
      <p className={css.note} id="workbench-run-note">{runNote}</p>
      <p className={css.note} data-run-status={run?.status ?? 'none'}>
        {run === null
          ? t('workbench.run.none')
          : `${t('workbench.run.status', { status: runStateLabel(t, run.status) })} · ${t('workbench.canvas.revision', { revision: run.definitionRevision })}`}
      </p>
      {run?.reason != null && (
        <p className={css.note}>{t('workbench.run.reason', { reason: run.reason })}</p>
      )}
      {!definition.valid && definition.violations.length > 0 && (
        <ul className={css.violations} aria-label={t('workbench.canvas.invalid')}>
          {definition.violations.map(violation => (
            <li key={`${violation.code}:${violation.path}`} className={css.violation}>
              <span className={css.violationCode}>{violation.code}</span>
              {' '}
              {violation.message}
            </li>
          ))}
        </ul>
      )}
      <div className={css.canvasSurface}>
        {definition.nodes.length === 0
          ? (
            <EmptyState
              title={t('workbench.canvas.empty.title')}
              description={t('workbench.canvas.empty.description')}
            />
          )
          : (
            <ul className={css.nodeList} aria-label={t('workbench.canvas.nodes')}>
              {definition.nodes.map(node => (
                <li key={node.id}>
                  <button
                    type="button"
                    className={css.nodeRow}
                    data-node-id={node.id}
                    data-status={nodeStatus(snapshot, node)}
                    aria-pressed={snapshot.selectedNodeId === node.id}
                    aria-label={t('workbench.canvas.selectNode', { name: node.title })}
                    onClick={() => { selectNode(node.id) }}
                  >
                    <span className={css.nodeTitle}>{node.title}</span>
                    <span className={css.nodeKind}>{node.kind}</span>
                    <span className={css.nodeState}>{stateLabel(t, nodeStatus(snapshot, node))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </>
  )
}

/** The configuration tab: the writable title plus every read-only field of the node. */
function ConfigurationTab({
  t, node, disabled, saveNodeTitle,
}: {
  readonly t: Translate
  readonly node: ProjectNodeView
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'saveNodeTitle'>): ReactNode {
  const [draft, setDraft] = useState(node.title)
  const dirty = draft.trim() !== '' && draft.trim() !== node.title
  return (
    <>
      <div className={css.titleRow}>
        <label className={css.fieldLabel} htmlFor="workbench-node-title">
          {t('workbench.detail.field.title')}
        </label>
        <Input
          id="workbench-node-title"
          value={draft}
          disabled={disabled}
          aria-label={t('workbench.detail.titleLabel', { name: node.title })}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => { saveNodeTitle(node.id, draft.trim()) }}
        >
          {t('action.save')}
        </Button>
      </div>
      <Field label={t('workbench.detail.field.kind')}>
        {t(node.kind === 'agent' ? 'workbench.detail.kind.agent' : 'workbench.detail.kind.python')}
      </Field>
      {node.instructions !== null && <Source label={t('workbench.detail.field.instructions')} text={node.instructions} />}
      {node.source !== null && <Source label={t('workbench.detail.field.source')} text={node.source} />}
      {node.memory !== null && (
        <Field label={t('workbench.detail.field.memory')}>
          {t(node.memory === 'retained' ? 'workbench.detail.memory.retained' : 'workbench.detail.memory.fresh')}
        </Field>
      )}
      {node.outputSchema !== null && <Source label={t('workbench.detail.field.outputSchema')} text={node.outputSchema} />}
      <Field label={t('workbench.detail.field.join')}>
        {t(node.join === 'all' ? 'workbench.detail.join.all' : 'workbench.detail.join.first-success')}
      </Field>
      <p className={css.note}>{t('workbench.detail.readOnly')}</p>
    </>
  )
}

/** The tools tab: one switch per tool the Host registers, plus the node's own entries. */
function ToolsTab({
  t, snapshot, disabled, toggleTool,
}: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'toggleTool'>): ReactNode {
  const selected = snapshot.definition.nodes.find(node => node.id === snapshot.selectedNodeId)
  if (selected === undefined || selected.kind !== 'agent') {
    return (
      <EmptyState
        title={t('workbench.detail.tools.empty.title')}
        description={t('workbench.detail.tools.empty.description')}
      />
    )
  }
  if (snapshot.tools.status === 'loading') {
    return <p className={css.note} role="status">{t('workbench.detail.tools.loading')}</p>
  }
  return (
    <ul className={css.toolList}>
      {snapshot.tools.items.map(tool => (
        <li key={tool.name} className={css.toolRow}>
          <div className={css.toolText}>
            <span className={css.toolName}>{tool.name}</span>
            {tool.description !== '' && <span className={css.toolDescription}>{tool.description}</span>}
            {tool.description === '' && (
              <span className={css.toolDescription}>{t('workbench.detail.tools.unregistered')}</span>
            )}
          </div>
          <Switch
            checked={tool.enabled}
            disabled={disabled}
            label={t('workbench.detail.tools.switchLabel', { name: tool.name })}
            onChange={(next) => { toggleTool(selected.id, tool.name, next) }}
          />
        </li>
      ))}
    </ul>
  )
}

/** One input binding as localized copy. */
function inputText(t: Translate, input: ProjectNodeView['inputs'][number]): string {
  switch (input.kind) {
    case 'node':
      return t('workbench.detail.results.inputFrom', { node: input.ref, field: input.field })
    case 'run':
      return t('workbench.detail.results.inputRun', { key: input.ref })
    case 'artifact':
      return t('workbench.detail.results.inputArtifact', { name: input.ref })
  }
}

/** The results tab: input bindings, the output schema, and every attempt of the newest run. */
function ResultsTab({ t, snapshot }: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
}): ReactNode {
  const node = snapshot.definition.nodes.find(candidate => candidate.id === snapshot.selectedNodeId)
  if (node === undefined) {
    return (
      <EmptyState
        title={t('workbench.detail.results.empty.title')}
        description={t('workbench.detail.results.empty.description')}
      />
    )
  }
  const attempts = snapshot.attempts.filter(attempt => attempt.nodeId === node.id)
  return (
    <>
      <h3 className={css.subTitle}>{t('workbench.detail.results.inputs')}</h3>
      {node.inputs.length === 0
        ? <p className={css.note}>{t('workbench.detail.results.inputsEmpty')}</p>
        : (
          <ul className={css.inputList}>
            {node.inputs.map(input => (
              <li key={input.name} className={css.inputRow}>
                <span className={css.inputName}>{input.name}</span>
                <span className={css.inputSource}>{inputText(t, input)}</span>
              </li>
            ))}
          </ul>
        )}
      {node.outputSchema !== null && (
        <Source label={t('workbench.detail.field.outputSchema')} text={node.outputSchema} />
      )}
      <h3 className={css.subTitle}>{t('workbench.detail.results.attempts')}</h3>
      {attempts.length === 0
        ? <p className={css.note}>{t('workbench.detail.results.attemptsEmpty')}</p>
        : (
          <ul className={css.attemptList}>
            {attempts.map(attempt => (
              <li key={attempt.attemptId} className={css.attemptRow} data-attempt-status={attempt.status}>
                <span className={css.attemptTitle}>
                  {t('workbench.detail.results.attempt', { n: attempt.attemptNo })}
                </span>
                <span className={css.attemptState}>{stateLabel(t, attempt.status)}</span>
                {attempt.error !== null && (
                  <span className={css.attemptError}>
                    {t('workbench.detail.results.attemptError', { message: attempt.error })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
    </>
  )
}

/** The node inspector: the selected node across its three tabs. */
function NodeDetails({
  t, snapshot, disabled, saveNodeTitle, toggleTool,
}: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'saveNodeTitle' | 'toggleTool'>): ReactNode {
  const [tab, setTab] = useState<NodeDetailTab>('configuration')
  const node = snapshot.definition.nodes.find(candidate => candidate.id === snapshot.selectedNodeId)
  return (
    <>
      <h2 className={css.sectionTitle}>{t('workbench.detail.title')}</h2>
      {snapshot.definition.status === 'loading' && (
        <p className={css.note} role="status">{t('workbench.detail.loading')}</p>
      )}
      {node === undefined
        ? (
          <EmptyState
            title={t('workbench.detail.empty.title')}
            description={t('workbench.detail.empty.description')}
          />
        )
        : <p className={css.nodeHeading}>{node.title}</p>}
      <SegmentedTabs<NodeDetailTab>
        className={css.detailTabs}
        label={t('workbench.detail.tabs')}
        value={tab}
        onChange={setTab}
        items={[
          detailTabItem(t, 'configuration'),
          detailTabItem(t, 'tools'),
          detailTabItem(t, 'results'),
        ]}
      />
      {DETAIL_TAB_ORDER.map(value => (
        <div
          key={value}
          id={`${DETAIL_TAB_BASE_ID}-${value}-panel`}
          role="tabpanel"
          aria-labelledby={`${DETAIL_TAB_BASE_ID}-${value}-tab`}
          className={css.tabPanel}
          data-node-tab={value}
          hidden={tab !== value}
          tabIndex={0}
        >
          {value === 'configuration' && (node === undefined
            ? (
              <EmptyState
                title={t('workbench.detail.configuration.empty.title')}
                description={t('workbench.detail.configuration.empty.description')}
              />
            )
            : (
              <ConfigurationTab
                key={node.id}
                t={t}
                node={node}
                disabled={disabled}
                saveNodeTitle={saveNodeTitle}
              />
            ))}
          {value === 'tools' && (
            <ToolsTab t={t} snapshot={snapshot} disabled={disabled} toggleTool={toggleTool} />
          )}
          {value === 'results' && <ResultsTab t={t} snapshot={snapshot} />}
        </div>
      ))}
    </>
  )
}

/** One pending decision with its quick-reply field. */
function DecisionCard({
  t, decision, disabled, answerDecision,
}: {
  readonly t: Translate
  readonly decision: WorkbenchSnapshot['decisions'][number]
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'answerDecision'>): ReactNode {
  const [answer, setAnswer] = useState('')
  const reply = answer.trim()
  return (
    <li className={css.decision}>
      <p className={css.decisionNode}>{t('workbench.decisions.node', { name: decision.nodeId })}</p>
      <p className={css.decisionQuestion}>{decision.question}</p>
      {decision.options.length > 0 && (
        <ul className={css.optionList}>
          {decision.options.map(option => (
            <li key={option}>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => { answerDecision(decision.requestId, option) }}
              >
                {option}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={css.answerRow}>
        <Input
          value={answer}
          disabled={disabled}
          placeholder={t('workbench.decisions.answerPlaceholder')}
          aria-label={t('workbench.decisions.answerLabel', { question: decision.question })}
          onChange={(event) => { setAnswer(event.target.value) }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || reply === ''}
          onClick={() => { answerDecision(decision.requestId, reply) }}
        >
          {t('workbench.decisions.send')}
        </Button>
      </div>
    </li>
  )
}

/** The decisions the project waits on, with a manual refresh. */
function Decisions({
  t, snapshot, disabled, answerDecision, refreshWorkbench,
}: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'answerDecision' | 'refreshWorkbench'>): ReactNode {
  return (
    <section className={css.decisions} aria-label={t('workbench.decisions.title')}>
      <div className={css.sectionHead}>
        <h3 className={css.subTitle}>{t('workbench.decisions.title')}</h3>
        <Button variant="outline" size="sm" disabled={disabled} onClick={refreshWorkbench}>
          {t('workbench.decisions.refresh')}
        </Button>
      </div>
      {snapshot.decisions.length === 0
        ? <p className={css.note}>{t('workbench.decisions.empty')}</p>
        : (
          <ul className={css.decisionList}>
            {snapshot.decisions.map(decision => (
              <DecisionCard
                key={decision.requestId}
                t={t}
                decision={decision}
                disabled={disabled}
                answerDecision={answerDecision}
              />
            ))}
          </ul>
        )}
    </section>
  )
}

/** The coordinator column: the pending decisions above the way into the coordinator Session. */
function Coordinator({
  t, snapshot, disabled, answerDecision, refreshWorkbench, openCoordinator,
}: {
  readonly t: Translate
  readonly snapshot: WorkbenchSnapshot
  readonly disabled: boolean
} & Pick<WorkbenchActions, 'answerDecision' | 'refreshWorkbench' | 'openCoordinator'>): ReactNode {
  const sessionId = snapshot.coordinator.sessionId
  return (
    <>
      <h2 className={css.sectionTitle}>{t('workbench.chat.title')}</h2>
      <Decisions
        t={t}
        snapshot={snapshot}
        disabled={disabled}
        answerDecision={answerDecision}
        refreshWorkbench={refreshWorkbench}
      />
      {snapshot.coordinator.status === 'loading'
        ? <p className={css.hint} role="status">{t('workbench.chat.loading')}</p>
        : sessionId === null
          ? <p className={css.hint}>{t('workbench.chat.unavailable')}</p>
          : (
            <div className={css.chatActions}>
              <p className={css.hint}>{t('workbench.chat.openHint')}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => { openCoordinator(sessionId) }}
              >
                {t('workbench.chat.open')}
              </Button>
            </div>
          )}
    </>
  )
}

/**
 * Render the project workbench.
 * @param props - the main slot shares, both snapshots, and the workbench callbacks.
 * @returns the workbench element tree.
 */
export function WorkbenchPage({
  t, useProjects, useWorkbench, openProject, backToProjects,
  selectNode, saveNodeTitle, toggleTool, startRun, pauseRun, resumeRun,
  answerDecision, refreshWorkbench, openCoordinator,
}: WorkbenchPageProps): ReactNode {
  const snapshot = useProjects(state => state)
  const workbench = useWorkbench(state => state)
  const [section, setSection] = useState<WorkbenchSection>('canvas')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const project = snapshot.projects.find(entry => entry.id === snapshot.openedProjectId)
  const disabled = workbench.busy
  const shownFailure = snapshot.mutationError ?? workbench.failure

  if (project === undefined) {
    return (
      <section className={css.page} aria-label={t('workbench.title')}>
        <EmptyState title={t('workbench.empty.title')} description={t('workbench.empty.description')} />
        <div className={css.emptyActions}>
          <Button variant="primary" onClick={backToProjects}>{t('workbench.back')}</Button>
        </div>
      </section>
    )
  }

  return (
    <section className={css.page} aria-label={t('workbench.title')}>
      <header className={css.header}>
        <Button variant="outline" size="sm" onClick={backToProjects}>{t('workbench.back')}</Button>
        <div className={css.identity}>
          <h1 className={css.title}>{project.title}</h1>
          <span className={css.path}>{project.path}</span>
        </div>
        <Menu
          open={switcherOpen}
          onClose={() => { setSwitcherOpen(false) }}
          align="end"
          portal
          anchor={(
            <Button
              variant="outline"
              size="sm"
              aria-haspopup="menu"
              aria-expanded={switcherOpen}
              aria-label={t('workbench.switchLabel')}
              disabled={snapshot.busy}
              onClick={() => { setSwitcherOpen(open => !open) }}
            >
              {t('workbench.switch')}
              <IconChevronDownOutlineRegular size={16} />
            </Button>
          )}
        >
          {snapshot.projects.map(entry => (
            <MenuItemButton
              key={entry.id}
              icon={entry.id === project.id ? <IconCheckOutlineRegular size={16} /> : undefined}
              onSelect={() => {
                setSwitcherOpen(false)
                openProject(entry.id)
              }}
            >
              {entry.title}
            </MenuItemButton>
          ))}
        </Menu>
      </header>
      {shownFailure !== null && (
        <p className={css.notice} role="status">
          <strong>{t('error.mutation.title')}</strong>
          {' '}
          {failureText(t, shownFailure)}
          {' '}
          <span className={css.errorDetail}>{shownFailure.message}</span>
        </p>
      )}
      <div className={css.sections}>
        <SegmentedControl<WorkbenchSection>
          id={SECTION_CONTROL_ID}
          label={t('workbench.sections')}
          value={section}
          onChange={setSection}
          options={SECTIONS.map(value => ({ value, label: t(SECTION_LABEL[value]) }))}
        />
      </div>
      <div className={css.grid}>
        <section
          id={sectionPanelId('canvas')}
          aria-labelledby={sectionTabId('canvas')}
          className={css.canvas}
          data-section="canvas"
          data-active={section === 'canvas' ? 'true' : 'false'}
        >
          <Canvas
            t={t}
            snapshot={workbench}
            disabled={disabled}
            startRun={startRun}
            pauseRun={pauseRun}
            resumeRun={resumeRun}
            selectNode={selectNode}
          />
        </section>
        <section
          id={sectionPanelId('details')}
          aria-labelledby={sectionTabId('details')}
          className={css.details}
          data-section="details"
          data-active={section === 'details' ? 'true' : 'false'}
        >
          <NodeDetails
            t={t}
            snapshot={workbench}
            disabled={disabled}
            saveNodeTitle={saveNodeTitle}
            toggleTool={toggleTool}
          />
        </section>
        <aside
          id={sectionPanelId('chat')}
          aria-labelledby={sectionTabId('chat')}
          className={css.chat}
          data-section="chat"
          data-active={section === 'chat' ? 'true' : 'false'}
        >
          <Coordinator
            t={t}
            snapshot={workbench}
            disabled={disabled}
            answerDecision={answerDecision}
            refreshWorkbench={refreshWorkbench}
            openCoordinator={openCoordinator}
          />
        </aside>
      </div>
    </section>
  )
}
