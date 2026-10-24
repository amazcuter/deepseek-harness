---
description: "为调度器运行工作流 Python 节点：注册 python 节点类型，按运行所存储的定义修订读取节点源码，准备项目环境，并报告一个 JSON 值或一个结构化失败。"
kind: "package-reference"
---

# @metaworkflow/workflow-python-executor

[English](README.md) | 中文

## 概述

`ctx.mwfPythonExecutor` 把工作流调度器接到主机 Python 运行器上。调度器拥有就绪判断、重试、循环与持久行；本插件提供 `python` 节点类型，让一次就绪的激活变成一次真实的子进程调用。每次调用它都按运行所存储的定义修订取节点源码、解析项目工作目录、准备项目环境，然后报告节点的 JSON 值或一个结构化失败。它不保存任何调度状态，也不写入任何调度状态。

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

在 Host 组合中把它挂在 `@metaworkflow/workflow-project-store`、`@metaworkflow/workflow-scheduler` 与 `@metaworkflow/workflow-python-runner` 旁边。它自己完成注册；没有调用方直接驱动它。

### 何时选用

当已存储定义里的 `python` 节点必须真正执行，且调度器的重试、循环上限与重启恢复必须作用在它们身上时选用。不要在缺少 Python 运行器或项目存储的情况下挂载它：执行器注入了这三个服务，只有它们都存在时才会激活。不要用它来在沙箱里运行不可信代码——节点以主机用户的权限运行，运行器另有说明——也不要把它当作通用作业运行器，因为它只执行调度器已经决定要启动的那一次激活。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-python-executor'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | 运行器默认值 | 单次节点运行的实际耗时上限；省略时把上限留给 `@metaworkflow/workflow-python-runner` |

生成的[配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-python-executor)是每个受支持字段的完整来源。

### 服务 API

| 方法 | 行为 |
|---|---|
| `execute(activation, inputs, signal)` | 读取该次激活所存储的定义修订、打开项目、确保其 `.venv`、运行节点，并返回 `{ status: 'succeeded', value }` 或 `{ status: 'failed', error, retryable }` |

调度器通过已注册的 `python` 执行器到达这个方法；该公开方法存在，是为了让调用方不必驱动一次运行就能测试单次激活。中止是唯一的拒绝路径：已中止的信号报告中止本身而不是节点失败，因为被暂停或取消的运行不得记录任何一次失败。

### 单次执行报告什么

| 运行器结果 | 执行器结果 |
|---|---|
| `ok: true` | `succeeded`，携带节点的 JSON 值 |
| `ok: false`、`node/timeout` | `failed`，携带该代码与 `retryable: true`——唯一一种下一次尝试仍可能赶上的失败 |
| `ok: false`、其余节点代码 | `failed`，携带运行器的代码与 `retryable: false`；捕获的 stderr 附在消息之后 |
| 环境拒绝 | `failed`，携带运行器自己的代码（`python/not-found`、`venv/create-failed` 等） |
| 存储的修订缺失或无法解析 | `failed`，代码为 `python/definition-unavailable` |
| 存储的修订在该 id 下没有 Python 节点 | `failed`，代码为 `python/node-unavailable` |
| 项目工作目录无法打开 | `failed`，代码为 `python/project-unavailable` |
| 其它任何情况 | `failed`，代码为 `python/executor-failed` |

失败从不以异常逃出，因此一个坏节点不会中断一次运行里的其他工作；调度器提交这次失败，并决定接下来发生什么。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

服务只持有两样东西：解析后的配置，以及一个与调度器之间的 `ctx.effect` 注册。销毁插件即注销 `python` 节点类型，因此被替换的组合不会留下重复的执行器。

**定义权威。** 执行器不运行交给它的那个节点对象。它读取运行创建时所依据的修订（`activation.definitionRevision`），并取该修订里的 `config.source`，因此一次运行执行的节点代码就是项目存储的代码。修订缺失、无法解析，或没有声明该节点，都是结构化失败，而不是回退到激活自带的那份副本。

**工作目录。** 执行器传给运行器的是项目记录里的 `path`：节点文件落在 `<path>/nodes/<nodeId>/`，项目的 `.venv` 就在旁边。该项目里每个运行的每次激活都解析到同一个目录。

**生命周期。** 一次调用就是一次 `runNode`；执行器不保存任何按运行划分的状态、从不重试、也从不写入调度行。调度器的中止信号原样透传，由运行器终止子进程树。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件、执行器注册、结果映射 |
| `src/types.ts` | 配置与失败代码 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流子系统](../../../docs/subsystems/workflow.zh.md) — 这些服务所属的 seam。
- [工作流调度器](../scheduler/README.zh.md) — 派发本插件所运行的激活的组件。
- [Python 运行器](../python-runner/README.zh.md) — 解释器解析、`.venv` 与节点协议。
- [工作流项目存储](../project-store/README.zh.md) — 定义修订与项目目录所在之处。
- [生成的配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-python-executor) — 每个受支持字段。

-----

<a id="model-experience"></a>
## 模型体验

无。执行器把调度器激活适配到 Python 运行器，不注册任何提示词、工具或会话事件。

#### KV 缓存影响

这里不组装任何模型请求，因此不会改变任何已缓存前缀；调度器以及负责渲染节点值的消费方拥有由此产生的失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **不发布产物**——节点返回的值会被提交，但它写出的文件尚未作为 `NodeArtifact` 记录发布，因此 `artifact` 输入绑定目前无法从这里读到任何东西。
- **每个项目一个 `.venv`**——执行器在每次运行前确保项目环境存在，但从不安装依赖；节点需要导入第三方包的项目要由别的调用方执行 `installRequirements`。
- **准备过程是串行的**——环境准备发生在激活内部，因此新项目的第一个节点要在自己的期限开始计时之前先承担 `.venv` 创建的开销。
- **没有沙箱**——节点以主机用户的权限运行；隔离仍属于 `@metaworkflow/sandbox-local`，此处并未接入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

在缺少受支持启动器的主机上，真实解释器套件会跳过，并复用同一个临时 home，因此每个套件只支付一次 `.venv` 创建开销。重启套件在节点仍睡眠时执行 reconcile：恢复过程不会中止子进程，这正是让迟到结果成为“过时结果”测试而非取消测试的原因。

</details>
