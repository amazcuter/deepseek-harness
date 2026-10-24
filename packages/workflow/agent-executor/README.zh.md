---
description: "为调度器运行工作流 agent 节点：注册 agent 节点类型，按节点的指令、工具白名单、记忆策略与完成工具为每次激活装配一个受限的 DSH 子 Agent，并提交该工具接受的结构化结果。"
kind: "package-reference"
---

# @metaworkflow/workflow-agent-executor

[English](README.md) | 中文

## 概述

`ctx.mwfAgentExecutor` 把工作流调度器接到 Agent 运行时上。调度器拥有就绪判断、重试、循环与持久行；本插件提供 `agent` 节点类型，让一次就绪的激活变成按节点已存储配置装配出的一个子 Agent。子 Agent 拿到的是：作为人格设定的节点指令、只做能力选择而不推导权限的工具白名单、记忆策略、以节点 `outputSchema` 为 `value` 参数的完成工具，以及它借以向项目统筹提问的决策工具。节点结果就是完成工具记录的值；决策请求则让激活挂起。

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

在已经装配了 Agent 运行时的 Host 组合里，把它挂在 `@metaworkflow/workflow-project-store` 与 `@metaworkflow/workflow-scheduler` 旁边：该运行时包含 Agent 注册表、持久 Session 后端、提示词与工具注册表，以及部署默认模型。它自己完成注册；没有调用方直接驱动它。

### 何时选用

当已存储定义里的 `agent` 节点必须真正以 Agent 身份运行，且调度器的重试、循环上限与重启恢复必须作用在它们身上时选用。不要在缺少持久 Session 后端的情况下挂载它：`retained` 节点会延续它记录过的对话，因此一个无法重新载入会话的后端会让该节点的下一次激活变成 `agent/session-unavailable`。不要用它来隔离不可信定义——子 Agent 通过部署注册的工具、以主机用户的权限运行——也不要把它当作通用 Agent 运行器，因为它只运行调度器已经决定要启动的那一次激活。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-agent-executor'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `turnTimeoutMs` | `600000` | 单次节点回合的墙钟期限；超期会取消该回合并报告可重试的 `agent/timeout` |

生成的[配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-agent-executor)是全部可接受字段的完整来源。

### 服务 API

| 成员 | 行为 |
|---|---|
| `execute(activation, inputs, signal)` | 读取运行所存储的定义修订、打开项目目录、装配子 Agent、驱动一个回合，并返回 `{ status: 'succeeded', value }`、`{ status: 'waiting', requestId }` 或 `{ status: 'failed', error, retryable }` |
| `nodeSessions` | `ctx.mwfNodeSessions` 注册表：每个运行中的子 Agent 会话为哪一次尝试服务 |

调度器通过已注册的 `agent` 执行器到达 `execute`；该公开方法存在，是为了让调用方不必驱动整次运行就能测试单次激活。中止是唯一的抛出：被中止的信号报告中止而不是节点失败，因为被暂停或取消的运行不得记录节点失败。`ctx.mwfNodeSessions` 注册在本插件自己的作用域内，因此完成工具与执行器天然共享它。

### 一次执行报告什么

| 结果 | 报告 |
|---|---|
| 完成工具接受了一个值 | `succeeded`，携带该值 |
| 决策工具记录了请求 | `waiting`，携带该 request id；调度器释放名额，`resumeActivation` 让节点继续 |
| 项目数据库无法记录决策请求 | 工具在同一回合内向模型报告 `agent/decision-unavailable`，因此节点可以在没有记录任何请求的情况下继续 |
| 回合结束但没有完成 | `failed` `agent/completion-missing`，可重试 |
| 循环以错误结束了回合 | `failed` `agent/turn-failed`，可重试 |
| 回合触及模型的输出 token 上限 | `failed` `agent/turn-failed`，可重试 |
| 回合被本执行器之外的调用取消 | `failed` `agent/canceled`，不可重试 |
| 超过期限 | `failed` `agent/timeout`，可重试 |
| 节点工具白名单命名了部署未注册的工具 | `failed` `agent/composition-failed`，不可重试 |
| 运行、其修订、节点或项目目录已不存在 | `failed` `agent/run-unavailable`、`agent/stale-activation`、`agent/definition-unavailable`、`agent/node-unavailable` 或 `agent/project-unavailable`，不可重试 |
| 子 Agent 无法创建或恢复 | `failed` `agent/session-unavailable` |

失败从不以异常形式逃出，因此一个坏节点无法中断同一运行的其他工作；调度器会提交该失败并决定下一步。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务持有三样东西：解析后的期限、与调度器之间的一次 `ctx.effect` 注册，以及它在自己作用域内创建的 `mwfNodeSessions` 注册表。销毁插件会反注册 `agent` 类型并丢弃注册表，因此被替换的组合既不会留下重复执行器，也不会留下过期的会话记录。

**定义权威。** 执行器不运行它接到的节点对象。它读取运行所记录的修订、拒绝命名了其他修订的激活（`agent/stale-activation`）、读取该修订已存储的文档，并从文档里取节点的 `config`。修订缺失、无法解析或没有该节点，都是结构化失败，而不是回退到激活自带的那份副本。

**装配。** 创建与恢复都会执行同一个作用域内 setup 回调，因此被恢复的会话与全新会话完全一致地重建：节点的 `instructions` 成为 persona 前缀顺序上的 `workflow:node-instructions` 提示词段并关闭插值，完成工具及其指令段注册在子 Agent 的作用域上，`tools.restrict({ allow })` 把子 Agent 限制在节点的工具名内。白名单只做选择，不推导权限，因此沙箱、审批或模型选择仍归工具本身。由于所有注册都属于子 Agent 的作用域，一个节点的工具开关永远不会到达另一个节点，销毁子 Agent 就会移除它们。

**模型路由。** 本阶段的工作流定义不携带自己的模型，因此每个子 Agent 都使用部署默认选择（`ctx.agentDefaultModel`），包括其可选推理力度。

**记忆。** `fresh` 为每次激活新建会话且不记录任何东西。`retained` 读取项目 `schema_meta` 兼容行中该运行与该节点的记录：有记录的会话通过 `ctx.agents.resume()` 恢复；首次激活则先创建并在回合开始前记录。运行本身是键的一部分，因此同一定义的两个运行不会共用对话；循环迭代不是，因此 `retained` 节点在其所属运行的多次激活之间保持同一次对话。恢复遵循 Agent 运行时既有语义：尾部未闭合的日志由循环补上闭合，执行器从不自行修复会话日志。

**决策。** [`@metaworkflow/tool-request-decision`](../tool-request-decision/README.zh.md) 提供每个子 Agent 都有的 `request_decision` 工具。它的 `onRequest` 闭包写入一行 `decisions`、点明本次激活与 attempt，发出 `workflow/decision-requested`，并把 request id 交回，由本次尝试的单元保存。以已记录请求结束的回合是 `waiting`：执行器不提交结果，调度器释放执行名额，统筹的答复以 `decision` 的形式成为恢复后尝试的输入。调度器为该激活存下的答复会被合并进任务消息的输入块，因此 `fresh` 节点开启一段知道决策的新对话，`retained` 节点则延续自己的对话。

**血缘。** 子会话的 `parentSession` 指向项目的统筹 Session——部署挂载了统筹时经由 `ctx.get('mwfCoordinator')` 解析。未挂载统筹的组合会让节点无父会话地运行，而不是失败。

**完成。** 工具本身位于 [`@metaworkflow/tool-complete-node`](../tool-complete-node/README.zh.md)：每次激活都用节点已存储的 `outputSchema` 与一个写入本次尝试完成槽位的 `onAccept` 闭包创建一个实例。该包拥有 `{ value: <outputSchema> }` 参数 schema、`ToolArgsError` 回填、`tools/result` 之后的两阶段提交，以及单调重复守卫；执行器只消费被接受的值，而 `exec.concludeTurn()` 让该回合就此终止。调度器在自己的事务里把该值提交为这次尝试的结果，因此完成与尝试行要么一起落盘，要么都不落盘。

**生命周期。** 一次调用就是一个回合。执行器发出任务消息、等待 Agent 归于一静、读取结果，然后销毁 Agent 句柄——`retained` 节点保留的是会话，不是 Agent。调度器的中止信号会取消回合随后被重新抛出，期限则先取消回合再报告 `agent/timeout`。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件、执行器注册、装配、回合驱动、结果映射 |
| `src/node-sessions.ts` | `ctx.mwfNodeSessions`，会话到尝试的在线注册表 |
| `src/retained-sessions.ts` | 项目数据库中持久的 retained 会话映射 |
| `src/types.ts` | 配置、失败码与会话记录 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流子系统](../../../docs/subsystems/workflow.zh.md) —— 这些服务所属的接缝。
- [工作流调度器](../scheduler/README.zh.md) —— 派发本插件所运行激活的一方。
- [工作流项目存储](../project-store/README.zh.md) —— 定义修订、运行与 retained 会话行所在之处。
- [工作流定义](../definition/README.zh.md) —— 本执行器读取的 agent 节点配置。
- [节点完成工具](../tool-complete-node/README.zh.md) —— 每个子 Agent 用来报告结果的工具。
- [决策工具](../tool-request-decision/README.zh.md) —— 子 Agent 借以向项目统筹提问的工具。
- [工作流统筹](../coordinator/README.zh.md) —— 答复这些问题并作为子会话父会话的 Session。
- [生成的配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-agent-executor) —— 全部可接受字段。

-----

<a id="model-experience"></a>
## 模型体验

### 节点指令段

#### 模型看到什么

节点已存储的 `config.instructions`，注册为 persona 前缀顺序上的 `workflow:node-instructions` 段并关闭插值，因此定义里的文本原样到达模型，部署提示词变量不会改写它。文本本身是项目数据，本包只负责它的位置与生命周期。

#### Token 影响

持久：该段在节点对话的每次请求上都会重新渲染，因此只要对话持续，它的开销就按每次模型调用计一次。

#### KV Cache 影响

追加式。给定已存储修订时该段文本固定，因此它扩展已经可复用的前缀而不是替换它；新的定义修订、另一个节点，或 `fresh` 节点新建的会话，都会开始独立的请求序列。

### 完成工具

#### 模型看到什么

生成的 [`submit_node_result` schema](../../../docs/tool-catalog.zh.md#metaworkflowtool-complete-node)，其唯一必填参数 `value` 就是节点已存储的 `outputSchema`；此外还有一段尾部指令，指明该工具并禁止用纯文本收尾。[`@metaworkflow/tool-complete-node`](../tool-complete-node/README.zh.md) 同时拥有两者；本包只决定每个子 Agent 中都必须存在它们。

#### Token 影响

条件式。该声明出现在节点回合的每次请求上，其参数 schema 随节点的输出 schema 增长；指令段是固定的一句话。

#### KV Cache 影响

单个回合内追加式。声明与指令在整个对话中稳定，因此前缀保持可复用；另一个节点的输出 schema、或改变它的定义修订，都会产生不同的请求序列。

### 决策工具

#### 模型看到什么

生成的 [`request_decision` schema](../../../docs/tool-catalog.zh.md#metaworkflowtool-request-decision)，其唯一必填问题携带节点提出的可选候选答案与结构化细节。[`@metaworkflow/tool-request-decision`](../tool-request-decision/README.zh.md) 拥有该定义及其卡片元数据；本包只决定每个子 Agent 中都必须存在它。

#### Token 影响

条件式。该声明出现在节点回合的每次请求上，工具结果会点明统筹将要答复的 request id。

#### KV Cache 影响

单个回合内追加式。声明在整个对话中稳定。

### 任务消息

#### 模型看到什么

一条 user 角色的消息，指明节点、其 `iteration` 与 `attempt` 编号，并以 JSON 代码块给出该次激活组装出的输入值。恢复后的尝试会把统筹的答复作为该块中的又一个值，放在 `decision` 之下。

#### Token 影响

持久：该消息每次激活追加一次并留在对话历史中，因此 `retained` 节点会在其后的每次请求上继续为它付费。

#### KV Cache 影响

追加式。每次激活都在上一回合之后追加新消息，因此更早的前缀保持可复用；JSON 载荷随激活而变，因此永不匹配更早请求的尾部。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **部署级模型** —— 节点无法自行选择提供方、模型或推理力度；每个子 Agent 都使用 `ctx.agentDefaultModel`，直到定义模型长出 model 字段。
- **不发布产物** —— 节点只报告 JSON 值，因此子 Agent 写出的文件不会作为 `NodeArtifact` 记录发布，`artifact` 输入绑定也没有可读的内容。
- **每次尝试一个请求** —— 提出决策的节点每个回合挂起一次；第二个问题需要再走一次激活，恢复后的尝试提供了它。
- **名为 `decision` 的绑定会被覆盖** —— 恢复后尝试的输入块在 `decision` 下携带统筹的答复，因此同时声明了同名输入绑定的节点看到的是答复而不是自己的值。
- **每次激活一个回合** —— 执行器只发一条任务消息且从不引导，因此既没有完成、也没有决策请求就结束回合的子 Agent 会以 `agent/completion-missing` 失败，而不是让激活挂起。
- **不捕获权限状态** —— 子 Agent 继承组合为其作用域授予的权限；本阶段不会把委派策略写入会话日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

各测试套件在同一个临时 home 上装配真实的 Agent 循环、JSONL 会话后端、项目存储、调度器与执行器，并通过脚本化适配器驱动模型调用，因此装配、记忆、完成与结果映射都无需提供方即可断言。retained 记忆用例使用一条循环边，因为循环迭代是让同一次运行两次激活同一节点的唯一方式。损坏介质用例通过第二个关闭外键的 SQLite 连接写入，这就是用例复现活着的存储会拒绝破坏的定义行或映射行的方式。

</details>
