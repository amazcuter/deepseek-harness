---
description: "每个工作流项目一个持久的统筹 Session：它记录的 Session 身份、答复与列出决策的工具、UI 订阅的事件，以及答复如何恢复等待中的节点。"
kind: "package-reference"
---

# @metaworkflow/workflow-coordinator

[English](README.md) | 中文

## 概述

`ctx.mwfCoordinator` 为每个工作流项目提供一个持久的统筹 Session：一段负责规划项目工作流、答复节点提出的决策，并报告项目运行与激活的会话。该 Session 把自身身份记录在项目数据库中，因此下一个进程会恢复同一段会话。它的工具答复待决决策、列出仍在等待的请求，并报告项目状态；答复会通过调度器恢复等待中的激活。agent 节点把自己的会话挂到该 Session 之下，两个事件都不进入 Session 日志，因此 UI 订阅而不是轮询。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它与项目存储、调度器一起挂到 Host 组合中；不需要其他东西，服务会在首次使用时打开某个项目的 Session。

### 何时选用

当工作流节点必须把决策上报给一段比任何单次节点回合都更长寿、面向人的会话，且该会话需要项目状态与恢复工作的能力时选用。当每个节点都能凭自身输入得出结论时就别用它：统筹是一个真实的 Agent 会话，其模型成本按统筹回合计，而非按节点计。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-coordinator'
```

该插件不接受配置：它的 Session 模型路由来自部署默认模型，每个项目得到同一套组合。

### 服务 API

| 方法 | 行为 |
|---|---|
| `ensureSession(projectId)` | 打开该项目的统筹 Session：首次使用时创建并记录一个，之后再恢复已记录的那个 |

### 统筹 Session 获得的工具

| 工具 | 行为 |
|---|---|
| `answer_decision({ requestId, answer })` | 记录答复，通过 `ctx.mwfScheduler.resumeActivation` 恢复等待中的激活，并广播该答复。未知的 id 会被拒绝，重复答复会回报已记录的答复而不改变节点收到的内容 |
| `list_pending_decisions()` | 按从旧到新列出项目中每个未答复的请求，含问题与节点提出的选项 |
| `get_project_state()` | 报告项目、每个运行及其状态与原因，以及最新运行的激活与各自的 attempt 数 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

**每个项目一个 Session。** Session 身份保存在项目数据库 `schema_meta` 的 `coordinator/session` 行中，也就是该存储为每个项目的附属表使用的兼容记录。首次 `ensureSession` 会在新的 id 下创建 Agent，并在答复任何内容之前记录它；之后每次调用都会恢复它，因此统筹的计划能跨重启、插件重载与不同的后端进程存活。并发调用方共享同一次进行中的打开，因此一个项目不会有两个统筹。

**作用域。** 该 Session 的工具与提示区段在创建期间注册在它自己的 Agent 作用域里。它们闭包捕获项目 id，因此统筹只能答复自己项目的决策，其他 Agent 也看不到它们。

**答复。** `answer_decision` 先向存储索取首次答复，随后带着它恢复激活。存储的首次答复具有权威性：重复调用会回报已记录的答复而不是替换它，未知的 request id 不写入任何内容。恢复后的尝试以输入的形式收到答复，因此节点继续的是一段知道决策的会话。

**事件。** `workflow/decision-answered` 携带项目、运行、激活、request id、答复，以及恢复后的运行状态。节点执行器发出配对的 `workflow/decision-requested`；两个事件都不是 `SessionEventMap` 成员。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、Session 的打开与恢复、提示，以及答复事件 |
| [`src/tools.ts`](src/tools.ts) | 三个面向模型的工具及其项目绑定 |
| [`src/session-store.ts`](src/session-store.ts) | 让一个 Session 持久化的 `schema_meta` 记录 |
| [`src/types.ts`](src/types.ts) | 待决决策、项目状态与答复事件 payload |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流项目存储](../project-store/README.zh.md)——本包读写其决策行与 `schema_meta` 记录。
- [工作流调度器](../scheduler/README.zh.md)——`resumeActivation` 与答复所唤醒的 `waiting` 激活。
- [工作流 agent 执行器](../agent-executor/README.zh.md)——`workflow/decision-requested` 的生产者，以及本 Session 作为父会话的节点会话。
- [决策工具](../tool-request-decision/README.zh.md)——节点借以提问的工具。
- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——这些服务所属的 seam。

-----

<a id="model-experience"></a>
## 模型体验

### 统筹提示区段

#### 模型看到什么

一个位于部署 persona 顺序的区段，点明项目、其工作目录与统筹的职责：设计与修复项目工作流、答复节点提出的决策、报告状态、自行修复节点，并把结构性工作流改动留给用户的明确请求。该区段不做插值，因此标题中含花括号的项目也会保持字面文本。

#### Token 影响

每个统筹请求固定：该区段在该会话的每个回合重新渲染。

#### KV Cache 影响

只追加。项目标题与路径对单个项目是稳定的，因此该区段扩展的是可复用的前缀，而不是替换它。

### 统筹工具

#### 模型看到什么

三个声明——`answer_decision`、`list_pending_decisions` 与 `get_project_state`——都以统筹的措辞点明决策生命周期。`answer_decision` 说明答复会成为等待节点的下一份输入，且一次答复只记录一次。

#### Token 影响

有条件。这些声明出现在每个统筹请求中；`list_pending_decisions` 的结果文本随待决问题数量增长。

#### KV Cache 影响

在单个统筹会话内只追加；声明稳定，待决列表是可复用前缀之后的回合本地内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

统筹是一段会话，不是调度器：它不自行启动任何工作。

- **尚无工作台界面**——随产品发布的 Web 界面还没有驱动统筹回合的入口。该服务及其事件存在的意义，是让下一阶段的工作台订阅并向同一 Session 写入消息。
- **每项目一个 Session，历史无上限**——本包不对会话做压缩，长项目依赖部署的压缩策略。
- **统筹不能取消工作**——它只答复决策并报告状态；暂停、取消或重试一个运行属于调度器及其调用方。
- **答复只投递一次**——恢复后再次提问的节点会创建新请求；早先的答复是历史，不是回退。
- **被拒绝的恢复只报告、不修复**——`answer_decision` 先记录答复再恢复激活；当调度器因激活已不再等待而拒绝时，工具报告该拒绝，节点可通过调度器自己的 `retry` 到达，而 `retry` 不投递任何答复。
- **删除项目不联动统筹**——删除项目会留下它的 Session 日志，因为该文件归 Session 后端所有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

测试套件按完整的产品顺序挂载——持久化、循环、存储、调度器、执行器，最后是本插件——并用脚本化 transport 驱动真实的子 Agent。决策由 agent 节点提出，由调用 `answer_decision` 的统筹回合答复，然后断言运行收敛，因此答复路径是端到端覆盖的，而不是只测工具本身。脚本化 transport 按角色把每次模型调用路由到各自的队列，因为答复在统筹自己的调用仍在进行时就会恢复节点。

</details>
