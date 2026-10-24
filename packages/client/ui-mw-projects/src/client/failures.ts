/**
 * The failure-code-to-copy table shared by both project panels.
 *
 * The dashboard and the workbench render the same `projects.*` Remote
 * failures, so the table and its generic fallback live here rather than
 * beside either panel.
 */
import type { RemoteErrorCode } from '@metaworkflow/api-remotes/client'
import type { TranslateNS } from '@metaworkflow/client-ui-slots'
import type { ProjectsKey } from './locales.ts'
import type { ProjectFailure } from './projects.ts'

/**
 * Localized message per failure code the project namespace raises. Any other
 * code reads the generic carrier copy.
 */
const FAILURE_KEY: Readonly<Partial<Record<RemoteErrorCode, ProjectsKey>>> = {
  'project/not-found': 'error.project-not-found',
  'project/invalid-path': 'error.project-invalid-path',
  'project/path-in-use': 'error.project-path-in-use',
  'project/definition-missing': 'error.project-definition-missing',
  'project/definition-invalid': 'error.project-definition-invalid',
  'project/node-not-found': 'error.project-node-not-found',
  'project/run-unavailable': 'error.project-run-unavailable',
  'project/decision-unavailable': 'error.project-decision-unavailable',
  'project/workflow-unavailable': 'error.project-workflow-unavailable',
  'gateway/bad-request': 'error.bad-request',
}

/**
 * Localized copy for one failure.
 * @param t - translator bound to the `mw.projects` dictionary.
 * @param failure - the failed call, as the controller published it.
 * @returns the message to render.
 */
export function failureText(t: TranslateNS<'mw.projects'>, failure: ProjectFailure): string {
  return t(FAILURE_KEY[failure.code] ?? 'error.unknown')
}
