---
description: "面向工作流 agent 节点的决策工具：`request_decision` 定义、单一待决请求规则、它所结束的回合，以及待决请求记录的卡片元数据。"
kind: "package-library"
---

# @metaworkflow/tool-request-decision

[English](README.md) | 中文

## 概述

`@metaworkflow/tool-request-decision` 拥有工作流 agent 节点借以向项目统筹提问的唯一工具。`createRequestDecisionTool({ onRequest })` 返回 `request_decision` 定义，其 `question`、`options` 与 `detail` 参数描述节点需要的决策；`attach(childCtx)` 把该定义装到节点作用域。一次调用记录一个待决请求，返回 `{ status: 'pending', requestId }` 并结束本回合——正是这一点让节点挂起并释放它的调度执行名额。统筹的答复以输入的形式送达恢复后的尝试，而不是另一个工具结果；同一尝试中的第二次调用会被拒绝。

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

### 何时选用

当工作流节点无法仅凭自身输入决定某事，且必须由面向人的统筹在节点继续之前给出答复时选用。当前的消费方是 [`@metaworkflow/workflow-agent-executor`](../agent-executor/README.zh.md)：它为每次激活创建一个工具，并把 `onRequest` 绑定到该项目的决策行。不要把它当作通用的用户提问工具：答复会作为恢复后激活的输入送达，而且请求本身会结束回合。

### 入口

| 导出 | 行为 |
|---|---|
| `createRequestDecisionTool(options)` | 构建一次尝试的工具定义及其作用域接线 |
| `tool.attach(childCtx)` | 把定义注册到子 Agent 的作用域 |
| `DECISION_TOOL_NAME` | 默认的模型可见名称 `request_decision` |
| `DECISION_TOOL_DESCRIPTION` | 默认的模型可见描述 |
| `DECISION_CARD_TITLE` | 待决请求的展示元数据所携带的卡片标题 |

`RequestDecisionToolOptions` 携带本次尝试的 `onRequest` 汇点，以及可选的 `name` 与 `description` 覆盖。`DecisionRequest` 是汇点收到的内容：问题、节点提出的候选答案，以及它的结构化细节。`RequestDecisionTool` 是返回的定义：模型看到的每个 `ToolDefinition` 成员，外加 `attach`。`RequestDecisionResultMeta` 是待决请求持久化的卡片元数据。

### 最小组合

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createRequestDecisionTool } from '@metaworkflow/tool-request-decision'

/**
 * Give one child Agent scope the node's decision tool.
 * @param childCtx - the child Agent's scope context, during its creation window.
 * @param record - stores the request and returns its id.
 */
export function compose(childCtx: Context, record: (question: string) => Promise<string>): void {
  const tool = createRequestDecisionTool({
    onRequest: async request => await record(request.question),
  })
  tool.attach(childCtx)
}
```

每个注册都属于 `attach` 运行时所处的作用域，因此销毁该作用域即移除工具；两个并发节点永不会看到对方的决策工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

**定义。** 该工具用 `defineTool` 构建，因此参数 schema 是静态的 DSL 声明，注册表会把非法参数回填为普通的 `ToolArgsError` 结果，模型可在同一回合内纠正：`question`（必填字符串）、`options`（可选字符串数组）、`detail`（可选任意 JSON）。它的规范输出是 `{ status: 'pending', requestId }`。

**单一待决请求。** 工厂保留它已经记录的请求。第二次调用会在到达 `onRequest` 之前抛出，错误结果告诉模型等待答复而不是再次提问；工具实例属于一次尝试，因此恢复后的尝试可以重新提问。被拒绝的 `onRequest` 不记录任何内容，节点因此不会停在一个统筹从未收到的请求上。

**结束回合。** `exec.concludeTurn()` 把成功结果标记为该回合的终止结果。执行器从它自己的汇点读取已记录的请求，并向调度器报告该激活为 `waiting`；用纯文本结束回合的模型不会挂起任何东西。

**卡片元数据。** `output.presentationMeta` 从所问问题投影出 `{ title: 'Waiting for a coordinator decision', summary }`，摘要被限制在 200 个字符以内。该投影也会在重放已记录参数时运行，因此不含问题的调用会得到稳定的占位文本而不是错误。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 工具定义、单一请求规则、回合结束与卡片投影 |
| `src/types.ts` | 选项、收到的请求、返回的工具类型与持久化的卡片元数据 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流 agent 执行器](../agent-executor/README.zh.md)——当前消费方，把 `onRequest` 绑定到一次尝试的决策行。
- [工作流统筹](../coordinator/README.zh.md)——用工具答复该请求的 Session。
- [工作流调度器](../scheduler/README.zh.md)——本工具挂起的 `waiting` 激活，以及唤醒它的 `resumeActivation`。
- [工具编写参考](../../../docs/cookbook/adding-a-tool.zh.md)——面向模型的工具须满足的契约。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#metaworkflowtool-request-decision)——模型接收的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 决策工具 schema

#### 模型看到什么

生成的 [`request_decision` schema](../../../docs/tool-catalog.zh.md#metaworkflowtool-request-decision)：一个必填问题、可选的候选答案与可选的结构化细节。`name` 与 `description` 可以替换模型可见的身份。

#### Token 影响

有条件。该声明出现在节点回合的每次请求中，其结果文本会点明统筹将要答复的 requestId。

#### KV Cache 影响

在单个节点会话内只追加。声明是稳定的，因此请求前缀可继续复用。

### 恢复输入

#### 模型看到什么

提问的回合里除工具结果外没有别的内容。恢复后尝试的任务消息把统筹的答复作为又一个输入值放在 `decision` 之下，因此模型继续的是一个已知决策的回合。

#### Token 影响

每次恢复固定：恢复回合的输入块中多出一个 JSON 值。

#### KV Cache 影响

只追加。在 `retained` 记忆下，恢复回合向同一会话追加一条用户消息；在 `fresh` 记忆下则开启新会话。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **每次尝试一个请求**——同一尝试中的第二次调用会被拒绝，因此需要两个决策的节点先问一次、恢复后再问一次。
- **没有展示器**——工具只持久化卡片元数据，因此没有专用工具展示器的 UI 会显示通用卡片；M4d 工作台卡片会消费该元数据。
- **答复不做脱敏**——统筹答复的内容会原样进入恢复后节点的输入，因此统筹不得在答复中放入凭据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

测试套件挂载真实的工具运行时与提示注册表，然后通过 `ctx.tools.execute` 驱动工具，因此参数校验、单一请求规则、回合结束与持久化的元数据都在没有 Agent 循环的情况下得到断言。被拒绝汇点的用例让首次调用失败后再次提问，从而钉住"不记录任何内容"的保证。

</details>
