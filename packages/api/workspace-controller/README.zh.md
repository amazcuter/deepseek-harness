---
description: "Host 与 Client 工作区控制：修改工作区导航并跟随其完整投影。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@metaworkflow/api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，归档与取消归档 Session，以及跟随完整的 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有带生成 `ctx.remote.directoryPicker` namespace 的 `ctx.directoryPickerController`（它承载的选目录 seam 是抽象的，自身从不作为 Loader entry），以及带生成 `ctx.remote.projects` namespace 的 `ctx.mwProjectController`——项目首页通过后者完成列出、新建、打开、重命名与删除。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order`、`archived` 和 `pinned` 增量。归档与置顶集合都是会话 id 数组，置顶数组把最近置顶的 id 放在前面。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。不带 `stopActivity` 的 `archiveSession` 会以 `workspace/session-active` 拒绝仍有工作在跑的会话，其 details 按族（`turn`、`subagent`、`job`、`schedule`）列出这些工作及各项的 id 与名称；带 `stopActivity: true` 时注册表的提供方先停止这些工作，归档集合持久化后即返回响应，停止在后台收敛。

控制器注入 `remoteAccess`，并经 `typert.resources` 以默认字段 `workspaceId` 登记 `workspace` 资源种类。`workspace/follow` 不读取资源，其调用访问 `global` 资源：principal 不是 owner 的 Peer 只有在其 principal kind 于 [`mwf-api-remote-access`](../remote-access/README.zh.md) 中的 policy 绑定了列出该 action 的 `global` role 时才能订阅它。对这类调用方，baseline、`upsert` 帧与 `order` 中的 id 只保留 `ctx.remoteAccess.allows()` 作为 `workspace` 资源允许的 Workspace，以及它作为 `session` 资源允许的会话 id（各 Workspace 内的会话以及归档与置顶集合），因此 `workspace` role 与 `session` role 也列出同一 action。流记录已下发的 Workspace。某个 Workspace 在下一次变化或新顺序中已不被允许时，流发送一个携带完整过滤后状态的 `replace` 增量帧而不是 `remove`，因为 Client 不会复活已移除的 id；`replace` 是普通增量帧，Client 像开场 baseline 一样整体替换状态，但它不开启新的一代，因此既不报告错误也不重连；访问恢复后，该 Workspace 经普通 `upsert` 重新出现。`remove` 帧表示删除，只发给收到过该 Workspace 的调用方。owner 的帧不过滤。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、归档与置顶会话身份、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。置顶快照仅在会话身份或顺序变化时更新。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。`WorkspaceController.archiveSession(sessionId, { stopActivity })` 抛出携带 Host `rpcError` 的 `WorkspaceArchiveError`，界面因此能区分"仍有工作在跑"的拒绝与会话缺失或载体故障，并提议停止这些工作。

<a id="first-use-workspace"></a>
### 首次使用工作区

`workspace.initializeDefault()` 返回持久化的默认工作区；Client service 通过 `workspaces.initializeDefault(signal?)` 提供该操作。它不接受请求参数：固定目录名 `default-workspace` 由 Host 拥有，注册表也以同一路径片段作为初始标题，因此任何语言下同一安装环境都只有一个磁盘路径和一个存储标题。Host 将目录放在其账户的 `<Documents>/deepseek-harness` 下，远程 Web Host 也遵循此规则。操作系统的文件名限制同样适用。Linux 系统查询要求存在 `xdg-user-dir` 且启用了 Documents 目录；不具备该条件的 Host 必须配置 `documentsDirectory` 或使用文件夹选择器。

[Workspace 注册表](../../workspace/workspace/README.zh.md#first-use-workspace)负责资格判断、目录创建和持久化初始化。已有默认工作区直接返回，不再查询 Documents，也不会被重命名或迁移。不满足首次使用条件时返回 `undefined`，启动流程可将目录选择留给用户。查询和创建失败遵循标准 Remote 错误处理。初始化不创建 Session，也不发送消息。

`./default-workspace` 为浏览器消费方导出 `DEFAULT_WORKSPACE_DIRECTORY` 与 `workspaceDisplayTitle(title, localizedDefault)`：仍保留自动标题的工作区按读者语言显示默认名称，其他标题一律原样显示。被用户重命名为 `default-workspace` 的工作区，或从选择器采用的同名文件夹，也会按默认工作区显示；除显示之外没有其他行为依赖该判断。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `documentsDirectory` | 系统 Documents 目录 | 完全限定的 Host 目录覆盖值 |
| `documentsLookupTimeoutMs` | `10000` | 操作系统目录查询的正数最大时长，单位为毫秒 |

Documents 查询占用注册表变更队列，因此其他 Workspace 变更（包括登记已选目录）最多可能等待 `documentsLookupTimeoutMs`。取消可以停止查询；解析成功后，取消不会回滚创建或登记。

<a id="the-projects-namespace"></a>
### projects 命名空间

`ctx.mwProjectController` 通过生成的 `ctx.remote.projects` 命名空间服务项目首页。它自身不持有项目数据：`ctx.mwfProjectStore` 拥有项目身份、目录、标题与定义版本，`ctx.workspaceRegistry` 拥有会话账本与显示顺序，因此一行列表由两者组合而成，存储失败会被映射为 Remote 错误码而不是直接泄漏。

| 动词 | 请求 | 响应 |
| --- | --- | --- |
| `projects.list()` | 无 | `{ items }`，每个已注册项目一条 `ProjectSummary`，按注册表显示顺序排列 |
| `projects.create({ title, path? })` | 非空 `title`；可选的已存在 `path` | `{ project }` |
| `projects.open({ id })` | 项目 id | `{ project }`，当目录存在但还没有数据库时物化项目数据库 |
| `projects.rename({ id, title })` | 项目 id 与非空 `title` | `{ project }` |
| `projects.delete({ id })` | 项目 id | `{ deleted: true }`；只移除注册，目录与其会话保留 |
| `projects.coordinator({ id })` | 项目 id | `{ sessionId }`，该项目的统筹会话；组合没有 `ctx.mwfCoordinator` 时为 `null` |
| `projects.definition({ id })` | 项目 id | `{ revision, document, valid, violations, nodes }`，最新保存的定义按详情面板投影；已无法解析的定义会被如实报告而不是拒绝 |
| `projects.importDefinition({ id, document })` | 项目 id 与 JSON 文档文本 | `{ revision, nodeCount }`；写入前先校验，并以规范化形式保存 |
| `projects.importMermaid({ id?, title?, mermaid })` | 项目 id，或用于新建项目的非空 `title`，以及流程图文本 | `{ projectId, definition, mapping, warnings }`；写入前先解析、翻译并校验流程图，`definition` 是已保存版本按 `projects.definition` 的读法投影出的结果，`mapping` 是 Mermaid 节点 id 到生成节点 id 的记录 |
| `projects.availableTools({ id, nodeId })` | 项目与节点 id | `{ items }`，`ctx.tools` 注册的每个工具一条 `{ name, description, enabled }` 开关，节点仍声明的名字也保留；Python 节点返回空 |
| `projects.updateNode({ id, nodeId, patch })` | 项目、节点 id 与 `{ title?, tools? }` | `{ revision }`，修补后定义写入的版本；其余字段保持只读 |
| `projects.pendingDecisions({ id })` | 项目 id | `{ items }`，尚未答复的决策请求，最旧在前 |
| `projects.answerDecision({ id, requestId, answer })` | 项目、请求 id 与非空答复 | `{ answered: true, runStatus }`；记录答复并唤醒等待中的激活 |
| `projects.attempts({ id, runId? })` | 项目 id 与可选运行 id | `{ run, items }`，指定运行（省略时为最新一次）及其激活与尝试；项目还没跑过时 `run` 为 `null` |
| `projects.startRun({ id })` | 项目 id | `{ runId, status }`；调用返回前校验保存的定义、创建运行并推进一次 tick |
| `projects.pause({ id, runId })` | 项目与运行 id | `{ runId, status }` |
| `projects.resume({ id, runId })` | 项目与运行 id | `{ runId, status }` |

定义动词经 `@metaworkflow/workflow-definition` 读写，`projects.importMermaid` 经 `@metaworkflow/workflow-mermaid-import` 翻译流程图文本，运行动词委托给 `ctx.mwfScheduler`，两者都用 `ctx.get` 取用，因此没有调度器的组合仍能服务首页；`projects.coordinator` 同样读取 `ctx.mwfCoordinator`。组合两者都没有时返回 `project/workflow-unavailable`，缺失的服务在 `details.capability` 中。`ProjectSummary` 携带 `id`（即 `workspace` 命名空间所称的 `workspaceId`）、`title`、`path`、目录实时 `status`、`sessionCount`，以及 `definitionRevision`——项目存储的最新定义版本；注册表没有对应记录时为 `0`。

失败码是稳定的：没有任何注册携带该 id 时为 `project/not-found`，请求目录无法注册时为携带 `details.path` 的 `project/invalid-path`，目录已被另一个注册占用时为携带 `details.path` 的 `project/path-in-use`，标题为空或给 Python 节点写工具列表是 `gateway/bad-request`，存储自身的其余故障是 `gateway/internal`。工作流动词另外会返回 `project/definition-missing`、携带 `details.violations` 的 `project/definition-invalid`、携带 `details.nodeId` 的 `project/node-not-found`、携带 `details.runId` 的 `project/run-unavailable`、携带 `details.requestId` 的 `project/decision-unavailable`，以及携带 `details.capability` 的 `project/workflow-unavailable`。导入器拒绝流程图时返回 `project/mermaid-invalid`，其 `details.error` 给出 `code`、`message` 与（文本能定位时的）`line`；能翻译但无法运行的图则由 `details.violations` 给出校验信息。

Remote 方法名不得与它所在 namespace service 的成员冲突：`install`、`remove`、`has` 与 `empty` 已经位于该原型上，网关会拒绝复用这些名字的动词，因此注销动词是 `projects.delete` 而不是 `projects.remove`；Client 控制器仍为这次调用暴露 `remove()`。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
