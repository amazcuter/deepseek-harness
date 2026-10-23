---
description: "MetaWorkFlow 项目首页：列出 Host 已注册工作流项目的 keyed main 面板与侧栏入口，支持新建、打开、重命名、删除，并从新建或导入的 Mermaid 工作流开始一个项目。"
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

[English](README.md) | 中文

## 概述

MetaWorkFlow profile 打开的是项目首页，而不是上一个会话。首页列出 Host 已注册的项目——每个独立工作流一行，带有目录、目录实时状态、会话数与定义版本——并通过 `projects` Remote 命名空间新建、打开、重命名与删除。本包同时发布启动策略，让首屏停留在该首页。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`mwf metaworkflow` 打开首页。页面标明这是该 profile 的主页，说明一个项目承载一条独立工作流，并展示加载骨架、加载失败、空状态或项目列表。

### 加载、空状态与失败

首屏在三行骨架中等待 Host 应答，骨架带有本地化的加载标签与 `aria-busy`。没有任何已注册项目时，首页给出 **新建项目**。列表调用失败时，面板显示该失败码对应的本地化原因、下方附 Host 自身的诊断信息，并提供重新发起调用的 **重试** 按钮。

### 新建项目

**新建项目** 注册一个标题为本地化「未命名项目」的项目，目录由 Host 决定，位于 Harness home 之下。Host 回执到达后行即出现，随后可用 **重命名** 给它一个真正的名字。**导入 Mermaid** 以禁用占位形式发布：导入流程图尚未实现。

### 项目行

每行显示标题、项目绝对目录、目录实时状态（`目录就绪` 或 `目录缺失`），以及一行会话数与定义版本。

- **打开** 调用 `projects.open`：当目录存在但还没有数据库时，Host 会物化该项目数据库。该行被标记 `aria-current`，面板显示占位工作台并点名选中的项目。
- **重命名** 把标题换成行内编辑器。按 Enter 或 **保存** 提交去掉首尾空白的标题，按 Escape 或 **取消** 放弃，空草稿无法保存。
- **删除** 先就地确认：确认按钮点名该项目，并重申只移除注册。项目目录与其中所有会话都保留在磁盘上；列表下方的提示会再说明一次。

有变更在途时，行内控件与新建操作都会被禁用。变更失败时列表保持不变，并在其上方显示本地化原因与 Host 诊断信息。

窄屏下每张卡片改为纵向排列——先 Host 事实，再单独一行的操作——因此不需要横向滚动。

### 启动策略

本插件发布 `sessionRestorePolicy`，值为 `restoreLastSession: false`。该可选策略的契约由 [ui-workspace](../ui-workspace/README.zh.md) 定义：策略缺省时，启动会重新打开上一次选中的会话；策略为 `false` 时，启动会把首屏让给组合所选的首页。首页在每次激活时只选中自己的 main 面板一次，因此该 profile 落在项目首页而不是某个会话上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本包注册一个名为 `projects` 的 keyed `main` 面板，以及一个使用同一 id 的 `sidebar.panellist` 入口，使侧栏在打开会话后仍能回到首页。两者都通过 `ctx.slots.inject` 等待各自的插槽声明，因此相对 [ui-layout](../ui-layout/README.zh.md) 与 [ui-sidebar](../ui-sidebar/README.zh.md) 的 apply 顺序不受约束。

`ProjectsController` 是 `ctx.remote.projects` 之上不依赖 React 的对象层。它持有唯一一份 `ProjectsSnapshot`——列表状态（`loading`、`ready`，或带失败信息的 `error`）、项目行、选中项目、最近一次变更失败与变更在途标志——并把它发布为裸 observable。每次变更都用 Host 的回执更新快照，而不是乐观的本地草稿；被拒绝的调用会被折算进同一套失败码，而不会逃逸成未处理的 rejection。插件随组合一起发起首次加载，并通过 inject 的 `hooks` 舱把该 observable 交给面板，因此组件读取 `useProjects`、调用注入的回调。

组件只持有一处本地状态：当前正在重命名或正在确认删除的行。文案位于以 `client-locale` 注册的 `mw.projects` 词典中，中文为基准侧；失败码到文案的映射表与组件放在一起。`locale/` 下的语言文件只承载插件的展示元数据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-layout](../ui-layout/README.zh.md) — 拥有 keyed `main` 插槽的框架。
- [ui-sidebar](../ui-sidebar/README.zh.md) — 本入口加入的面板列表。
- [ui-workspace](../ui-workspace/README.zh.md) — 启动策略的消费方与会话导航。
- [api-workspace-controller](../../api/workspace-controller/README.zh.md) — 本首页读取的 Host `projects` Remote 命名空间。
- [metaworkflow-app](../../bundle/metaworkflow-app/README.zh.md) — 挂载本插件并拒绝共享 Harness home 的 profile bundle。

-----

<a id="model-experience"></a>
## 模型体验

### 项目首页面板

#### 模型看到什么

没有模型可见输入。本包只在 `projects` main 面板中渲染浏览器侧项目状态，不贡献提示词文本、工具 schema 或请求上下文。

#### Token 影响

对模型请求没有直接影响；只有挂载本包并改变 agent 可见内容的组合才会产生影响。

#### KV 缓存影响

无影响：本包从不新增、替换或重排模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有列表实时流** — 首页在激活时加载，并用变更回执修补行；另一个窗口的注册要等重新加载后才出现。
- **导入尚未解析 Mermaid** — 该操作以禁用形式发布；解析、渲染与统筹流程随工作流定义里程碑落地。
- **打开项目只做选择** — 项目工作台（画布、统筹会话、节点检查器）属于后续里程碑，因此面板只显示点名所选项目的占位内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包靠五处机制互相支撑，改动其中一处就要复查其余。数据归 Remote：项目行、变更回执与失败都经 `ctx.remote.projects` 到达，Host 应答慢时保留本地草稿从来不是解法。`ProjectsController` 是快照的唯一写入方——`load()` 把 `loading` 一次性推进到 `ready` 或 `error`，每次变更只在该列表状态之上叠加 `busy` 与 `mutationError`，而 `busy` 统计在途调用数，因此重叠的变更会一直禁用控件，直到最后一次落定。就绪闸门在 `view.status !== 'ready'` 时让新建与行内变更保持禁用，因为加载失败的列表没有可修补的行。两种失败形态折叠成同一个 `ProjectFailure`，组件里失败码到文案的表必须覆盖该命名空间可能抛出的每个码。文案位于 `mw.projects` 词典，中文为基准侧；`locale/*.json` 只承载展示元数据。待定问题：用注册表变更流替代激活时重新加载，取决于 Host 命名空间是否先提供该流。

</details>
