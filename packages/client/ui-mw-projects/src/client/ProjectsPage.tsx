/**
 * The MetaWorkFlow home panel: an empty state that starts the first project,
 * or the project list with one row per independent workflow. Narrow frames
 * collapse the row grid to one column and label each cell from its
 * `data-label`, so the list stays readable without horizontal scrolling.
 */
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { Button } from '@metaworkflow/client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@metaworkflow/client-ui-slots'
import type { ProjectsKey } from './locales.ts'
import type { ProjectId, ProjectStatus, ProjectSummary, createProjectsStore } from './projects.ts'
import css from './ProjectsPage.module.css'

/** Status label key per lifecycle state. */
const STATUS_KEY: Readonly<Record<ProjectStatus, ProjectsKey>> = {
  draft: 'status.draft',
  active: 'status.active',
  paused: 'status.paused',
  done: 'status.done',
}

/** Status tone class per lifecycle state. */
const STATUS_CLASS = {
  draft: css.statusDraft,
  active: css.statusActive,
  paused: css.statusPaused,
  done: css.statusDone,
} as const

/** Callbacks the dashboard needs from the composition that mounts it. */
export interface ProjectsPageInjected {
  /** Start a new empty project from the empty-state primary action. */
  readonly createProject: () => void
  /** Start a project from an imported Mermaid flowchart. */
  readonly importMermaid: () => void
  /** Open one listed project. */
  readonly openProject: (id: ProjectId) => void
}

/** Full component props assembled by the main slot renderer. */
export type ProjectsPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mw.projects'>
  & PropsStore<ReturnType<typeof createProjectsStore>>
  & InjectFace<ProjectsPageInjected>

/** The bound translator this component hands to its own sections. */
type Translate = ProjectsPageProps['t']

/** Both ways to start the first project, before any row exists. */
function EmptyState({ t, createProject, importMermaid }: {
  readonly t: Translate
  readonly createProject: ProjectsPageInjected['createProject']
  readonly importMermaid: ProjectsPageInjected['importMermaid']
}): ReactNode {
  return (
    <section className={css.empty} aria-label={t('dashboard.empty.title')}>
      <h2 className={css.emptyTitle}>{t('dashboard.empty.title')}</h2>
      <p className={css.emptyDescription}>{t('dashboard.empty.description')}</p>
      <div className={css.emptyActions}>
        <Button variant="primary" onClick={createProject}>{t('dashboard.create')}</Button>
        <Button variant="outline" onClick={importMermaid}>{t('dashboard.import')}</Button>
      </div>
    </section>
  )
}

/** The project list: a column header row plus one row per project. */
function ProjectList({ t, projects, openedProjectId, openProject }: {
  readonly t: Translate
  readonly projects: readonly ProjectSummary[]
  readonly openedProjectId: ProjectId | null
  readonly openProject: ProjectsPageInjected['openProject']
}): ReactNode {
  return (
    <ul className={css.list} aria-label={t('dashboard.listCaption')}>
      <li className={css.listHeader} aria-hidden="true">
        <span className={css.headerCell}>{t('column.name')}</span>
        <span className={css.headerCell}>{t('column.purpose')}</span>
        <span className={css.headerCell}>{t('column.status')}</span>
        <span className={css.headerCell}>{t('column.actions')}</span>
      </li>
      {projects.map(project => (
        <li
          key={project.id}
          className={clsx(css.row, project.id === openedProjectId && css.rowOpened)}
          aria-current={project.id === openedProjectId ? 'true' : undefined}
        >
          <span className={css.nameCell} data-label={t('column.name')}>{project.name}</span>
          <span className={css.purposeCell} data-label={t('column.purpose')}>{project.purpose}</span>
          <span className={css.statusCell} data-label={t('column.status')}>
            <span className={clsx(css.status, STATUS_CLASS[project.status])}>{t(STATUS_KEY[project.status])}</span>
          </span>
          <span className={css.actionCell} data-label={t('column.actions')}>
            <Button
              size="sm"
              variant="outline"
              aria-label={t('action.openLabel', { name: project.name })}
              onClick={() => { openProject(project.id) }}
            >
              {t('action.open')}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Render the project dashboard.
 * @param props - the main slot shares plus the composition's project callbacks.
 * @returns the dashboard element tree.
 */
export function ProjectsPage({
  t, useStore, createProject, importMermaid, openProject,
}: ProjectsPageProps): ReactNode {
  const projects = useStore(state => state.projects)
  const openedProjectId = useStore(state => state.openedProjectId)
  const body = projects.length === 0
    ? <EmptyState t={t} createProject={createProject} importMermaid={importMermaid} />
    : <ProjectList t={t} projects={projects} openedProjectId={openedProjectId} openProject={openProject} />
  return (
    <section className={css.page} aria-label={t('dashboard.title')}>
      <header className={css.header}>
        <h1 className={css.title}>{t('dashboard.title')}</h1>
        {projects.length > 0 && (
          <div className={css.actions}>
            <Button variant="primary" onClick={createProject}>{t('dashboard.create')}</Button>
            <Button variant="outline" onClick={importMermaid}>{t('dashboard.import')}</Button>
          </div>
        )}
      </header>
      <p className={css.description}>{t('dashboard.description')}</p>
      {body}
    </section>
  )
}
