/**
 * MetaWorkFlow project dashboard, browser half: one keyed `main` panel plus the
 * sidebar entry that returns to it, and the startup policy that keeps the
 * first screen on this dashboard instead of reopening the previous Session.
 *
 * The panel is the profile's home surface, so it selects itself once per
 * activation; the sidebar entry keeps it reachable after the user opens a
 * Session. The list it renders is the Host registry, read and mutated through
 * the generated `projects` Remote namespace.
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
import { ProjectsController } from './projects.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'mw.projects'

/** The keyed main panel that hosts the dashboard, and its sidebar entry id. */
export const PROJECTS_PANEL_ID = 'projects' as MainPanelId

declare module '@metaworkflow/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project dashboard copy. */
    'mw.projects': ProjectsKey
  }
}

/** Services required by the dashboard, its home selection, and its sidebar entry. */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.projects']

/**
 * Contribute the project dashboard and its sidebar entry, and publish the
 * composition's startup policy.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // The dashboard is this composition's home surface: startup must not retain
  // or create a Session behind it. ui-workspace owns the policy contract.
  ctx.provide('sessionRestorePolicy', { restoreLastSession: false })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mw-projects: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new ProjectsController(ctx.remote.projects)
  // The panel is the home surface, so the first list load starts with the
  // composition instead of waiting for the panel to mount.
  void controller.load()
  let selectedHome = false
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: PROJECTS_PANEL_ID,
      locale: NS,
      inject: (): ProjectsPageInjected => ({
        hooks: { projects: controller.list },
        createProject: (title) => { void controller.create(title) },
        openProject: (id) => { void controller.open(id) },
        renameProject: (id, title) => { void controller.rename(id, title) },
        removeProject: (id) => { void controller.remove(id) },
        reloadProjects: () => { void controller.load() },
      }),
    }, ProjectsPage)
    if (!selectedHome) {
      selectedHome = true
      ctx.layout.selectPanel(PROJECTS_PANEL_ID)
    }
    return dispose
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PROJECTS_PANEL_ID,
    order: 0,
    locale: NS,
    label: () => t('panel.label'),
  }, ProjectsPanelIcon))
}
