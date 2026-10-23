/** `mw.projects` namespace dictionaries for the MetaWorkFlow project dashboard. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.label': '工作流项目',
  'dashboard.title': '工作流项目',
  'dashboard.description': '一个项目，一条独立工作流。进入项目后查看画布、与统筹对话、配置节点。',
  'dashboard.empty.title': '还没有工作流项目',
  'dashboard.empty.description': '新建一个空项目，或导入现有的 Mermaid 流程图开始。',
  'dashboard.create': '新建项目',
  'dashboard.import': '导入 Mermaid',
  'dashboard.listCaption': '工作流项目列表',
  'column.name': '项目',
  'column.purpose': '用途',
  'column.status': '当前状态',
  'column.actions': '操作',
  'action.open': '打开项目',
  'action.openLabel': '打开项目 {name}',
  'status.draft': '草稿',
  'status.active': '运行中',
  'status.paused': '已暂停',
  'status.done': '已完成',
  'project.untitled': '未命名项目',
  'project.untitledPurpose': '尚未描述用途',
  'project.imported': '导入的工作流',
  'project.importedPurpose': '从 Mermaid 流程图导入（占位，尚未解析）',
} satisfies Record<string, string>

/** The `mw.projects` key union. */
export type ProjectsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.label': 'Workflow projects',
  'dashboard.title': 'Workflow projects',
  'dashboard.description': 'One project holds one independent workflow. Open a project to see its canvas, talk to its coordinator, and configure its nodes.',
  'dashboard.empty.title': 'No workflow projects yet',
  'dashboard.empty.description': 'Create an empty project, or start from an existing Mermaid flowchart.',
  'dashboard.create': 'New project',
  'dashboard.import': 'Import Mermaid',
  'dashboard.listCaption': 'Workflow project list',
  'column.name': 'Project',
  'column.purpose': 'Purpose',
  'column.status': 'Status',
  'column.actions': 'Actions',
  'action.open': 'Open project',
  'action.openLabel': 'Open project {name}',
  'status.draft': 'Draft',
  'status.active': 'Running',
  'status.paused': 'Paused',
  'status.done': 'Completed',
  'project.untitled': 'Untitled project',
  'project.untitledPurpose': 'Purpose not described yet',
  'project.imported': 'Imported workflow',
  'project.importedPurpose': 'Imported from a Mermaid flowchart (placeholder, not parsed yet)',
} satisfies Record<ProjectsKey, string>
