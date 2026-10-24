---
description: "面向项目定义文档的纯工作流图模型：JSON 记录、判定图是否可执行的校验器，以及调度器需要的路由与汇合运算。"
kind: "package-library"
---

# @metaworkflow/workflow-definition

[English](README.md) | 中文

## 概述

使用 `@metaworkflow/workflow-definition` 存储、校验并路由一张工作流图。`parseDefinitionDocument` 只接受 JSON 文本，校验全部规则后返回带类型定义；`route` 把一个节点结果转换为其出边激活的目标；`computeJoin` 报告节点的入边何时满足。本包是纯函数库：不调度、不执行节点、不注册服务，也从不求值表达式——条件只比较 JSON 字段。定义以 JSON 传递，因此不需要 YAML 依赖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

需要存储工作流文档、或需要决定下一步执行什么的调用方，导入本包而不是自行推导图规则。工作流调度器阶段（M4）是预期消费方：它从 `ctx.mwfProjectStore` 读取某个修订的文档，在此解析，再向 `route` 与 `computeJoin` 询问应激活什么。编辑器与导入器使用 `validateDefinition` 解释一个无法运行的文档。

### 入口

```ts
import type { JsonValue } from '@metaworkflow/util-values'
import { parseDefinitionDocument, route } from '@metaworkflow/workflow-definition'

declare const documentText: string
declare const nodeResult: JsonValue

const parsed = parseDefinitionDocument(documentText)
if (!parsed.ok) {
  for (const violation of parsed.violations) console.error(`${violation.code} at ${violation.path}: ${violation.message}`)
} else {
  const [entry] = parsed.definition.nodes
  if (entry !== undefined) {
    const decision = route(nodeResult, entry, parsed.definition.edges)
    if (decision.failure !== null) console.error(decision.failure.code, decision.failure.candidates)
  }
}
```

`parseDefinitionDocument` 返回 `{ ok: true, definition }` 或 `{ ok: false, violations }`；它从不抛出，也从不修补文档。`serializeDefinition` 写出规范文本（对象键排序、节点与边顺序保留），因此相等的定义产生相同的存储修订。

### 文档

| 值 | 字段 |
|---|---|
| `WorkflowDefinition` | `version: 1`、`nodes`、`edges` |
| `WorkflowNode` | `id`、`kind`（`python` \| `agent`）、`title`、`config`、`inputs`、`join`（`all` \| `first-success`） |
| python `config` | `source`——包含 `def nodemain_<nodeId>(` 的 Python 文本 |
| agent `config` | `outputSchema`、`instructions`、`tools`、`memory`（`retained` \| `fresh`） |
| `InputBinding` | `name`、`source` = `{ kind: 'node', nodeId, field }` \| `{ kind: 'run', key }` \| `{ kind: 'artifact', name }` |
| `WorkflowEdge` | `id`、`from`、`to`、`condition`、`mode`（`exclusive` \| `multiple`）、可选 `fallback`、可选 `loop: { maxIterations }` |
| `Predicate` | `{ op, field, value? }`，`op` 取 `eq ne gt gte lt lte in not-in exists truthy`；`{ op: 'and' \| 'or', args }`；`{ op: 'not', arg }` |

字段路径用点号分隔（`review.passed`、`items.0.name`），只读取 JSON 对象属性与数组下标。路径是数据：任何内容都不会被当作代码求值。

子集检查委托给 `@metaworkflow/tools` 的 `assertSupportedJsonSchema`，因此 agent 节点接受的 schema 与 subagent 结构化输出完全一致；`definition/schema-unsupported` 携带共享校验器自带的带路径原因。

`outputSchema` 使用 `@metaworkflow/tools` 与 subagent 结构化输出共享的强制 JSON Schema 子集：单一标量 `type`、对象 `properties`/`required`/布尔 `additionalProperties`、数组 `items`、标量 `enum`/`const`、恰好一个 `oneOf`，以及 `description`、`title`、`default`、`examples` 注解。根必须是 `type: "object"`。任何其他关键字都是违规，因此文档绝不会携带运行器不执行的规则。

### 校验

`validateDefinition(value)` 接受来源未知的值，报告它违反的每一条规则，每条都带稳定错误码与文档路径（例如 `edges[2].condition.field`）。

| 错误码 | 规则 |
|---|---|
| `definition/document-invalid` | 文档必须是 JSON 对象 |
| `definition/version-unsupported` | `version` 必须是 `1` |
| `definition/nodes-invalid`、`definition/edges-invalid` | 两者都必须是数组 |
| `definition/node-invalid`、`definition/edge-invalid` | 数组成员必须是对象 |
| `definition/node-id-invalid`、`definition/edge-id-invalid` | id 必须匹配 `^[a-z][a-z0-9_-]*$` |
| `definition/duplicate-node`、`definition/duplicate-edge` | id 唯一 |
| `definition/node-kind-invalid`、`definition/node-config-kind-mismatch` | `kind` 为 `python` 或 `agent`，且与 `config.kind` 相同 |
| `definition/node-title-empty` | 标题非空 |
| `definition/node-join-invalid` | `join` 为 `all` 或 `first-success` |
| `definition/node-config-invalid` | `config` 是对象 |
| `definition/python-source-empty`、`definition/python-entry-missing` | Python 源码非空且定义 `def nodemain_<nodeId>(` |
| `definition/agent-instructions-empty`、`definition/agent-memory-invalid`、`definition/agent-tools-invalid` | agent 指令非空、memory 为 `retained` 或 `fresh`、tools 是唯一且非空的名称 |
| `definition/schema-invalid`、`definition/schema-root-not-object`、`definition/schema-unsupported` | 输出 schema 是支持子集内的对象根 schema |
| `definition/node-inputs-invalid`、`definition/input-name-invalid`、`definition/duplicate-input` | inputs 是名称唯一的绑定数组 |
| `definition/input-source-invalid`、`definition/run-key-empty`、`definition/artifact-name-empty` | 每个来源指明节点、非空 run key 或非空 artifact |
| `definition/input-field-invalid` | 节点输入字段是点号分隔路径 |
| `definition/input-node-not-ancestor` | 节点输入读取祖先的结果 |
| `definition/condition-invalid`、`definition/condition-field-invalid`、`definition/condition-value-invalid`、`definition/condition-args-invalid`、`definition/condition-too-deep` | 条件使用已知 op、路径字段、类型匹配的值、非空 `args` 与有界嵌套 |
| `definition/edge-endpoint-missing` | 两端都指向已声明的节点 |
| `definition/edge-mode-invalid`、`definition/mixed-edge-modes` | mode 已知，且同一节点只用一种 mode |
| `definition/self-loop` | 非 loop 边不得指向自身来源 |
| `definition/fallback-invalid`、`definition/fallback-condition`、`definition/fallback-mode`、`definition/multiple-fallback-edges` | 每节点至多一条 fallback，仅限 exclusive，且从不带条件 |
| `definition/loop-invalid`、`definition/loop-max-iterations-invalid`、`definition/loop-edge-mode`、`definition/loop-target-not-ancestor`、`definition/multiple-loop-edges` | loop 只声明 `maxIterations`（至少为 1 的整数）、使用 `multiple` mode、回边进入祖先，且每节点唯一 |
| `definition/no-entry-node`、`definition/multiple-entry-nodes` | 恰好一个节点没有入边 |
| `definition/unreachable-node` | 每个节点都能从入口到达 |
| `definition/graph-cycle` | 除 loop 边之外的边不构成环 |
| `definition/join-first-success-degree` | `first-success` 只用于至少两条入边的节点 |

有四条规则确定了文档格式留白的情形。`loop` 边必须使用 `mode: "multiple"`：exclusive 组每次激活只选一条边，若其中含回边，前进选择与迭代计数都会歧义。同一节点的所有出边共享一种 mode，这样路由对每个节点只解析一种选择策略。fallback 边属于 exclusive 且不带条件，因为它不经求值就被选中。节点 id 一经声明即为边与输入引用的身份；重复 id 是违规而不是遮蔽规则。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 文档类型、违规与路由错误码、汇合值 |
| [`src/document.ts`](src/document.ts) | `WORKFLOW_DEFINITION_VERSION`、规范化序列化与仅接受 JSON 的解析步骤 |
| [`src/validate.ts`](src/validate.ts) | 上述全部规则，按各阶段文档顺序报告 |
| [`src/predicate.ts`](src/predicate.ts) | 针对单个节点结果的条件求值 |
| [`src/route.ts`](src/route.ts) | exclusive 与 multiple 边选择、fallback 与循环计数 |
| [`src/join.ts`](src/join.ts) | `computeJoin` 与已触发状态转移 |
| [`src/path.ts`](src/path.ts) | 点号路径解析与 JSON 读取 |
| [`src/json.ts`](src/json.ts) | JSON 收窄与规范化键排序 |

### 路由

`route(result, node, edges)` 只考虑离开 `node` 的边，因此可以传入整张边表。

- **exclusive** 组按文档顺序求值其条件边。恰好一条匹配时选中该边；零条匹配时若存在 fallback 则选中它，否则以 `routing/no-match` 失败；两条或更多匹配时以 `routing/ambiguous` 失败，`failure.candidates` 列出全部匹配边 id。fallback 边从不参与求值。
- **multiple** 边各自独立激活；目标按文档顺序保留并去重，`edgeIds` 则每条激活边一项。
- exclusive 组失败会令整个决策失败：即使 multiple 边匹配，`targets` 也为空。
- `iterationDelta` 统计被激活的 loop 边数量。迭代计数器由调度器持有，并按该数量递增。
- 每个不可比较的条件都会产生带边 id 的诊断。无条件边（`condition: null`）不经求值即匹配。

### 条件

求值只读取结果的业务字段；`next` 之类的名字只是普通字段，因此结果无法操纵控制流。

- 字段缺失时 `exists` 与 `truthy` 为假，其余取值比较报告 `predicate/field-missing` 且不匹配任何值。
- 类型严格：两个操作数处于不同 JSON 类别（`null`、`boolean`、`number`、`string`、`array`、`object`）时，比较报告 `predicate/type-mismatch` 且不匹配。不做任何强制转换。
- `gt`、`gte`、`lt`、`lte` 要求两个数字，因此 `NaN` 不满足其中任何一个；`in` 与 `not-in` 严格比较数组元素，当没有任何元素与字段类别相同时报告类型不匹配。
- `and` 与 `or` 先求值全部参数再合并，因此诊断描述整个条件，而不只是决定结果的分支。

### 汇合

`computeJoin(joinPolicy, activatedIncoming, completed, state?)` 是纯集合运算加状态转移；调度器在下一步把返回的 `state` 传回。

- `all` 在所有已激活入边完成后触发一次。从未激活的边不计入期望集合，空激活集合永不触发。
- `first-success` 在第一条已激活入边完成时触发，之后把后续完成项记入 `consumed`，而 `fire` 保持为假。
- 失败处理不在本包：`completed` 只包含成功完成项，失败分支的含义由调度器决定。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流项目存储](../project-store/README.zh.md)——把定义修订存为文档文本。
- [工作流 Python 运行器](../python-runner/README.zh.md)——运行 python 节点声明的 `nodemain_<nodeId>` 函数。
- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——调度器围绕本模型组合的运行与事件词汇。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不含调度、执行与持久化**——本包决定图意味着什么；激活、迭代计数、重试与失败隔离属于工作流调度器阶段。
- **schema 是子集**——`$ref`、`anyOf`、`allOf`、`pattern`、数值与字符串边界，以及 schema 形式的 `additionalProperties` 都会以 `definition/schema-unsupported` 拒绝；agent 节点暂时无法表达它们。子集归 `@metaworkflow/tools` 所有，扩展它是该包的变更。
- **条件只比较字段**——没有算术、没有表达式求值、没有函数调用；`eq` 与 `in` 比较 JSON 标量，因此两个结构相等的对象永不匹配。
- **嵌套有上限**——条件接受至深度 32，schema 至深度 16；更深的文档被拒绝而不是被截断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
