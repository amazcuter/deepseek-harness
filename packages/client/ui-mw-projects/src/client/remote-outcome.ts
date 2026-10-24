/**
 * One settled `projects.*` Remote call, folded into what a panel renders.
 *
 * Both project controllers publish the same two failure forms — the generated
 * envelope's error branch and the assembly or carrier faults that still reject
 * — so the fold lives here rather than beside either of them.
 */

import type { RemoteResult } from '@metaworkflow/api-remotes/client'
import { failureOf, messageOf, type ProjectFailure } from './projects.ts'

/** One settled Remote call: the Host value or the failure the panel renders. */
export type RemoteOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: ProjectFailure }

/**
 * Call one Remote method and fold both failure forms into one outcome.
 * @param call - the Remote call to perform.
 * @returns the settled outcome; a rejection becomes a `gateway/internal` failure.
 */
export async function settleRemote<Value>(
  call: () => Promise<RemoteResult<Value>>,
): Promise<RemoteOutcome<Value>> {
  try {
    const result = await call()
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, failure: failureOf(result.error) }
  } catch (error: unknown) {
    return { ok: false, failure: { code: 'gateway/internal', message: messageOf(error) } }
  }
}
