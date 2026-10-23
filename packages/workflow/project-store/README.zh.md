---
description: "面向宿主的工作流项目持久化：全局注册库 `<home>/mwf/projects.db`，以及每个项目一个 SQLite 数据库，保存定义、运行、激活、尝试、产物、决策与会话 outbox。"
kind: "package-reference"
---

# @metaworkflow/workflow-project-store

[English](README.md) | 中文

## 概述

`mwf-workflow-project-store` 在宿主侧持久化工作流项目：一个注册数据库列出全部项目，每个项目目录拥有一个 SQLite 数据库，保存其定义修订、运行、激活、尝试、产物、决策与会话 outbox。你可以用它注册项目、把项目指向已有目录、写入定义修订、读回运行记录，或暂存与确认会话事件。写入按数据库串行执行，因此并发调用方不会相互竞争。本包只面向宿主，且尚未接线：目前没有任何 UI、工具、提示词或调度器读取它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂载到宿主组合中，并通过 `ctx.mwfProjectStore` 使用它；不需要其它插件。

### 何时选择

当工作流数据必须跨进程重启存活、并按项目保持可检查时选择本包：定义、运行历史与待发送的会话事件各自属于某个项目目录。不要把它当作通用键值存储——`@metaworkflow/storage-sqlite` 服务于被路由的领域数据，而本包为工作流项目拥有一份持久布局。本包从不调度任务，也不渲染任何内容；运行器与 GUI 在后续阶段接入。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-project-store'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mwfHome` | `$MWF_HOME`，其次 `~/.mwf` | 宿主主目录覆盖项；布局位于其 `mwf` 目录下 |

生成的[配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-project-store)是所有可接受字段的完整来源。

### 服务 API

| 方法 | 行为 |
|---|---|
| `listProjects()` | 全部已注册项目，最新的在前 |
| `createProject({ title, path? })` | 注册项目并物化其数据库；省略 `path` 时使用 `<home>/mwf/projects/<projectId>` |
| `openProject(projectId)` | 解析一个项目，文件缺失时物化其数据库 |
| `removeProject(projectId, { deleteDirectory? })` | 移除注册行、关闭连接并返回目录；除非 `deleteDirectory` 为 `true`，否则文件保留 |
| `readDefinition(projectId, revision?)` | 读取一个定义修订，或最新修订 |
| `writeDefinition(projectId, document)` | 在一个事务内追加修订并返回其编号 |
| `listRuns(projectId)` | 运行记录，最新的在前，并校验已存状态 |
| `listOutbox(projectId, attemptId)` | 一次尝试已暂存的事件，按事件顺序 |
| `appendOutbox(projectId, attemptId, eventSeq, payload)` | 暂存一个事件；重复的键返回已存行 |
| `markAcked(projectId, attemptId, eventSeq)` | 只确认一次事件，并报告本次调用是否完成确认 |

### 布局

每个宿主主目录两个数据库，在支持 POSIX 模式的文件系统上都以仅所有者权限创建（`0o700`/`0o600`）：

| 路径 | 内容 |
|---|---|
| `<home>/mwf/projects.db` | 注册行：id、目录、标题、时间戳、定义修订提示 |
| `<home>/mwf/projects/<projectId>/project.db` | 单个项目的定义、运行、激活、尝试、产物、决策与 outbox |

在显式目录注册的项目把 `project.db` 放在该目录内，因此代码、产物与环境都和项目在一起。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **每个数据库每进程一个连接。** 每个数据库通过一个槽位持有：并发调用方共享同一个未完成的打开，之后复用活动句柄，打开失败后槽位仍可重用。
- **写入排队而不是竞争。** 每次写入都在其数据库的串行队列（单条尾部 promise）上运行，因此两个调用方绝不会在同一条连接上交错语句，`busy_timeout` 也从不仲裁进程内竞争。
- **一次状态变更一个事务。** `writeDefinition`、`appendOutbox` 与 `markAcked` 各自运行在 `BEGIN IMMEDIATE … COMMIT` 之内；抛出异常的主体整体回滚，不留残余。
- **没有跨库事务。** 注册行与项目数据库行从不一起提交：项目数据库保持权威，注册库保存定义修订提示，并在定义提交后刷新。
- **项目 v1 布局一次定义完整。** 后续阶段只增加行为，不做迁移。
- **标识与版本明确报错。** 每个文件都带有自己的 `PRAGMA application_id` 与布局版本；任何其它组合都会被拒绝，而不是原地迁移。

### 打开顺序

每个数据库都按同一固定顺序执行协议：以 `0o700` 创建目录、以 `0o600` 创建文件、设置 `PRAGMA busy_timeout`、把 `PRAGMA journal_mode` 切换到 WAL（另一连接占住文件时有界重试）、启用 `PRAGMA foreign_keys`、校验 `PRAGMA application_id` 与 `PRAGMA user_version`、物化 schema，并在最后给全新介质盖戳。版本为零且带有本存储自身标识，表示一次被中断的物化，会在下次打开时完成；版本为零但已持有外来表，或任何其它版本，都会被拒绝。

### Schema

注册库持有 `projects`（目录唯一）与 `schema_meta`。项目数据库持有 `definitions`、`nodes` 与 `edges`（每个修订一行，随修订级联删除）、`runs`（引用其启动时的修订）、`activations`（按运行、节点与迭代唯一）、`attempts`（按激活与尝试序号唯一）、`artifacts`（按激活、名称与版本唯一）、`decisions`、`session_outbox`（主键 `(attempt_id, event_seq)`，引用其尝试）以及 `schema_meta`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ctx.mwfProjectStore`、项目生命周期、定义、运行、outbox |
| [`src/open.ts`](src/open.ts) | 固定打开协议、pragma、WAL 重试、标识与版本校验 |
| [`src/registry.ts`](src/registry.ts) | 注册库布局、版本、标识与行语句 |
| [`src/project-database.ts`](src/project-database.ts) | 项目库布局、版本、标识与行语句 |
| [`src/database.ts`](src/database.ts) | 一个按需打开的连接及其写入队列 |
| [`src/queue.ts`](src/queue.ts) | 尾部 promise 串行队列 |
| [`src/transaction.ts`](src/transaction.ts) | 带回滚的 `BEGIN IMMEDIATE … COMMIT` 批次 |
| [`src/types.ts`](src/types.ts) | 记录、请求值与品牌化标识符 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——工作流服务、钩子与事件词汇，运行器将由它承载。
- [工作流包映射](../README.zh.md)——本组的各包及其位置。
- [SQLite 存储后端](../../storage/storage-sqlite/README.zh.md)——被路由的领域数据介质，本包刻意不使用它。

-----

<a id="model-experience"></a>
## 模型体验

无：本包为宿主侧消费方持久化工作流记录，不注册任何提示词、工具、schema 或会话事件。

#### KV Cache 影响

无——本包从不触碰实时请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本阶段尚未做什么，以及调用方需要在何处补偿。

- **目前还没有消费方**——没有任何 UI、工具或调度器读取本包；profile、GUI 接线与运行持久化 API 在后续阶段落地。
- **注册库保存的是提示而非权威**——`writeDefinition` 在定义提交后刷新 `definition_revision`，因此注册库失败会向调用方报错，尽管该修订已持久化；`readDefinition` 才是权威读取。
- **目录删除排在注册写入之后**——`removeProject(…, { deleteDirectory: true })` 先移除注册行，因此目录删除失败会留下未注册的文件，而不是留下没有文件的项目。
- **每个数据库文件一个进程**——单连接规则与串行队列都是进程内的；第二个进程写同一文件时依赖 SQLite 自身的锁定。
- **丢失的写入仍会明确报错**——从未刷盘的进程不会保留写入，损坏的介质也没有备份或修复路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

项目数据库一次性声明了 `nodes`、`edges`、`activations`、`attempts`、`artifacts` 与 `decisions`，让编译与运行阶段写入既有布局而不是迁移它。本阶段只接线定义、运行与 outbox 操作。导出的 `runTransaction` 让运行器把一次尝试的终态与其已暂存的 outbox 事件放在同一批次提交：一次提交，回滚则两者都不保留。

</details>
