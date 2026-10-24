---
description: "面向工作流 agent 节点的完成工具：`submit_node_result` 定义、两阶段提交、单调重复守卫，以及被接受的节点结果所记录的卡片元数据。"
kind: "package-library"
---

# @metaworkflow/tool-complete-node

[English](README.md) | 中文

## 概述

`@metaworkflow/tool-complete-node` 拥有工作流 agent 节点借以报告结果的唯一工具。`createCompleteNodeTool({ outputSchema, onAccept })` 返回 `submit_node_result` 定义，其唯一必填的 `value` 参数就是该节点已存储的输出 schema；`attach(childCtx)` 装上该定义、它的指令区段、单调守卫，以及只在该次提交自身的 `tools/result` 成功之后才调用 `onAccept` 的提交逻辑。普通助手文本从不构成完成，非法值就是模型可在同一回合内自行纠正的普通 `ToolArgsError`，而已经记录了结果的节点无法再提交第二个。

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

当工作流节点必须报告一个由调度器提交的结构化结果，且普通助手回答不得计为该结果时选用。当前的消费方是 [`@metaworkflow/workflow-agent-executor`](../agent-executor/README.zh.md)：它为每次激活创建一个工具，并把 `onAccept` 绑定到该次尝试的完成槽位。不要把它当作通用结构化输出工具：守卫让一个作用域只能完成一次，因此第二次激活需要第二个工具。

### 入口

| 导出 | 行为 |
|---|---|
| `createCompleteNodeTool(options)` | 构建一次尝试的工具定义，以及提交其所接受值的装配 |
| `tool.attach(childCtx)` | 在子 Agent 的作用域内注册该定义、其指令区段、其重复守卫与两阶段提交 |
| `completionInstruction(toolName)` | 命名完成工具的后置指令，供重命名该工具的部署使用 |
| `COMPLETION_TOOL_NAME` | 默认的面向模型名称 `submit_node_result` |
| `COMPLETION_TOOL_DESCRIPTION` | 默认的面向模型描述 |
| `COMPLETION_INSTRUCTION` | 默认名称对应的指令文本 |

`CompleteNodeToolOptions` 携带节点的 `outputSchema`、该次尝试的 `onAccept` 接收端，以及可选的 `name` 与 `description` 覆盖项。`CompleteNodeTool` 就是返回的定义：模型可见的每个 `ToolDefinition` 成员，外加 `attach`。`CompleteNodeResultMeta` 是被接受的提交所持久化的卡片元数据。

### 最小装配

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createCompleteNodeTool } from '@metaworkflow/tool-complete-node'
import type { JsonValue } from '@metaworkflow/util-values'

/**
 * Give one child Agent scope the node's completion tool.
 * @param childCtx - the child Agent's scope context, during its creation window.
 * @param accept - the attempt's sink for the accepted value.
 */
export function compose(childCtx: Context, accept: (value: JsonValue) => void): void {
  const tool = createCompleteNodeTool({
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    onAccept: accept,
  })
  tool.attach(childCtx)
}
```

每一处注册都属于 `attach` 运行所在的作用域，因此释放该作用域会同时移除工具、其区段、其守卫与其监听器；两个并发节点永远不会看到彼此的完成工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

**定义。** 该工具以原始 `ToolDefinition` 注册，而不是经由 `defineTool`，因为参数 schema 是节点已存储的 JSON Schema 原文，而 DSL 无法承载任意已存储 schema。其参数为 `{ value: <outputSchema> }`，`value` 必填且不接受其他属性；其规范输出为 `{ recorded: true }`，渲染为 `Node result recorded.`。

**校验。** `execute` 用同一份参数 schema 校验参数，并抛出携带路径限定违规项的 `ToolArgsError`；工具流水线会把它报告为错误结果，于是模型在同一回合内纠正该值。合法值按执行身份暂存，并由 `exec.concludeTurn()` 结束该回合。

**两阶段提交。** 暂存的值并不等于结果。`tools/result` 监听器只在该次提交自身的结果成功后才提交它，因此随后把该结果变成失败的策略什么都不留下。嵌套派发——即携带外层传输令牌的完成调用——改为随外层调用的结果提交，因此传输失败会丢弃它。先提交者胜出：单调守卫拒绝该作用域内之后的每次调用，这正是重复调用无法替换或扩展已记录结果的原因。

**卡片元数据。** `output.presentationMeta` 从提交值投影出 `{ title, summary }`，其中摘要被限制为 200 个字符的单行 JSON。该投影也会在对已记录参数的重放中运行，因此一次没有提交值的调用给出稳定占位符而不是报错；没有展示转换器的 UI 仍然回退到其通用卡片。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 工具定义、其指令、其守卫、两阶段提交以及卡片投影 |
| `src/types.ts` | 选项、返回的工具类型与持久化的卡片元数据 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流 agent 执行器](../agent-executor/README.zh.md) —— 当前消费方，把 `onAccept` 绑定到单次尝试。
- [工作流子系统](../../../docs/subsystems/workflow.zh.md) —— 这些服务所属的 seam。
- [工具编写参考](../../../docs/cookbook/adding-a-tool.zh.md) —— 面向模型的工具所满足的约定。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#metaworkflowtool-complete-node) —— 模型收到的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 完成工具 schema

#### 模型看到什么

生成的 [`submit_node_result` schema](../../../docs/tool-catalog.zh.md#metaworkflowtool-complete-node)，其唯一必填的 `value` 参数就是执行中节点已存储的 `outputSchema`。`name` 与 `description` 可以替换面向模型的标识；参数 schema 始终跟随已存储的输出 schema。

#### Token 影响

条件性。节点回合的每次请求都带有该声明，其参数 schema 随节点的输出 schema 增长。

#### KV Cache 影响

在单次节点对话内只追加。对于给定的已存储修订，该声明是稳定的，因此它保持请求前缀可复用；不同的节点、变更过的输出 schema 或被重命名的工具会产生另一条请求序列。

### 完成指令区段

#### 模型看到什么

一个位于结构化输出顺序的后置区段，命名本作用域注册的工具，并禁止纯文本收尾。

##### 完成指令

```markdown
When the node's work is complete, you MUST report its result by calling the `submit_node_result` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only that tool call counts as the node result.
```

#### Token 影响

固定。该区段是一句话，在节点对话的每次请求中重新渲染。

#### KV Cache 影响

只追加。文本在给定工具名称下固定，因此它扩展已可复用的前缀，而不是替换它。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **每个工具实例只接受一个结果** —— 守卫让一个作用域只能完成一次，因此运行多次尝试的消费方必须为每次尝试创建一个工具；复用会拒绝第二次尝试的提交。
- **没有 `presentCall` 或 `presentResult`** —— 该工具只持久化卡片元数据，因此没有专用展示转换器的 UI 会显示其通用卡片；暂无任何一方卡片消费该元数据。
- **摘要是受界限的文本** —— 元数据只保留 200 个字符的单行 JSON，而不是该值的可检索副本，因此巨大的节点结果会被概括而不是复现。
- **没有 schema 演进** —— 参数 schema 是已存储输出 schema 的原文；本包校验它，但不翻译或迁移旧节点的 schema。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

测试套件挂载真实的工具运行时与提示词注册表，然后通过 `ctx.tools.execute` 驱动该工具，因此参数校验、守卫、两阶段提交与持久化元数据都无需 Agent 循环即可断言。嵌套派发用例注册一个小型传输工具，用它自己的令牌派发完成工具，这正是 PTC 传输到达原生调用的方式。

</details>
