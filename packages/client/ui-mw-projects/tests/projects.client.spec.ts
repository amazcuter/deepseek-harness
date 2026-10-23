import { describe, expect, it } from 'vitest'
import { createProjectsStore, projectId, type ProjectSummary } from '../src/client/projects.ts'

function project(name: string, id = projectId(1)): ProjectSummary {
  return { id, name, purpose: `${name} purpose`, status: 'draft' }
}

describe('projectId', () => {
  it('mints one opaque id per sequence position', () => {
    expect(projectId(1)).toBe('project-1')
    expect(projectId(2)).toBe('project-2')
    expect(projectId(1)).not.toBe(projectId(2))
  })
})

describe('createProjectsStore', () => {
  it('starts with the shipped empty dashboard', () => {
    const snapshot = createProjectsStore().create().getSnapshot()
    expect(snapshot).toEqual({ projects: [], openedProjectId: null })
  })

  it('seeds the list in the given order without opening a project', () => {
    const snapshot = createProjectsStore([
      project('长夜航线 · 小说创作'),
      project('行业研究周报', projectId(2)),
    ]).create().getSnapshot()
    expect(snapshot.projects.map(item => item.name)).toEqual(['长夜航线 · 小说创作', '行业研究周报'])
    expect(snapshot.openedProjectId).toBeNull()
  })

  it('appends projects and records the opened row', () => {
    const store = createProjectsStore().create()
    store.actions.addProject(project('长夜航线 · 小说创作'))
    store.actions.addProject(project('行业研究周报', projectId(2)))
    expect(store.getSnapshot().projects.map(item => item.id)).toEqual([projectId(1), projectId(2)])
    store.actions.openProject(projectId(2))
    expect(store.getSnapshot().openedProjectId).toBe(projectId(2))
  })

  it('keeps each store instance independent', () => {
    const first = createProjectsStore().create()
    const second = createProjectsStore().create()
    first.actions.addProject(project('长夜航线 · 小说创作'))
    expect(second.getSnapshot().projects).toHaveLength(0)
  })
})
