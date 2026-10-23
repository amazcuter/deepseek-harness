---
description: "MetaWorkFlow 项目首页：列出工作流项目、打开项目，并从新建或导入的 Mermaid 工作流开始一个项目的 keyed main 面板与侧栏入口。"
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

[English](README.md) | 中文

## 概述

MetaWorkFlow profile 打开的是项目首页，而不是上一个会话。首页按行列出每个独立工作流及其用途与生命周期状态，并支持以空项目或导入的 Mermaid 流程图开始一个项目。本包同时发布启动策略，让首屏停留在该首页。项目列表是项目服务落地前的内存占位实现。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

`mwf metaworkflow` 打开首页。页面标明这是该 profile 的主页，说明一个项目承载一条独立工作流，并展示空状态或项目列表。

### 空状态

没有任何项目时，首页提供两条开始路径：**新建项目** 与 **导入 Mermaid**。主操作追加一个名为“未命名项目”的内存草稿项目；次操作追加一个名为“导入的工作流”的占位项目。两者都会立即出现在列表中，但在项目服务持久化之前都只是占位行。

### 项目列表

每行显示项目名、用途与当前状态（`草稿`、`运行中`、`已暂停`、`已完成`）。**打开项目** 会记录该行为已打开项目，并为其设置 `aria-current`。继续新建项目时，新行追加在列表末尾。窄屏下每行折叠为单列，并由本地化的列名标注每个单元格，列表无需横向滚动即可阅读。

### 启动策略

本插件发布 `sessionRestorePolicy`，值为 `restoreLastSession: false`。该可选策略的契约由 [ui-workspace](../ui-workspace/README.zh.md) 定义：策略缺省时，启动会重新打开上一次选中的会话；策略为 `false` 时，启动会把首屏让给组合所选的首页。首页在每次激活时只选中自己的 main 面板一次，因此该 profile 落在项目首页而不是某个会话上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本包注册一个名为 `projects` 的 keyed `main` 面板，以及一个使用同一 id 的 `sidebar.panellist` 入口，使侧栏在打开会话后仍能回到首页。两者都通过 `ctx.slots.inject` 等待各自的插槽声明，因此相对 [ui-layout](../ui-layout/README.zh.md) 与 [ui-sidebar](../ui-sidebar/README.zh.md) 的 apply 顺序不受约束。

面板声明一个 store：`createProjectsStore()`。它保存占位的项目列表与已打开行；组件通过 `useStore` 读取，只通过声明的 actions 写入。该 store 是刻意的临时实现：项目存储落地后由项目服务替换它，而 `ProjectSummary` 仍是组件契约。

文案位于以 `client-locale` 注册的 `mw.projects` 词典中，中文为基准侧。`locale/` 下的语言文件只承载插件的展示元数据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-layout](../ui-layout/README.zh.md) — 拥有 keyed `main` 插槽的框架。
- [ui-sidebar](../ui-sidebar/README.zh.md) — 本入口加入的面板列表。
- [ui-workspace](../ui-workspace/README.zh.md) — 启动策略的消费方与会话导航。
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

- **项目列表只存在于内存** — 在项目服务发布持久化项目之前，浏览器重新加载会回到空状态。
- **导入尚未解析 Mermaid** — 该操作只追加占位行；解析、渲染与统筹流程随工作流定义里程碑落地。
- **打开项目只记录选择** — 项目工作台（画布、统筹会话、节点检查器）属于后续里程碑。
