/**
 * MetaWorkFlow project dashboard, browser half: one keyed `main` panel plus the
 * sidebar entry that returns to it, and the startup policy that keeps the
 * first screen on this dashboard instead of reopening the previous Session.
 *
 * The panel is the profile's home surface, so it selects itself once per
 * activation; the sidebar entry keeps it reachable after the user opens a
 * Session. The store is the temporary project list: the project service
 * replaces it when project storage lands, while the component contract
 * ({@link ProjectSummary}) stays the same.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { brandString } from '@metaworkflow/brand'
import type {} from '@metaworkflow/client-locale/client'
import type { MainPanelId } from '@metaworkflow/client-ui-layout/client'
import type {} from '@metaworkflow/client-ui-renderer/client'
import type {} from '@metaworkflow/client-ui-sidebar/client'
import type {} from '@metaworkflow/client-ui-workspace/client'
import { en, zh, type ProjectsKey } from './locales.ts'
import { ProjectsPage, type ProjectsPageInjected } from './ProjectsPage.tsx'
import { ProjectsPanelIcon } from './ProjectsPanelIcon.tsx'
import { createProjectsStore, type ProjectId, type ProjectSummary } from './projects.ts'

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
export const inject = ['slots', 'locale', 'layout']

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
  const handle = createProjectsStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  let sequence = 0
  const nextProject = (name: string, purpose: string): ProjectSummary => {
    sequence += 1
    return {
      id: brandString<ProjectId>(`project-${String(sequence)}`),
      name,
      purpose,
      status: 'draft',
    }
  }
  let selectedHome = false
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: PROJECTS_PANEL_ID,
      locale: NS,
      store,
      inject: (): ProjectsPageInjected => ({
        createProject: () => { instance.actions.addProject(nextProject(t('project.untitled'), t('project.untitledPurpose'))) },
        importMermaid: () => { instance.actions.addProject(nextProject(t('project.imported'), t('project.importedPurpose'))) },
        openProject: (id) => { instance.actions.openProject(id) },
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
