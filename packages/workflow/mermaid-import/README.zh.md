---
description: "面向工作流项目的纯 Mermaid 流程图导入：解析“步骤与连线”子集，并把其图翻译成工作流校验器可接受的定义。"
kind: "package-library"
---

# @metaworkflow/workflow-mermaid-import

[English](README.md) | 中文

## 概述

使用 `@metaworkflow/workflow-mermaid-import` 把用户已经画好的流程图变成可运行的工作流图。`parseMermaidFlowchart` 读取 `flowchart` 头、节点语句与箭头，得到节点与边；`toDefinition` 把节点改名为稳定 id，把每条连线生成为 `route` 排他条件，并用 `@metaworkflow/workflow-definition` 校验结果。本包是纯函数库：自行解析 Mermaid 而不依赖它，不挂载任何服务，也从不抛出异常。

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

`projects.importMermaid` Remote 动词使用本包：作者粘贴一张流程图，Host 解析并翻译它，被接受的图作为项目最新的定义修订被存储。预览导入的工具或编辑器调用同样的两个函数。需要解释一张被拒绝的流程图时，读取诊断而不是猜测：每个拒绝都带稳定代码，文本能定位时还带源码行号。

### 入口

```ts
import { parseMermaidFlowchart, toDefinition } from '@metaworkflow/workflow-mermaid-import'

const parsed = parseMermaidFlowchart(`flowchart TD
  Start[Fetch the invoice] --> Review{Review}
  Review -->|approved| Done[File it]
  Review -->|rejected| Rework[Send it back]`)
if (!parsed.ok) {
  console.error(parsed.error.code, parsed.error.line, parsed.error.message)
} else {
  const translated = toDefinition(parsed.graph)
  if (!translated.ok) console.error(translated.error ?? translated.violations)
  else console.log(translated.mapping, translated.definition)
}
```

### 接受的子集

| 源码 | 读作 |
|---|---|
| `flowchart TD`、`flowchart LR`、`flowchart BT`、`flowchart RL` | 头部及其布局方向；`graph` 可代替 `flowchart` |
| `A`、`A[标签]`、`A(标签)`、`A{标签}` | 一个节点；标签可用双引号包裹，也可以跟在空格之后 |
| `A --> B` | 一条边 |
| `A -->\|标签\| B` | 一条边，标签成为其条件值 |
| `A --- B`、`A ---\|标签\| B` | 一条边，与上面的箭头等价 |
| `A --> B --> C` | 两条边，`A` 到 `B` 与 `B` 到 `C`；管道标签绑定到承载它的那条连线 |
| `%% ...`、空行 | 忽略 |
| 行尾 `;` | 容忍 |

其他语句一律拒绝而不是忽略，因为丢掉一行会静默改变图。拒绝码为 `mermaid/missing-header`（首条语句不是头部，或全文没有头部）、`mermaid/invalid-direction`（头部未给方向或给出不支持的方向）、`mermaid/unsupported-syntax`（`subgraph`、`classDef`、`class`、`click`、`style`、`linkStyle`、`accTitle`、`accDescr`、`direction`，以及 `-.->`、`==>`、`~~~`、`--o`、`--x`、`-- text -->` 这些连线形式）、`mermaid/syntax-error`（无法读取的节点、未闭合的括号或管道、空标签、游离文本）与 `mermaid/duplicate-node`（同一 id 用两个不同标签声明）。能定位到问题文本时，每个拒绝都带从 1 开始的行号。

重复的节点 id 会合并其出现：先裸名后有标签时保留标签，同一标签写两次即为合并。只被连线命名的节点以 id 作为标题自动创建，并以 `mermaid/implicit-node` 警告报告。

### 翻译规则

| 规则 | 结果 |
|---|---|
| 节点 id | 由标签生成的 slug：小写化，`[a-z0-9_-]` 之外的字符替换为 `-`，折叠重复的 `-`，去掉首尾 `-`/`_`；不以字母开头的 slug 加 `node-` 前缀，空 slug 变为 `node` |
| 冲突 | 先出现的节点保留 slug，后续节点按节点顺序取 `-2`、`-3`，并给出 `mermaid/label-collision` 警告 |
| 节点类型 | 每个节点都是 `agent` 节点：`title` 为标签，`outputSchema` 为 `{ "type": "object" }`，`instructions` 为 `Complete the "<标签>" step.`（可用 `options.instructions` 覆盖），`tools` 为空，`memory` 为 `fresh`，`inputs` 为空，`join` 为 `all` |
| 边 | `mode` 为 `exclusive`；带标签的连线条件是 `{ op: 'eq', field: 'route', value: <标签> }`，不带标签的连线条件为 `null` |
| 兜底边 | 同一源节点已有带标签连线时，不带标签的连线成为排他兜底边，因此先尝试带标签的各分支 |
| 边 id | `<from>-<to>`，两条连线连接同一对节点时追加 `-2`、`-3` |
| 重复连线 | 第二份被丢弃，并给出 `mermaid/duplicate-edge` 警告 |
| 入口节点 | 没有入边的节点都是入口；校验器要求恰好一个，因此两个互不相连的起点会以 violations 返回 |

只有 `validateDefinition` 接受该定义时，`toDefinition` 才返回 `{ ok: true, definition, mapping, warnings }`，其中 `mapping` 是 Mermaid id 到生成 id 的记录。环形流程图以 `mermaid/cycle-unsupported` 拒绝并点出闭环的节点，因为本版本只导入前向边，循环边稍后在画布上配置。能翻译但违反定义规则的图返回 `{ ok: false, error: null, violations }`，带上每一条校验问题；两种情况都不抛异常。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 图、诊断、选项与结果类型 |
| [`src/parse.ts`](src/parse.ts) | 逐行扫描、语句读取、节点声明与警告 |
| [`src/definition.ts`](src/definition.ts) | slug 生成、边构建、环检测与校验调用 |
| [`src/index.ts`](src/index.ts) | 包入口 |

### 解析

解析器逐行读取源码。第一条非注释、非空行必须是头部；其后每行是一条语句。语句用游标从左到右扫描：节点 id、可选的带形状标签，然后零或多组 `连线 节点`。只有整条语句扫描通过后，才声明其节点并追加其边，因此被拒绝的语句不会留下半个图。

标签按节点 id 记录，而不是按出现位置记录：第一个显式标签胜出，冲突的标签被拒绝，先以裸名出现的节点在标签到来前保持裸名状态。解析器会报告仅在连线端点裸名出现的节点，这是导入唯一会自行发明标题的情况。

### 翻译

`toDefinition` 按首次出现顺序遍历节点，并在构建节点前先占用其 slug，这正是重复标签下结果确定的原因。随后按源码顺序遍历连线，丢弃重复的 `(from, to, label)` 三元组，并占用每个边 id。环检测在任何节点构建之前运行：对连线做深度优先遍历，报告第一条回到自身的路径，拒绝信息即点名该路径。生成的定义就是 `validateDefinition` 校验的那个值，因此调用方可以直接存储 `serializeDefinition(result.definition)` 而无需再次校验。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流定义](../definition/README.zh.md) —— 文档、其校验器，以及生成条件所输入的路由。
- [工作区控制器](../../api/workspace-controller/README.zh.md) —— 存储导入流程图的 `projects.importMermaid` 动词。
- [工作流子系统](../../../docs/subsystems/workflow.zh.md) —— 定义、运行与执行器如何协同。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅前向边** —— 环形流程图以 `mermaid/cycle-unsupported` 拒绝；重入与 `maxIterations` 在画布上配置，因此导入暂时无法表达它们。
- **单一入口节点** —— 校验器要求恰好一个无入边节点，因此两个互不相连的起点会以 `definition/multiple-entry-nodes` 返回，而不是合成一个起点节点。
- **只有 agent 节点** —— 每个节点都是带占位指令、空对象 schema、无输入与工具的 `agent` 节点；python 节点、真实输出 schema 与输入绑定在导入后编写。
- **无语句拼接与连载形式** —— 每行一条物理语句、至多一个行尾 `;`，以及 `A -- text --> B` 内联标签形式都在子集之外；使用它们的文档会被拒绝而不是部分读取。
- **无布局与样式** —— 头部方向只记录在解析后的图中，不会带入定义，因为定义格式没有布局字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作背景——点击展开</summary>

无。

</details>
