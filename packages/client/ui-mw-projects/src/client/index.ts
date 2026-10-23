/**
 * MetaWorkFlow project surfaces, browser half: two keyed `main` panels — the
 * `projects` dashboard the profile opens on, and the `project` workbench a
 * project opens onto — plus the sidebar entry that returns to the dashboard
 * and the startup policy that keeps the first screen on it instead of
 * reopening the previous Session.
 *
 * The dashboard is the profile's home surface, so it selects itself once per
 * activation; the workbench is reached by opening a project, and its own
 * header returns to the dashboard. Both panels render the same Host registry,
 * read and mutated through the generated `projects` Remote namespace.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@metaworkflow/api-remotes/client'
import type {} from '@metaworkflow/client-locale/client'
import type { MainPanelId } from '@metaworkflow/client-ui-layout/client'
import type {} from '@metaworkflow/client-ui-renderer/client'
import type {} from '@metaworkflow/client-ui-sidebar/client'
import type {} from '@metaworkflow/client-ui-workspace/client'
import { en, zh, type ProjectsKey } from './locales.ts'
import { ProjectsPage, type ProjectsPageInjected } from './ProjectsPage.tsx'
import { ProjectsPanelIcon } from './ProjectsPanelIcon.tsx'
import { ProjectsController, type ProjectId } from './projects.ts'
import { WorkbenchPage, type WorkbenchPageInjected } from './WorkbenchPage.tsx'

/** Dictionary namespace owned by this plugin. */
export const NS = 'mw.projects'

/** The keyed main panel that hosts the dashboard, and its sidebar entry id. */
export const PROJECTS_PANEL_ID = 'projects' as MainPanelId

/** The keyed main panel that hosts the workbench of the opened project. */
export const PROJECT_PANEL_ID = 'project' as MainPanelId

declare module '@metaworkflow/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project dashboard and workbench copy. */
    'mw.projects': ProjectsKey
  }
}

/** Services required by both panels, their navigation, and the sidebar entry. */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.projects']

/**
 * Contribute the project dashboard, the project workbench, and the sidebar
 * entry, and publish the composition's startup policy.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // The dashboard is this composition's home surface: startup must not retain
  // or create a Session behind it. ui-workspace owns the policy contract.
  ctx.provide('sessionRestorePolicy', { restoreLastSession: false })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mw-projects: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new ProjectsController(ctx.remote.projects)
  // The dashboard is the home surface, so the first list load starts with the
  // composition instead of waiting for the panel to mount.
  void controller.load()
  let selectedHome = false
  ctx.slots.inject('main', function* () {
    let disposed = false
    const backToProjects = (): void => { ctx.layout.selectPanel(PROJECTS_PANEL_ID) }
    // Opening a project succeeds on the Host before the workbench may claim the
    // screen. The panel it targets leaves with this same contribution, so a
    // call settling after teardown must not select it.
    const openProject = (id: ProjectId): void => {
      void controller.open(id).then((opened) => {
        if (opened && !disposed) ctx.layout.selectPanel(PROJECT_PANEL_ID)
      })
    }
    yield ctx.slots.register({
      name: 'main',
      key: PROJECTS_PANEL_ID,
      locale: NS,
      inject: (): ProjectsPageInjected => ({
        hooks: { projects: controller.list },
        createProject: (title) => { void controller.create(title) },
        openProject,
        renameProject: (id, title) => { void controller.rename(id, title) },
        removeProject: (id) => { void controller.remove(id) },
        reloadProjects: () => { void controller.load() },
      }),
    }, ProjectsPage)
    if (!selectedHome) {
      selectedHome = true
      ctx.layout.selectPanel(PROJECTS_PANEL_ID)
    }
    yield ctx.slots.register({
      name: 'main',
      key: PROJECT_PANEL_ID,
      locale: NS,
      inject: (): WorkbenchPageInjected => ({
        hooks: { projects: controller.list },
        openProject,
        backToProjects,
      }),
    }, WorkbenchPage)
    yield () => { disposed = true }
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PROJECTS_PANEL_ID,
    order: 0,
    locale: NS,
    label: () => t('panel.label'),
  }, ProjectsPanelIcon))
}
