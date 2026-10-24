/**
 * The flowchart import half of the `projects` Remote namespace: one parse, one
 * translation, and one stored revision against a real project store, a real
 * workspace registry, and a real definition validator, so the verb exercises
 * the composition the Host serves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@metaworkflow/session'
import Storage from '@metaworkflow/storage'
import { DomainFacility } from '@metaworkflow/storage-domain'
import { parseDefinitionDocument } from '@metaworkflow/workflow-definition'
import ProjectStore from '@metaworkflow/workflow-project-store'
import WorkspaceRegistry from '@metaworkflow/workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MwProjectController } from '../src/projects.ts'

/** A project identity no registration carries, shaped like a real one. */
const UNKNOWN_PROJECT = '22222222-2222-4222-8222-222222222222' as never

/** Flowchart whose nodes and links all translate into a runnable graph. */
const STEP_FLOW = `flowchart TD
  Start[Fetch the invoice] --> Review{Review}
  Review -->|approved| Done[File it]
  Review -->|rejected| Rework[Send it back]`

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Boot the composition the controller verbs run against. */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mwf-projects-mermaid-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(ProjectStore, { mwfHome: join(root, 'home') })
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  const projects = new MwProjectController(ctx)
  return { ctx, projects, root }
}

/**
 * Register one project directory the menu can import into.
 * @param ctx - booted context.
 * @param root - temporary directory the project lives in.
 * @returns the registered project identity.
 */
async function registerProject(ctx: Context, root: string): Promise<never> {
  const path = join(root, 'project')
  mkdirSync(path, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(path, 'Flowchart project')
  return workspace.id as never
}

describe('projects.importMermaid', () => {
  it('stores the translated flowchart as the project definition', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    const imported = await projects.importMermaid({ id, mermaid: STEP_FLOW })

    expect(imported.projectId).toBe(id)
    expect(imported.mapping).toEqual({ Start: 'fetch-the-invoice', Review: 'review', Done: 'file-it', Rework: 'send-it-back' })
    expect(imported.warnings).toEqual([])
    expect(imported.definition).toMatchObject({ revision: 1, valid: true, violations: [] })
    expect(imported.definition.document?.startsWith('{"edges":')).toBe(true)
    expect(imported.definition.nodes.map(node => [node.id, node.title, node.kind])).toEqual([
      ['fetch-the-invoice', 'Fetch the invoice', 'agent'],
      ['review', 'Review', 'agent'],
      ['file-it', 'File it', 'agent'],
      ['send-it-back', 'Send it back', 'agent'],
    ])
    expect(imported.definition.nodes[0]).toMatchObject({
      instructions: 'Complete the "Fetch the invoice" step.',
      memory: 'fresh',
      tools: [],
      join: 'all',
    })

    const stored = await ctx.mwfProjectStore.readDefinition(id)
    expect(stored?.revision).toBe(1)
    expect(stored?.document).toBe(imported.definition.document)
    const parsed = parseDefinitionDocument(stored?.document ?? '')
    expect(parsed.ok).toBe(true)
    expect(parsed.ok ? parsed.definition.edges.map(edge => edge.condition) : []).toEqual([
      null,
      { op: 'eq', field: 'route', value: 'approved' },
      { op: 'eq', field: 'route', value: 'rejected' },
    ])
  })

  it('registers a project under the requested title when the request names none', async () => {
    const { ctx, projects } = await harness()
    const imported = await projects.importMermaid({ title: '  Invoice flow  ', mermaid: STEP_FLOW })
    const listed = await projects.list()
    expect(listed.items.map(item => [item.id, item.title])).toEqual([[imported.projectId, 'Invoice flow']])
    expect(imported.definition.revision).toBe(1)
    await expect(ctx.mwfProjectStore.readDefinition(imported.projectId)).resolves.toMatchObject({ revision: 1 })
    await expect(projects.definition({ id: imported.projectId })).resolves.toMatchObject({ valid: true, revision: 1 })
  })

  it('reports the nodes the parser created from links alone', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    const imported = await projects.importMermaid({
      id,
      mermaid: `flowchart LR
  Start[Begin] --> Middle --> End[End]`,
    })
    expect(imported.warnings).toEqual([
      { code: 'mermaid/implicit-node', message: 'node "Middle" is only named by links, so it was created with its id as the title' },
    ])
    expect(imported.definition.nodes.map(node => node.id)).toEqual(['begin', 'middle', 'end'])
  })

  it('refuses text the parser cannot read and writes nothing', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    await expect(projects.importMermaid({ id, mermaid: 'flowchart TD\n  subgraph later' }))
      .rejects.toMatchObject({
        code: 'project/mermaid-invalid',
        details: {
          error: {
            code: 'mermaid/unsupported-syntax',
            message: 'unsupported statement "subgraph"; the importer reads node statements, links, and comments only',
            line: 2,
          },
        },
      })
    await expect(ctx.mwfProjectStore.readDefinition(id)).resolves.toBeUndefined()
  })

  it('refuses a cyclic flowchart and points the author at the canvas', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    await expect(projects.importMermaid({
      id,
      mermaid: `flowchart TD
  A[One] --> B[Two]
  B --> A`,
    })).rejects.toMatchObject({
      code: 'project/mermaid-invalid',
      message: expect.stringContaining('the flowchart cannot be imported') as string,
      details: { error: { code: 'mermaid/cycle-unsupported' } },
    })
    await expect(ctx.mwfProjectStore.readDefinition(id)).resolves.toBeUndefined()
  })

  it('reports validator violations for a graph that translates but cannot run', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    await expect(projects.importMermaid({
      id,
      mermaid: `flowchart TD
  A[One] --> C[Three]
  B[Two] --> C`,
    })).rejects.toMatchObject({
      code: 'project/mermaid-invalid',
      message: expect.stringContaining('the flowchart is not a usable definition') as string,
      details: { violations: [expect.stringContaining('entry node') as string] },
    })
    await expect(ctx.mwfProjectStore.readDefinition(id)).resolves.toBeUndefined()
    await expect(projects.list()).resolves.toMatchObject({ items: [{ id, definitionRevision: 0 }] })
  })

  it('requires a title when it registers a project', async () => {
    const { projects } = await harness()
    await expect(projects.importMermaid({ mermaid: STEP_FLOW })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(projects.importMermaid({ title: '   ', mermaid: STEP_FLOW })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(projects.list()).resolves.toEqual({ items: [] })
  })

  it('reports an unknown project instead of registering one', async () => {
    const { projects } = await harness()
    await expect(projects.importMermaid({ id: UNKNOWN_PROJECT, mermaid: STEP_FLOW }))
      .rejects.toMatchObject({ code: 'project/not-found' })
  })

  it('maps a storage fault while writing the definition', async () => {
    const { ctx, projects, root } = await harness()
    const id = await registerProject(ctx, root)
    vi.spyOn(ctx.mwfProjectStore, 'writeDefinition').mockRejectedValueOnce(new Error('disk is full'))
    await expect(projects.importMermaid({ id, mermaid: STEP_FLOW }))
      .rejects.toMatchObject({ code: 'project/invalid-path' })
  })
})
