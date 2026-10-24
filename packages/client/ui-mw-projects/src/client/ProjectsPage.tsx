/**
 * The MetaWorkFlow home panel: the registered workflow projects, one card per
 * project, with the loading skeleton, the empty state, and the retryable load
 * failure. A row renames inline and confirms a delete in place; a narrow frame
 * collapses each card to a single column.
 *
 * Every row is Host data read through the injected `useProjects` hook. The
 * local state is which row the user is renaming or asked to confirm, and whether
 * the Mermaid import dialog is open; the import itself, including its refusal,
 * is Host state the panel reads back.
 */
import { clsx } from 'clsx'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input } from '@metaworkflow/client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@metaworkflow/client-ui-slots'
import { failureText } from './failures.ts'
import { ImportDialog } from './ImportDialog.tsx'
import type { ProjectsKey } from './locales.ts'
import type {
  ImportDraft, ProjectFailure, ProjectId, ProjectStatus, ProjectSummary, ProjectsSnapshot,
} from './projects.ts'
import css from './ProjectsPage.module.css'

/** Status label key per directory state. */
const STATUS_KEY: Readonly<Record<ProjectStatus, ProjectsKey>> = {
  'ok': 'status.ok',
  'missing-dir': 'status.missing-dir',
}

/** Status tone class per directory state. */
const STATUS_CLASS: Readonly<Record<ProjectStatus, string | undefined>> = {
  'ok': css.statusOk,
  'missing-dir': css.statusMissing,
}

/** Callbacks the dashboard needs from the composition that mounts it. */
export interface ProjectsPageInjected {
  /** Host project snapshot, bound as the `useProjects` selector hook. */
  readonly hooks: { readonly projects: HostObservable<ProjectsSnapshot> }
  /** Register a new project under `title`. */
  readonly createProject: (title: string) => void
  /** Rename one listed project. */
  readonly renameProject: (id: ProjectId, title: string) => void
  /** Deregister one listed project; its directory and Sessions stay. */
  readonly removeProject: (id: ProjectId) => void
  /** Open one listed project on the Host. */
  readonly openProject: (id: ProjectId) => void
  /** Reload the list after a load failure. */
  readonly reloadProjects: () => void
  /** Forget the last flowchart import, so a reopened dialog starts clean. */
  readonly resetImport: () => void
  /** Import one flowchart as a new project's definition. */
  readonly importMermaid: (draft: ImportDraft) => void
}

/** The injected callbacks once the hook compartment is bound away. */
type ProjectsActions = Omit<ProjectsPageInjected, 'hooks'>

/** The callbacks the dashboard body renders rows with; the import dialog owns its own two. */
type ProjectListActions = Omit<ProjectsActions, 'resetImport' | 'importMermaid'>

/** Full component props assembled by the main slot renderer. */
export type ProjectsPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mw.projects'>
  & InjectFace<ProjectsPageInjected>

/** The bound translator this component hands to its own sections. */
type Translate = ProjectsPageProps['t']

/** The row being renamed and the draft name typed into it. */
interface RenameDraft {
  readonly id: ProjectId
  readonly title: string
}

/**
 * @param view - the current list state.
 * @returns the untranslated state the switch could not classify.
 */
/* v8 ignore next 3 -- closed view union; the store publishes only these three states */
function assertNever(view: never): never {
  throw new Error(`unreachable project list state: ${JSON.stringify(view)}`)
}

/** Placeholder cards while the first list load is in flight. */
function ProjectsSkeleton({ t }: { readonly t: Translate }): ReactNode {
  return (
    <div className={css.skeleton} role="status" aria-busy="true" aria-label={t('dashboard.loading')}>
      <span className={css.skeletonRow} aria-hidden="true" />
      <span className={css.skeletonRow} aria-hidden="true" />
      <span className={css.skeletonRow} aria-hidden="true" />
    </div>
  )
}

/** Load failure with the retry that reissues the list call. */
function ProjectsLoadError({ t, failure, retry }: {
  readonly t: Translate
  readonly failure: ProjectFailure
  readonly retry: ProjectListActions['reloadProjects']
}): ReactNode {
  return (
    <section className={css.error} role="alert" aria-label={t('error.load.title')}>
      <h2 className={css.errorTitle}>{t('error.load.title')}</h2>
      <p className={css.errorMessage}>{failureText(t, failure)}</p>
      <p className={css.errorDetail}>{failure.message}</p>
      <Button variant="primary" onClick={retry}>{t('error.retry')}</Button>
    </section>
  )
}

/** The state before the registry holds any project. */
function EmptyState({ t, createProject }: {
  readonly t: Translate
  readonly createProject: ProjectListActions['createProject']
}): ReactNode {
  return (
    <section className={css.empty} aria-label={t('dashboard.empty.title')}>
      <h2 className={css.emptyTitle}>{t('dashboard.empty.title')}</h2>
      <p className={css.emptyDescription}>{t('dashboard.empty.description')}</p>
      <div className={css.emptyActions}>
        <Button variant="primary" onClick={() => { createProject(t('project.untitled')) }}>
          {t('dashboard.create')}
        </Button>
      </div>
    </section>
  )
}

/** One project card: its Host facts plus the actions on that row. */
function ProjectRow({
  t, project, opened, busy, renaming, confirming,
  onOpen, onEditRename, onCommitRename, onStartRemove, onRemove, onCancel,
}: {
  readonly t: Translate
  readonly project: ProjectSummary
  readonly opened: boolean
  readonly busy: boolean
  /** The draft being edited, or null when this row is not the renaming one. */
  readonly renaming: RenameDraft | null
  readonly confirming: boolean
  readonly onOpen: ProjectListActions['openProject']
  /** Starts this row's rename draft, or replaces the text being edited. */
  readonly onEditRename: (draft: RenameDraft) => void
  readonly onCommitRename: (draft: RenameDraft) => void
  readonly onStartRemove: (id: ProjectId) => void
  readonly onRemove: ProjectListActions['removeProject']
  readonly onCancel: () => void
}): ReactNode {
  const submitRename = (draft: RenameDraft) => (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (draft.title.trim() === '') return
    onCommitRename(draft)
  }
  return (
    <li className={clsx(css.row, opened && css.rowOpened)} aria-current={opened ? 'true' : undefined}>
      <div className={css.rowMain}>
        <div className={css.rowHeading}>
          <span className={css.rowTitle}>{project.title}</span>
          <span className={clsx(css.status, STATUS_CLASS[project.status])}>
            {t(STATUS_KEY[project.status])}
          </span>
        </div>
        <span className={css.rowPath}>{project.path}</span>
        <span className={css.rowMeta}>
          {project.definitionRevision === 0
            ? t('project.metaNew', { sessions: project.sessionCount })
            : t('project.meta', { sessions: project.sessionCount, revision: project.definitionRevision })}
        </span>
      </div>
      {renaming === null
        ? (
          <div className={css.rowActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              aria-label={t('action.openLabel', { name: project.title })}
              onClick={() => { onOpen(project.id) }}
            >
              {t('action.open')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || confirming}
              aria-label={t('action.renameLabel', { name: project.title })}
              onClick={() => { onEditRename({ id: project.id, title: project.title }) }}
            >
              {t('action.rename')}
            </Button>
            {confirming
              ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className={css.danger}
                    aria-label={t('action.removeConfirmLabel', { name: project.title })}
                    onClick={() => { onRemove(project.id) }}
                  >
                    {t('action.removeConfirm')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={onCancel}>{t('action.cancel')}</Button>
                  <span className={css.removeNote}>{t('action.removeNote')}</span>
                </>
              )
              : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={t('action.removeLabel', { name: project.title })}
                  onClick={() => { onStartRemove(project.id) }}
                >
                  {t('action.remove')}
                </Button>
              )}
          </div>
        )
        : (
          <form className={css.rowActions} onSubmit={submitRename(renaming)}>
            <Input
              autoFocus
              value={renaming.title}
              aria-label={t('rename.inputLabel')}
              onChange={(event) => { onEditRename({ id: project.id, title: event.target.value }) }}
            />
            <Button type="submit" variant="primary" size="sm" disabled={renaming.title.trim() === ''}>
              {t('action.save')}
            </Button>
            <Button variant="outline" size="sm" onClick={onCancel}>{t('action.cancel')}</Button>
          </form>
        )}
    </li>
  )
}

/** The project list, which owns the one row being renamed or confirmed. */
function ProjectList({ t, snapshot, actions }: {
  readonly t: Translate
  readonly snapshot: ProjectsSnapshot
  readonly actions: ProjectListActions
}): ReactNode {
  const [renaming, setRenaming] = useState<RenameDraft | null>(null)
  const [confirming, setConfirming] = useState<ProjectId | null>(null)
  const startRename = (draft: RenameDraft): void => {
    setConfirming(null)
    setRenaming(draft)
  }
  const startRemove = (id: ProjectId): void => {
    setRenaming(null)
    setConfirming(id)
  }
  const cancel = (): void => {
    setRenaming(null)
    setConfirming(null)
  }
  const commitRename = (draft: RenameDraft): void => {
    cancel()
    actions.renameProject(draft.id, draft.title.trim())
  }
  const remove = (id: ProjectId): void => {
    setConfirming(null)
    actions.removeProject(id)
  }
  return (
    <>
      <ul className={css.list} aria-label={t('dashboard.listCaption')}>
        {snapshot.projects.map(project => (
          <ProjectRow
            key={project.id}
            t={t}
            project={project}
            opened={project.id === snapshot.openedProjectId}
            busy={snapshot.busy}
            renaming={renaming?.id === project.id ? renaming : null}
            confirming={confirming === project.id}
            onOpen={actions.openProject}
            onEditRename={startRename}
            onCommitRename={commitRename}
            onStartRemove={startRemove}
            onRemove={remove}
            onCancel={cancel}
          />
        ))}
      </ul>
      <p className={css.hint}>{t('dashboard.removeHint')}</p>
    </>
  )
}

/** The panel body for the current list state. */
function ProjectsBody({ t, snapshot, actions }: {
  readonly t: Translate
  readonly snapshot: ProjectsSnapshot
  readonly actions: ProjectListActions
}): ReactNode {
  const view = snapshot.view
  switch (view.status) {
    case 'loading':
      return <ProjectsSkeleton t={t} />
    case 'error':
      return <ProjectsLoadError t={t} failure={view.failure} retry={actions.reloadProjects} />
    case 'ready':
      return snapshot.projects.length === 0
        ? <EmptyState t={t} createProject={actions.createProject} />
        : <ProjectList t={t} snapshot={snapshot} actions={actions} />
    /* v8 ignore next -- the local store discriminant is a closed union with no other member */
    default:
      return assertNever(view)
  }
}

/**
 * Render the project dashboard.
 * @param props - the main slot shares plus the composition's project callbacks.
 * @returns the dashboard element tree.
 */
export function ProjectsPage({
  t, useProjects, createProject, openProject, renameProject, removeProject, reloadProjects,
  resetImport, importMermaid,
}: ProjectsPageProps): ReactNode {
  const snapshot = useProjects(state => state)
  const { view } = snapshot
  const [importOpen, setImportOpen] = useState(false)
  const actions: ProjectListActions = {
    createProject, openProject, renameProject, removeProject, reloadProjects,
  }
  const opened = snapshot.projects.find(project => project.id === snapshot.openedProjectId)
  return (
    <section className={css.page} aria-label={t('dashboard.title')}>
      <header className={css.header}>
        <h1 className={css.title}>{t('dashboard.title')}</h1>
        <div className={css.actions}>
          <Button
            variant="primary"
            disabled={snapshot.busy || view.status !== 'ready'}
            onClick={() => { createProject(t('project.untitled')) }}
          >
            {t('dashboard.create')}
          </Button>
          <Button
            variant="outline"
            disabled={snapshot.busy}
            onClick={() => {
              resetImport()
              setImportOpen(true)
            }}
          >
            {t('dashboard.import')}
          </Button>
        </div>
      </header>
      <p className={css.description}>{t('dashboard.description')}</p>
      {snapshot.mutationError !== null && (
        <p className={css.notice} role="status">
          <strong>{t('error.mutation.title')}</strong>
          {' '}
          {failureText(t, snapshot.mutationError)}
          {' '}
          <span className={css.errorDetail}>{snapshot.mutationError.message}</span>
        </p>
      )}
      {opened !== undefined && <p className={css.hint}>{t('dashboard.opened', { name: opened.title })}</p>}
      <ProjectsBody t={t} snapshot={snapshot} actions={actions} />
      <ImportDialog
        t={t}
        open={importOpen}
        state={snapshot.import}
        onClose={() => { setImportOpen(false) }}
        onSubmit={importMermaid}
      />
    </section>
  )
}
