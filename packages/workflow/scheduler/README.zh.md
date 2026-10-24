---
description: "把已存储的工作流定义在 host 上编排成可恢复的运行：哪些激活就绪、由哪个执行器执行、同时跑几个、失败重试几次、循环何时耗尽，以及一次提交的 attempt 会向项目库写入什么。"
kind: "package-reference"
---

# @metaworkflow/workflow-scheduler

[English](README.md) | 中文

## 概述

`ctx.mwfScheduler` 把一份已存储的定义修订变成可暂停、继续、单步、重试、取消并在重启后恢复的运行。它决定哪些激活就绪、由哪个执行器执行节点、同时跑几个、失败重试几次，以及循环何时耗尽。每个决定都与 attempt 的结果、它的 outbox 事件和它路由出的激活在同一个事务里落到项目库。执行器是一处接缝：本包不自带任何实现。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 组装中把它挂在 `@metaworkflow/workflow-project-store` 旁边，并为每种节点类型注册一个执行器；调用方通过 `ctx.mwfScheduler` 驱动它。

### 何时选用

当一个工作流必须作为一份可恢复的运行跑在存储的图上、而节点究竟做什么由调用方决定时选用它。它不自带 Python 或 Agent 执行器：调度器既不 import `@metaworkflow/workflow-python-runner`，也不 import 任何 Agent 包，因此由组合注册它要运行的节点类型；某个就绪激活的类型没有执行器时，它的运行以 `scheduler/executor-missing` 失败，而不是一直等待。不要把它当通用任务队列：它调度一个项目的工作流图，并且只写工作流相关的行。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-scheduler'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrent` | `4` | 一个运行同时进行的节点执行数 |
| `maxAttempts` | `2` | 一个激活失败前可用的 attempt 次数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-scheduler)是全部可接受字段的权威来源。

### 服务 API

| 方法 | 行为 |
|---|---|
| `createRun({ projectId, definitionRevision, params? })` | 校验该修订，在一个事务里写入运行与入口激活，返回 `{ runId }` |
| `tick({ projectId, runId })` | 推进运行直到没有可启动的工作，同时最多 `maxConcurrent` 个 |
| `step({ projectId, runId, activationId })` | 执行一个就绪激活，然后把运行置为 `paused` |
| `pause` / `resume` / `cancel({ projectId, runId })` | 停止调度并中止在途 attempt、重新打开已暂停的运行，或取消所有未完成的激活 |
| `retry({ projectId, runId, activationId })` | 把失败、取消或等待中的激活作为新 attempt 重新执行，并返回其 id |
| `resumeActivation({ projectId, runId, activationId, decision? })` | 用它索要的答复唤醒等待中的激活、把该答复存到它的行旁，并推进运行 |
| `reconcile({ projectId })` | 把 running attempt 标为 `interrupted`、其激活回到 `pending`、运行置为暂停，并回报改动——等待中的激活保持原状并单独回报 |
| `getRun` / `listActivations` / `listAttempts` | 读回运行、它的激活与 attempt |
| `registerExecutor(executor)` | 为一种节点类型注册执行器并返回 disposer |

`createRun`、`step`、`resumeActivation`、`retry` 以带类型的 `WorkflowSchedulerError` 拒绝：`scheduler/definition-unavailable`、`scheduler/definition-invalid`、`scheduler/activation-not-found`、`scheduler/activation-not-ready`、`scheduler/activation-not-retryable`、`scheduler/activation-not-resumable`、`scheduler/run-not-found`、`scheduler/run-state-invalid`、`scheduler/duplicate-executor` 或 `scheduler/closed`。节点自身的失败不是异常：它会被提交、出现在 `TickResult.diagnostics` 里，并使运行失败。

### 执行器接缝

```ts
import type { NodeActivation, NodeInputs, NodeResult } from '@metaworkflow/workflow-scheduler'

interface NodeExecutor {
  readonly kind: 'python' | 'agent'
  execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult>
}
```

`NodeResult` 是 `{ status: 'succeeded', value, artifacts? }`、`{ status: 'failed', error, retryable }` 或 `{ status: 'waiting', requestId }`。成功的结果是路由读取、并由后续激活消费的 JSON 值；`artifacts` 以稳定名称发布文件。可重试失败在预算内再消耗一个 attempt。等待中的结果点明节点所问的决策：attempt 与激活变为 `waiting`，执行名额被释放，不提交结果，而 `resumeActivation` 带着答复让节点继续。

等待中的激活从不满足 join。若 `all` join 声明的某个前驱仍在等待，它便不会触发，因此它的目标只有在恢复后的激活成功之后才启动；`waiting` attempt 也不是中断的 attempt，因此恢复流程会原样保留它。

执行器必须观察 `signal` 并结清：暂停、取消或释放服务都会中止它，之后再到达的结果属于过时结果。

### 已提交的结果

一次成功的 attempt 在同一个 `BEGIN IMMEDIATE` 批次里提交它的结果、它的激活状态迁移、它发布的产物、它的路由创建或扩展的激活，以及一行 `session_outbox`。`(attempt_id, event_seq)` 是 outbox 的幂等键，载荷形如 `{ type: 'scheduler/attempt-result', … }` —— 这是一个投递载荷，不是 `SessionEventMap` 成员。写入失败会整批回滚，因此不会留下半提交的结果。

当 attempt 已不再运行、或运行已切换到另一个定义修订时，结果会以 `scheduler/stale-result` 被拒绝。这正是暂停或取消后的 attempt 无法发布结果的原因。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

### 设计要点

- **一次状态变更就是一个事务。** `ctx.mwfProjectStore.transact` 让调度器的行跑在库的唯一写连接上，连接、串行化与回滚仍然由项目库负责。
- **就绪是算出来的，不存储。** 当激活处于 pending、其冻结的入边集合已成功，且（对 `all` join）本轮没有任何已声明前驱仍然开着时，它就绪。因此 join 状态不需要单独的列或修复路径。
- **迭代是标识的一部分。** 一个激活是 `(runId, nodeId, iteration)`；loop 边进入 `source + 1`，入边引用携带它记录时的迭代，因此旧轮次永远无法满足新轮次的 join。
- **图是钉住的。** 一个运行只执行它创建时的修订，若运行已切到别处，提交会被拒绝。
- **名额按运行计。** 一次推进最多派发 `maxConcurrent` 个执行，并在每个结清时接纳下一个就绪激活；等待中的节点会交还名额。

### 调度循环

一次推进读取运行与它的激活，在名额允许范围内启动所有就绪激活，然后等待一个在途执行结清再重新判断。运行结清、暂停，或只剩等待中的工作时它停止。单步会指名一个激活、只执行它，然后把运行置为暂停。同一运行上的并发推进会串行执行。

### 失败处理

解析不到值的输入绑定以 `scheduler/input-missing` 让该激活失败；路由失败（`routing/ambiguous`、`routing/no-match`）带诊断让运行失败；会超过 `maxIterations` 的循环以 `scheduler/loop-exhausted` 让运行失败；节点失败在可重试且预算未耗尽时重试，否则让该激活与运行失败。失败的分支不会阻塞已经开始的兄弟分支，已提交的结果始终可读。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件、配置、服务方法与调度循环 |
| [`src/schedule.ts`](src/schedule.ts) | 就绪、迭代、路由原因与结清判断 |
| [`src/inputs.ts`](src/inputs.ts) | 从结果、运行参数与产物组装输入 |
| [`src/records.ts`](src/records.ts) | 项目库上的行语句 |
| [`src/executors.ts`](src/executors.ts) | 每种节点类型一个执行器 |
| [`src/errors.ts`](src/errors.ts) | 带类型的拒绝 |
| [`src/types.ts`](src/types.ts) | 请求、视图、执行器接缝与诊断 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流子系统](../../../docs/subsystems/workflow.zh.md) —— 调度器所接入的能力面。
- [工作流项目库](../project-store/README.zh.md) —— 每个运行所在的数据库。
- [工作流定义](../definition/README.zh.md) —— 本包执行的文档、路由与 join 运算。
- [Python 节点运行器](../python-runner/README.zh.md) —— 下一阶段为 `python` 节点注册的执行器。
- [生成的配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-scheduler) —— 全部可接受字段。

-----

<a id="model-experience"></a>
## 模型体验

无：调度器只写工作流行，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

这里不组装模型请求，因此没有缓存前缀会被改变；真正访问模型的执行器负责由此产生的失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

未注册执行器的组合会让每次激活都以 `scheduler/executor-missing` 失败；Python 与 Agent 执行器是与本包并排挂载的独立包。

- **没有退避** —— 可重试失败立即重试，唯一的限制是 attempt 预算。
- **一份答复恢复一个激活** —— `resumeActivation` 按 id 指定一个等待中的激活；有多个等待节点的图需要每个节点各调用一次，因为对同一份工作重复答复会运行一个其问题已不是被答复问题的节点。
- **决策只在作为输入时跨过答复进程** —— 答复存放在激活行旁并交给下一次 attempt，并在某次 attempt 提交时清除；答复已提交之后调度器进程崩溃也仍能带着它恢复，但若激活在此期间被取消，则不会重放该答复。
- **first-success 目标可能等不到输入** —— 在第一个已提交分支上触发，意味着绑定到另一个仍未完成分支的输入解析为空，并让该激活以 `scheduler/input-missing` 失败。
- **一个运行只认一个修订** —— 运行不会重读定义，因此运行中编辑工作流会以 `scheduler/stale-result` 被拒绝，而不是施加到受影响的激活上。
- **不修复会话** —— `reconcile` 只回报被中断的 attempt 并把运行置为暂停；恢复节点自己的对话是执行器的职责。
- **产物只是引用** —— 发布的产物按名称、版本与相对路径记录；调度器既不写也不校验该文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

测试套件通过假执行器在真实的临时数据库上驱动服务，因此每个用例都是确定的：延迟执行器把激活留在在途状态，测试则在此期间暂停、取消、对账或改动运行的修订。`tests/transaction.spec.ts` 用 SQLite 触发器注入 outbox 写入失败，以证明整个提交作为一个批次回滚。

</details>
