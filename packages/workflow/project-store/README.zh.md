---
description: "面向宿主的工作流项目持久化：全局注册库 `<home>/mwf/projects.db`，以及每个项目在 `<home>/mwf/projects/<projectId>` 下的一个 SQLite 数据库，使项目工作目录只保存用户代码与产物。"
kind: "package-reference"
---

# @metaworkflow/workflow-project-store

[English](README.md) | 中文

## 概述

`mwf-workflow-project-store` 在宿主侧持久化工作流项目：一个注册数据库列出全部项目，每个项目拥有一个 SQLite 数据库，保存其定义修订、运行、激活、尝试、产物、决策与会话 outbox。数据库位于宿主主目录下本存储自己的目录中，绝不在项目的工作目录内，因此该目录可以被移动或删除而不影响项目记录。你可以用它注册项目、把项目指向已有目录、改名、写入定义修订，以及暂存会话事件。写入按数据库串行执行，因此并发调用方不会相互竞争。`mwf-workflow-scheduler` 通过 `transact` 提交运行、激活、尝试、产物与 outbox 行；目前仍没有任何 UI、工具或提示词读取本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [迁移旧库](#migrate-an-older-library)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂载到宿主组合中，并通过 `ctx.mwfProjectStore` 使用它；不需要其它插件。

### 何时选择

当工作流数据必须跨进程重启存活、并按项目保持可检查时选择本包：定义、运行历史与待发送的会话事件各自属于某个项目。由于本存储不向项目工作目录写入任何文件，该目录始终属于用户——移动或删除它，都不会带走项目记录。不要把它当作通用键值存储——`@metaworkflow/storage-sqlite` 服务于被路由的领域数据，而本包为工作流项目拥有一份持久布局。本包从不调度任务，也不渲染任何内容；运行器与 GUI 在后续阶段接入。

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
| `createProject({ title, path? })` | 注册项目、创建工作目录，并在宿主主目录下物化其数据库；省略 `path` 时使用 `<home>/mwf/projects/<projectId>/workspace` |
| `openProject(projectId)` | 要求工作目录存在并物化其数据库；旧库把数据库留在该目录内时，先把它移出去 |
| `renameProject(projectId, title)` | 替换显示标题；工作目录仍是注册库的唯一键，标题可以重复 |
| `removeProject(projectId, { deleteDirectory? })` | 移除注册行、关闭连接并返回工作目录；除非 `deleteDirectory` 为 `true`，否则其文件与项目数据库保留 |
| `readDefinition(projectId, revision?)` | 读取一个定义修订，或最新修订 |
| `writeDefinition(projectId, document)` | 在一个事务内追加修订并返回其编号 |
| `listRuns(projectId)` | 运行记录，最新的在前，并校验已存状态 |
| `listOutbox(projectId, attemptId)` | 一次尝试已暂存的事件，按事件顺序 |
| `appendOutbox(projectId, attemptId, eventSeq, payload)` | 暂存一个事件；重复的键返回已存行 |
| `markAcked(projectId, attemptId, eventSeq)` | 只确认一次事件，并报告本次调用是否完成确认 |
| `transact(projectId, body)` | 在项目连接上以 `BEGIN IMMEDIATE` 运行一段同步主体，并与其他写入串行，令拥有自有行的消费方仍只用一个写连接 |

### 布局

每个宿主主目录一个注册库，每个项目一个目录，在支持 POSIX 模式的文件系统上都以仅所有者权限创建（`0o700`/`0o600`）：

| 路径 | 内容 |
|---|---|
| `<home>/mwf/projects.db` | 注册行：id、工作目录、数据库路径、标题、时间戳、定义修订提示 |
| `<home>/mwf/projects/<projectId>/project.db` | 单个项目的定义、运行、激活、尝试、产物、决策与 outbox |
| `<home>/mwf/projects/<projectId>/workspace` | 项目的默认工作目录：用户的代码与产物，不含任何存储文件 |

在显式目录注册的项目保留该目录作为工作目录，其数据库仍位于宿主主目录下。本包不会向工作目录写入任何内容，因此该目录可以独立移动、改名或删除；只有 `deleteDirectory` 明确要求时，`removeProject` 才会删除它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **每个数据库每进程一个连接。** 每个数据库通过一个槽位持有：并发调用方共享同一个未完成的打开，之后复用活动句柄，打开失败后槽位仍可重用。
- **写入排队而不是竞争。** 每次写入都在其数据库的串行队列（单条尾部 promise）上运行，因此两个调用方绝不会在同一条连接上交错语句，`busy_timeout` 也从不仲裁进程内竞争。
- **一次状态变更一个事务。** `writeDefinition`、`appendOutbox`、`markAcked` 以及每个 `transact` 主体都运行在 `BEGIN IMMEDIATE … COMMIT` 之内；抛出异常的主体整体回滚，不留残余。
- **没有跨库事务。** 注册行与项目数据库行从不一起提交：项目数据库保持权威，注册库保存定义修订提示，并在定义提交后刷新。
- **工作目录不含任何存储文件。** 每个数据库都位于本存储自己的 `<home>/mwf/projects/<projectId>` 目录中，因此工作目录可以被移动、改名或删除，而不会把数据库困在其中。
- **注册库记录每个数据库的位置。** 行中同时记录工作目录与数据库路径；存储打开的是该路径，因此布局变化过的宿主主目录仍能找到上一个构建写入的文件。
- **项目布局按声明步骤增长。** v1 库通过一个声明的升级获得调度器的三列，因此从已存版本出发找不到步骤的构建仍会拒绝该文件。
- **标识与版本明确报错。** 每个文件都带有自己的 `PRAGMA application_id` 与布局版本；没有声明升级步骤的版本会被拒绝，而不是被猜测。

### 打开顺序

每个数据库都按同一固定顺序执行协议：以 `0o700` 创建目录、以 `0o600` 创建文件、设置 `PRAGMA busy_timeout`、把 `PRAGMA journal_mode` 切换到 WAL（另一连接占住文件时有界重试）、启用 `PRAGMA foreign_keys`、校验 `PRAGMA application_id` 与 `PRAGMA user_version`、按已存版本执行声明的升级步骤、物化 schema，并在最后给全新或已升级的介质盖戳。版本为零且带有本存储自身标识，表示一次被中断的物化，会在下次打开时完成；版本为零但已持有外来表会被拒绝，没有声明步骤可以出发的版本同样会被拒绝。

### Schema

注册库持有 `projects`（工作目录唯一，并记录数据库路径）与 `schema_meta`。项目数据库持有 `definitions`、`nodes` 与 `edges`（每个修订一行，随修订级联删除）、`runs`（引用其启动时的修订，并携带运行的 `params_json`）、`activations`（按运行、节点与迭代唯一，并携带其 join 期望的 `incoming_json`）、`attempts`（按激活与尝试序号唯一，并携带它提交的 `result_json`）、`artifacts`（按激活、名称与版本唯一）、`decisions`、`session_outbox`（主键 `(attempt_id, event_seq)`，引用其尝试）以及 `schema_meta`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ctx.mwfProjectStore`、项目生命周期、定义、运行、outbox |
| [`src/open.ts`](src/open.ts) | 固定打开协议、pragma、WAL 重试、标识与版本校验 |
| [`src/registry.ts`](src/registry.ts) | 注册库布局、版本、标识与行语句 |
| [`src/project-database.ts`](src/project-database.ts) | 项目库布局、版本、标识与行语句 |
| [`src/relocate.ts`](src/relocate.ts) | 一个项目数据库的检查点复制、同步与原子改名 |
| [`src/database.ts`](src/database.ts) | 一个按需打开的连接及其写入队列 |
| [`src/queue.ts`](src/queue.ts) | 尾部 promise 串行队列 |
| [`src/transaction.ts`](src/transaction.ts) | 带回滚的 `BEGIN IMMEDIATE … COMMIT` 批次 |
| [`src/types.ts`](src/types.ts) | 记录、请求值与品牌化标识符 |

</details>

-----

<a id="migrate-an-older-library"></a>
## 迁移旧库

在数据库移出工作目录之前写入的库，会在首次使用时升级，分为两个彼此独立且可重复的步骤。

**注册库 v1 到 v2。** 打开 v1 注册库时会新增 `db_path` 列，并为每一行回填该数据库的 v1 位置 `<工作目录>/project.db`；这一操作与版本、格式标记的盖戳在同一个事务中完成。该步骤作为升级声明与注册库版本并列，因此从已存版本出发找不到声明步骤的构建仍会拒绝该文件。

**项目库 v1 到 v2。** 打开 v1 项目数据库时会在同一个事务里新增 `runs.params_json`、`activations.incoming_json` 与 `attempts.result_json`，并盖戳新版本与格式标记。v1 行得到的空默认值分别表示"没有参数""没有入边激活"和"没有结果"—— 这正是调度器为全新运行写入的内容 —— 因此 v1 库保留每一个定义修订、运行与已暂存事件。

**数据库搬迁。** 首次接触某个项目时，如果其注册行指向的数据库不是 `<home>/mwf/projects/<projectId>/project.db`，存储会先把旧文件的预写日志检查点写回，再把已同步的副本写入中转文件、原子改名到目标位置，最后才删除旧文件及其附属文件。在搬迁完成之前，注册行一直保留旧位置，因此复制失败时旧数据库仍是权威，下次打开会重新搬迁。已存在的规范文件胜出：注册行会改指向它，旧副本原地保留，存储记录一条告警而不删除自己已不再读取的文件。

两个步骤都是幂等的，重复打开已完成搬迁的项目既不会复制也不会重写任何内容。

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

- **目前还没有 UI、工具或提示词读取本包**——调度器通过 `transact` 拥有运行、激活与尝试行；项目看板接线与其余记录操作在后续阶段落地。
- **注册库保存的是提示而非权威**——`writeDefinition` 在定义提交后刷新 `definition_revision`，因此注册库失败会向调用方报错，尽管该修订已持久化；`readDefinition` 才是权威读取。
- **目录删除排在注册写入之后**——`removeProject(…, { deleteDirectory: true })` 先移除注册行，因此目录删除失败会留下未注册的文件，而不是留下没有文件的项目。
- **搬迁完成后旧副本可能保留**——当规范数据库文件已存在时，存储会保留它、改指向注册行并记录告警；是否删除工作目录内的旧副本仍由人来决定。
- **工作目录缺失时项目仍会列出**——由于数据库在别处，`listProjects` 与记录读取仍然可用，而 `openProject` 会在目录恢复之前报 `project-directory-missing`。
- **每个数据库文件一个进程**——单连接规则与串行队列都是进程内的；第二个进程写同一文件时依赖 SQLite 自身的锁定。
- **丢失的写入仍会明确报错**——从未刷盘的进程不会保留写入，损坏的介质也没有备份或修复路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

项目数据库一次性声明了 `nodes`、`edges`、`activations`、`attempts`、`artifacts` 与 `decisions`，让编译与运行阶段写入既有布局而不是迁移它。本阶段只接线定义、运行与 outbox 操作。导出的 `runTransaction` 让运行器把一次尝试的终态与其已暂存的 outbox 事件放在同一批次提交：一次提交，回滚则两者都不保留。

</details>
