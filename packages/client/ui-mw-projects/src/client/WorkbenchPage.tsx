/**
 * The project workbench: the panel a project opens onto.
 *
 * Every region here is a milestone placeholder. The canvas renders no nodes
 * (the definition Remote arrives with the workflow milestone), the run
 * controls stay disabled until the scheduler exists, the node inspector shows
 * only its three empty tabs, and the coordinator conversation is static copy
 * instead of an embedded conversation. What is real is the navigation: the
 * panel reads the selected project from the dashboard snapshot, switches to
 * another registered project, and returns to the project list.
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
  SegmentedControl, SegmentedTabs, type SegmentedTab,
} from '@metaworkflow/client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@metaworkflow/client-ui-slots'
import { failureText } from './failures.ts'
import type { ProjectsKey } from './locales.ts'
import type { ProjectId, ProjectsSnapshot } from './projects.ts'
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

/** Empty-state title key per node inspector tab. */
const DETAIL_EMPTY_TITLE: Readonly<Record<NodeDetailTab, ProjectsKey>> = {
  configuration: 'workbench.detail.configuration.empty.title',
  tools: 'workbench.detail.tools.empty.title',
  results: 'workbench.detail.results.empty.title',
}

/** Empty-state description key per node inspector tab. */
const DETAIL_EMPTY_DESCRIPTION: Readonly<Record<NodeDetailTab, ProjectsKey>> = {
  configuration: 'workbench.detail.configuration.empty.description',
  tools: 'workbench.detail.tools.empty.description',
  results: 'workbench.detail.results.empty.description',
}

/** Callbacks the workbench needs from the composition that mounts it. */
export interface WorkbenchPageInjected {
  /** The dashboard snapshot, bound as the `useProjects` selector hook. */
  readonly hooks: { readonly projects: HostObservable<ProjectsSnapshot> }
  /** Open one registered project, replacing the one on screen. */
  readonly openProject: (id: ProjectId) => void
  /** Return to the project list panel. */
  readonly backToProjects: () => void
}

/** Full component props assembled by the main slot renderer. */
export type WorkbenchPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mw.projects'>
  & InjectFace<WorkbenchPageInjected>

/** The bound translator this component hands to its own sections. */
type Translate = WorkbenchPageProps['t']

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

/** The canvas placeholder and the disabled run controls of the future scheduler. */
function Canvas({ t }: { readonly t: Translate }): ReactNode {
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
          <Button variant="primary" size="sm" disabled>{t('workbench.run.start')}</Button>
          <Button variant="outline" size="sm" disabled>{t('workbench.run.pause')}</Button>
          <Button variant="outline" size="sm" disabled>{t('workbench.run.step')}</Button>
          <Button variant="outline" size="sm" disabled>{t('workbench.run.retry')}</Button>
        </div>
      </div>
      <p className={css.note} id="workbench-run-note">{t('workbench.run.note')}</p>
      <div className={css.canvasSurface}>
        <EmptyState
          title={t('workbench.canvas.empty.title')}
          description={t('workbench.canvas.empty.description')}
        />
      </div>
    </>
  )
}

/** The node inspector: three tabs, each with its own empty state. */
function NodeDetails({ t }: { readonly t: Translate }): ReactNode {
  const [tab, setTab] = useState<NodeDetailTab>('configuration')
  return (
    <>
      <h2 className={css.sectionTitle}>{t('workbench.detail.title')}</h2>
      <EmptyState
        title={t('workbench.detail.empty.title')}
        description={t('workbench.detail.empty.description')}
      />
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
          <EmptyState title={t(DETAIL_EMPTY_TITLE[value])} description={t(DETAIL_EMPTY_DESCRIPTION[value])} />
        </div>
      ))}
    </>
  )
}

/** The embedded coordinator placeholder: static copy plus a locked composer. */
function Coordinator({ t }: { readonly t: Translate }): ReactNode {
  return (
    <>
      <h2 className={css.sectionTitle}>{t('workbench.chat.title')}</h2>
      <p className={css.hint} id="workbench-chat-hint">{t('workbench.chat.hint')}</p>
      <div className={css.composer}>
        <label className={css.label} htmlFor="workbench-chat-input">{t('workbench.chat.inputLabel')}</label>
        <Input id="workbench-chat-input" disabled aria-describedby="workbench-chat-hint" />
        <Button
          className={css.send}
          variant="primary"
          size="sm"
          disabled
          aria-describedby="workbench-chat-hint"
        >
          {t('workbench.chat.send')}
        </Button>
      </div>
    </>
  )
}

/**
 * Render the project workbench.
 * @param props - the main slot shares, the dashboard snapshot hook, and the navigation callbacks.
 * @returns the workbench element tree.
 */
export function WorkbenchPage({
  t, useProjects, openProject, backToProjects,
}: WorkbenchPageProps): ReactNode {
  const snapshot = useProjects(state => state)
  const [section, setSection] = useState<WorkbenchSection>('canvas')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const project = snapshot.projects.find(entry => entry.id === snapshot.openedProjectId)

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
      {snapshot.mutationError !== null && (
        <p className={css.notice} role="status">
          <strong>{t('error.mutation.title')}</strong>
          {' '}
          {failureText(t, snapshot.mutationError)}
          {' '}
          <span className={css.errorDetail}>{snapshot.mutationError.message}</span>
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
          <Canvas t={t} />
        </section>
        <section
          id={sectionPanelId('details')}
          aria-labelledby={sectionTabId('details')}
          className={css.details}
          data-section="details"
          data-active={section === 'details' ? 'true' : 'false'}
        >
          <NodeDetails t={t} />
        </section>
        <aside
          id={sectionPanelId('chat')}
          aria-labelledby={sectionTabId('chat')}
          className={css.chat}
          data-section="chat"
          data-active={section === 'chat' ? 'true' : 'false'}
        >
          <Coordinator t={t} />
        </aside>
      </div>
    </section>
  )
}
