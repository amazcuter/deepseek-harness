/**
 * Input assembly: read one node's declared bindings from the values its run
 * already committed.
 *
 * A binding resolves from an ancestor's result, a run parameter, or an
 * artifact; a binding that resolves to nothing makes its activation fail with
 * `scheduler/input-missing` instead of running the node with a partial input.
 *
 * @module @metaworkflow/workflow-scheduler/inputs
 */

import { readFieldPath } from '@metaworkflow/workflow-definition'
import type { JsonValue } from '@metaworkflow/util-values'
import type { InputBinding, WorkflowNode } from '@metaworkflow/workflow-definition'
import type { ArtifactRow } from './records.ts'
import type { NodeInputs, RunParams } from './types.ts'

/** Where one activation's inputs are read from. */
export interface InputLookups {
  /** Run-scoped parameters supplied when the run started. */
  readonly params: RunParams
  /**
   * The newest committed result of one ancestor node at or before an iteration.
   * @param nodeId - ancestor node whose result is read.
   * @param iteration - the reading activation's iteration.
   * @returns the result, or `undefined` when the ancestor has not succeeded yet.
   */
  readonly result: (nodeId: string, iteration: number) => JsonValue | undefined
  /**
   * The newest artifact published under one name in the run.
   * @param name - artifact name.
   * @returns the artifact, or `undefined` when the run published none under that name.
   */
  readonly artifact: (name: string) => ArtifactRow | undefined
}

/** Outcome of assembling one activation's inputs. */
export type InputAssembly =
  | { readonly ok: true; readonly inputs: NodeInputs }
  | { readonly ok: false; readonly binding: InputBinding }

/**
 * The JSON value one artifact binding receives: the reference to the published
 * file, never the file's content.
 * @param artifact - the artifact a binding read.
 * @returns the artifact reference as a JSON value.
 */
export function artifactReference(artifact: ArtifactRow): JsonValue {
  return { name: artifact.name, version: artifact.version, path: artifact.path, sha256: artifact.sha256 }
}

/**
 * Resolve one binding.
 * @param binding - the binding to resolve.
 * @param iteration - the reading activation's iteration.
 * @param lookups - the run's committed values.
 * @returns the bound value, or `undefined` when the binding resolves to nothing.
 */
function resolveBinding(binding: InputBinding, iteration: number, lookups: InputLookups): JsonValue | undefined {
  const source = binding.source
  switch (source.kind) {
    case 'node': {
      const result = lookups.result(source.nodeId, iteration)
      if (result === undefined) return undefined
      return readFieldPath(result, source.field.split('.'))
    }
    case 'run':
      return Object.hasOwn(lookups.params, source.key) ? lookups.params[source.key] : undefined
    case 'artifact': {
      const artifact = lookups.artifact(source.name)
      return artifact === undefined ? undefined : artifactReference(artifact)
    }
  }
}

/**
 * Assemble one activation's inputs.
 * @param node - the node the activation executes.
 * @param iteration - the activation's loop iteration.
 * @param lookups - the run's committed values.
 * @returns every binding's value, or the first binding that resolves to nothing.
 */
export function assembleInputs(node: WorkflowNode, iteration: number, lookups: InputLookups): InputAssembly {
  const inputs: Record<string, JsonValue> = {}
  for (const binding of node.inputs) {
    const value = resolveBinding(binding, iteration, lookups)
    if (value === undefined) return { ok: false, binding }
    inputs[binding.name] = value
  }
  return { ok: true, inputs }
}
