# Agent Note: MetaWorkFlow 项目工作流

Status: implemented

[English](2026-10-23-metaworkflow-project-workflows.md) | 中文

## 问题

MWF Web 应用以对话组织：用户选择一个 Session，在其中工作。MetaWorkFlow 改造把这一界面重新组织为工作流项目。首页列出项目；项目内部包含工作流画布、统筹对话、节点能力与执行结果。用户导入 Mermaid 流程图，通过对话完善可执行工作流，并运行独立的 MWF Agent 与 Python 函数，其进度在重启后仍然保留。

本记录说明该产品背后的裁决：它运行在哪个应用与 Harness home 中、项目状态存放在哪里、存储的图如何变成持久执行、节点可以做什么，以及产品有意不做什么。

## 决策

### 独立的浏览器产品与专属 home

`mwf metaworkflow` 通过 `PROFILE_TEMPLATES` 中的 `metaworkflow` 条目（[profile.ts](../../../../packages/boot/app-boot/src/profile.ts)，见 [CLI 帮助](../../../../docs/cli-help.zh.md#mwf-metaworkflow)）启动应用，把 `@metaworkflow/base` 与 `@metaworkflow/app`（[metaworkflow-app](../../../../packages/bundle/metaworkflow-app/README.zh.md)）组合起来。该组合包在 MetaWorkFlow 自己的包名下重述 Web 界面的各行，两个产品因此可以独立变化。Desktop 产品、其数据与 `web` profile 均不改变。

`MWF_HOME` 指定应用的 Harness home；首次启动从内置模板初始化 `$MWF_HOME/profiles/metaworkflow`，因此该 profile 不与其他安装共享会话、设置、凭据或补丁文件。启动守卫（[home-guard.ts](../../../../packages/bundle/metaworkflow-app/src/home-guard.ts)）拒绝未设置或为空的 `MWF_HOME`，也拒绝共享的 `~/.mwf` 与 `~/.dsh` home，并打印修复命令；其他显式路径均接受。该变量只按终端存在，因为永久导出也会一并移动 Desktop 产品的 home。

### 项目存储与注册表

[workflow-project-store](../../../../packages/workflow/project-store/README.zh.md) 负责持久化。`<home>/mwf/projects.db` 注册表列出所有项目，每个项目在 `<home>/mwf/projects/<projectId>/project.db` 拥有一个 SQLite 数据库，绝不放在项目工作目录内；因此移动或删除工作目录不会带走记录。项目库声明 nodes、edges、activations、attempts、artifacts 与 decisions；每个进程对每个库只保留一个连接，通过 `BEGIN IMMEDIATE` 串行化写入。一次尝试的结果、状态迁移、它路由到的激活，以及暂存的 Session 事件在同一事务中提交；`(attempt_id, event_seq)` 是 outbox 幂等键，Session 事件绝不会早于产生它的状态行写入。

[workspace](../../../../packages/workspace/workspace/README.zh.md) 在这一身份之上增加面向产品的注册表：有序项目、各项目运行过的 Session、pin 与 archive 集合，以及保留目录、文件与 Session 的删除操作。项目因此在存储、侧边栏与 Session 中只有一个 id，而不是两套并存的项目概念。

### 定义与路由

[workflow-definition](../../../../packages/workflow/definition/README.zh.md) 是作为修订存储的纯图模型。文档是 JSON（`version: 1`），包含 nodes 与 edges。节点为 `python`（源码定义 `def nodemain_<nodeId>(`）或 `agent`（instructions、输出结构、工具名、`retained` 或 `fresh` 记忆）；每个节点声明 `join: all | first-success`，以及来自节点字段、运行参数或产物的输入绑定。每条边带类型化谓词、`exclusive` 或 `multiple` 模式、可选兜底与可选循环 `maxIterations`。条件通过固定算子集合比较 JSON 字段，任何内容都不作为代码求值。`route` 选择边、报告 `routing/no-match` 或 `routing/ambiguous` 并统计循环进入次数；`computeJoin` 触发 `all` 或 `first-success` 汇合。校验器对每条规则报告一个稳定代码：唯一入口节点、可达性、非循环边无环、输入只读祖先、循环边指向祖先、互斥组不混用模式。

### 调度器

[workflow-scheduler](../../../../packages/workflow/scheduler/README.zh.md) 把一份存储修订变成持久运行。`createRun` 校验修订，并把运行与其入口激活一起写入；`tick` 在 `maxConcurrent`（默认 4）以内启动就绪激活，并在每次结算后重新求值；`maxAttempts`（默认 2）限制重试。激活是 `(runId, nodeId, iteration)`，因此后续循环轮次不能满足更早的汇合。就绪、轮次、路由与结算随尝试一起提交，因此崩溃留下的运行可由 `reconcile` 报告：运行中的尝试变为 `interrupted`，其激活回到 `pending`，运行停驻，等待中的激活保持原状态。

`pause` 与 `cancel` 停止调度并中止在途尝试；`resume` 重新打开暂停的运行；`step` 执行一个指定的就绪激活，然后停驻运行；`retry` 把失败、取消或等待中的激活重开为新尝试；`resumeActivation` 交付决策答复并推进运行。等待中的激活释放执行名额，且永不满足汇合。调度器不自带执行器：节点类型需要注册，就绪激活若没有对应类型，运行以 `scheduler/executor-missing` 失败。一次运行在整个生命周期内只读取一份修订，因此运行中修改定义会以 `scheduler/stale-result` 被拒绝，而不会应用到受影响的激活。产物按名称、版本与相对路径记录为引用，并不是调度器写入或校验的文件。

### Python 节点

[workflow-python-runner](../../../../packages/workflow/python-runner/README.zh.md) 把一段 AI 编写的函数作为真实子进程运行。解释器按顺序解析——显式路径、项目 `.venv`、配置路径、平台探测——每一层都必须报告带 GIL 的 CPython 3.10–3.14；free-threaded 构建被拒绝。每个项目在 `<projectDir>/.venv` 保留一个环境，因宿主没有 MSVC 工具链而以 `pip install --only-binary=:all:` 安装，同一项目的调用串行化。

运行器写入 `<projectDir>/nodes/<nodeId>/node_main.py`，在旁边生成 `node_runner.py`，并调用 `nodemain_<id>(inputs)`。输入以 UTF-8 JSON 走标准输入，而不是 argv。返回的 JSON 字符串通过一行标准输出哨兵 `__MWF_RESULT__ <json>` 重新输出，日志截断无法吞掉它；诊断用标准输出与标准错误分别限额，且从不作为结果。子进程环境设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8` 与 `PYTHONUNBUFFERED=1`，因为 GBK 宿主区域设置会静默损坏中文，并在遇到 emoji 时抛错。超时终止整个进程树——Windows 上 `taskkill /PID <pid> /T /F`，其他平台向进程组发信号，并重试一次——因为 `child.kill()` 只能到达运行器启动的那个进程。超过 200 字符的项目目录会以 `project/path-too-long` 拒绝，因为更长路径会让 `CreateProcess` 以 `WinError 267` 失败。

[workflow-python-executor](../../../../packages/workflow/python-executor/README.zh.md) 提供 `python` 类型。它读取激活所存储的修订、打开项目、准备环境、运行节点，并报告带 JSON 值的 `succeeded` 或带运行器代码的 `failed`。只有 `node/timeout` 可重试；环境问题与节点自身异常不可重试，因此损坏的节点不会把尝试预算耗在重复同一故障上。

### Agent 节点

[workflow-agent-executor](../../../../packages/workflow/agent-executor/README.zh.md) 提供 `agent` 类型。每次激活按存储节点装配一个子 Agent：instructions 成为其人格，`ctx.tools.restrict({ allow })` 过滤工具，记忆策略决定 Session 复用，并同时获得 `submit_node_result`（其 `value` 参数就是节点输出结构）与 `request_decision`。子 Agent 以 subagent Session 运行，设置 `parentSession` 与 `origin: 'subagent'`，因此冷恢复按 subagent 运行的方式重放其描述符。

`retained` 记忆跨激活复用该 Session；`fresh` 每次新建。retained 不是压缩设置：压缩是按 provider 与 model 配置的单一组合服务，对复用的节点 Session 与普通对话一样生效，无法逐节点开关。模型选择在部署范围内统一：每个子 Agent 使用部署默认模型，定义中没有逐节点模型字段。节点结果只由完成工具接受的内容构成；子 Agent 写入的文件不会发布为产物，因为目前没有执行器发布产物。

### 完成与决策

[tool-complete-node](../../../../packages/workflow/tool-complete-node/README.zh.md) 拥有 `submit_node_result`。其单一 `value` 参数逐字使用节点存储的输出结构；非法值是普通工具参数错误，模型在同一轮内纠正。合法值暂存在该尝试下，只有当提交自身的 `tools/result` 成功后才会提交；单调守卫拒绝该作用域内之后的每次提交，因此重复调用既不能替换也不能扩展已记录结果。普通助手文本永远不会完成节点；一轮结束时既无完成也无决策请求的激活以 `agent/completion-missing` 失败。

[tool-request-decision](../../../../packages/workflow/tool-request-decision/README.zh.md) 拥有 `request_decision({ question, options, detail })`。一次调用记录一个待决请求，返回 `{ status: 'pending', requestId }` 并结束本轮，因此激活进入 `waiting` 并释放名额；同一尝试中的第二次请求被拒绝。统筹的答复以名为 `decision` 的输入到达恢复后的尝试，而不是另一个工具结果，因此节点把它当作数据处理。

### 统筹

[workflow-coordinator](../../../../packages/workflow/coordinator/README.zh.md) 为每个项目提供一个持久统筹 Session。`ensureSession(projectId)` 首次使用时创建并记录，之后恢复已记录的那个，因此对话比进程存活更久。其工具为 `answer_decision({ requestId, answer })`，记录答复并通过 `ctx.mwfScheduler.resumeActivation` 恢复等待中的激活；`list_pending_decisions()`，按最旧优先列出未答复请求及节点提出的选项；以及 `get_project_state()`，报告项目、各运行的状态与原因，以及最新运行的激活与尝试次数。对已停止等待的激活作答会记录答复并报告被拒绝的恢复，而不是修复它；`retry` 仍是不交付答复的路径。决策事件不进入 Session 日志，因此 UI 通过订阅获得，而不是从对话历史推导。

### Mermaid 导入与画布

[workflow-mermaid-import](../../../../packages/workflow/mermaid-import/README.zh.md) 是纯库。`parseMermaidFlowchart` 读取 `flowchart` 或 `graph` 头及 `TD`、`LR`、`BT`、`RL`、节点语句与箭头；`toDefinition` 把节点重命名为稳定 id，把每条连线翻译为互斥 `route` 比较，并用定义校验器校验结果。接受的子集有意保持很小：只支持前向边（循环流程图以 `mermaid/cycle-unsupported` 拒绝）、恰好一个入口节点、每行一条语句、不支持 `A -- text --> B` 形式、无布局或样式。每个导入节点都是 `agent` 节点，带占位指令、空对象结构与无输入无工具；Python 节点、真实结构与绑定在导入后编写。`projects.importMermaid` Remote 动词注册项目、解析、翻译并把定义存为项目首个修订；被拒绝的流程图不会注册任何内容。

[client-ui-mw-projects](../../../../packages/client/ui-mw-projects/README.zh.md) 中的画布把存储定义重绘为 Mermaid 流程图：每个定义节点一个节点、每条边一个箭头、带条件的箭头显示条件文本，稳定 id 把绘图与选择和运行状态关联起来。点击节点或按 Enter/Space 会为详情面板选中它；节点颜色来自最新激活的状态。Mermaid 作为该包的私有异步 chunk 懒加载——传输约 1 MB——在 `securityLevel: 'strict'` 且关闭 HTML 标签下渲染，并在自己的滚动框内缩放。Mermaid 拒绝渲染时，生成的源码与原因会连同重试按钮留在屏幕上，因为该源码正是区分“定义不受支持”与“渲染器故障”的依据。

### 工作台、详情面板与运行控制

首页列出已注册项目——标题、目录、实时目录状态、Session 数与定义修订——并创建、重命名、删除与打开项目；打开会物化项目数据库并切换到该项目的工作台。工作台把画布放在中心，把统筹 Session 作为共享 Conversation 内嵌，列出项目等待的决策并提供快速回复框，并展示运行历史。详情面板有三个标签页：配置（可写标题；只读类型、源码或指令、记忆、输出结构与汇合）、工具开关（每个已注册工具一个开关；部署不再注册的已声明工具显示为不可写），以及输入与结果（绑定、输出结构，以及最新运行每次尝试及其记录的失败）。Python 节点没有开关，其标签页会说明这一点。[界面草图](2026-10-23-metaworkflow-project-workflows.preview.html)以示例数据展示该组合；它不执行任务，也不定义行为。

`Run` 从最新修订启动运行，`Pause` 停止后续激活，`Resume` 重新打开暂停的运行。工作台每四秒以及每次操作后重新读取运行、历史与待决决策；没有运行状态订阅。布局基于面板自身宽度的容器查询：宽屏把画布与详情面板放在统筹旁边，窄屏折叠为 Canvas／Details／Conversation 切换。

### 已验证

以下每条事实都注明锁定它的测试套件或命令。这些运行均不需要密钥。

- profile、home 隔离与首屏：`pnpm exec vitest run packages/bundle/metaworkflow-app` 通过 `tests/home-guard.spec.ts` 与 `tests/startup-guard.spec.ts`（未设置、空值与共享 home 被拒绝；显式 home 被接受）；`packages/client/ui-mw-projects/tests/projects-page.client.spec.tsx` 覆盖首页的加载、空、失败与变更状态。
- 项目存储与决策：`packages/workflow/project-store/tests/store.spec.ts`、`open.spec.ts`、`primitives.spec.ts` 与 `decisions.spec.ts` 覆盖注册表、每项目一个数据库、从工作目录迁出、串行化写入与首个答复胜出的决策行。
- 定义与路由：`packages/workflow/definition/tests/validate.spec.ts`、`route.spec.ts`、`join.spec.ts` 与 `predicate.spec.ts` 覆盖每个校验代码、互斥与多匹配路由、兜底、循环计数与两种汇合策略。
- 调度：`packages/workflow/scheduler/tests/lifecycle.spec.ts`、`graph.spec.ts`、`waiting.spec.ts`、`concurrency.spec.ts`、`units.spec.ts`、`inputs.spec.ts` 与 `transaction.spec.ts`；事务套件用 SQLite 触发器注入 outbox 写入失败，并断言提交作为一个批次整体回滚。
- 当前 Windows 宿主上的 Python 执行：`pnpm exec vitest run packages/workflow/python-runner` 覆盖解释器层级、项目 venv、仅 wheel 安装、UTF-8 标准输入输出、哨兵行、日志上限与超时终止进程树；`packages/workflow/python-executor/tests/executor.spec.ts` 与 `restart.spec.ts` 覆盖类型注册、可重试超时与重启。
- Agent 节点：`packages/workflow/agent-executor/tests/composition.spec.ts`、`completion.spec.ts`、`decisions.spec.ts`、`sessions.spec.ts` 与 `outcomes.spec.ts`，以及 `agent-node.e2e.ts`，覆盖装配、允许列表、循环边上的 retained 与 fresh 记忆、完成、等待结果与失败映射。
- 统筹决策：`packages/workflow/coordinator/tests/coordinator.spec.ts` 让节点发起决策、由统筹轮次作答，并断言运行结算。
- 工具开关与详情面板：`packages/api/workspace-controller/tests/projects-workflow.host.spec.ts` 覆盖 `projects.availableTools` 与 `projects.updateNode`；`packages/client/ui-mw-projects/tests/workbench.client.spec.ts` 覆盖选择、标题编辑、工具切换、运行控制、决策作答与轮询读取。
- Mermaid 导入与画布：`packages/workflow/mermaid-import/tests/parse.spec.ts`、`definition.spec.ts` 与 `index.spec.ts`；`packages/client/ui-mw-projects/tests/mermaid-graph.client.spec.ts`、`workflow-canvas.client.spec.tsx` 与 `import-dialog.client.spec.tsx`。
- 工作台中的统筹对话：`packages/client/ui-mw-projects/tests/coordinator-conversation.client.spec.tsx` 把共享 Conversation 内容渲染为内嵌聊天。

## 既定约束

随着后续扩展，以下约束持续成立。

- **不新增 `SessionEventMap` 成员。** 运行、激活、尝试、轮次、连线路由与修订都放在项目库。Session 只承载模型可见历史，因此调度不新增模型可见输入，也不新增持久化事件类型。
- **恢复只到最后一个已提交的交换。** 不存在恢复到工具调用中途。崩溃后，`agents.resume()` 为每个未结算的工具调用合成 `isError` 结果（执行可能已开始时为 `TOOL_OUTCOME_UNKNOWN`，未开始时为 `TOOL_NOT_STARTED`），模型据此重新决策。
- **节点工具是能力选择，不是权限系统。** `restrict({ allow })` 过滤子 Agent 获得的工具；它不授予任何权限，也不收窄或放宽其他工具可以做什么。每个子 Agent 仍以宿主用户权限运行。
- **节点目录用于组织工作，不做隔离。** Python 节点可以安装 wheel、访问网络、读写普通宿主文件。进程终止是所有权管理，不是沙箱；被终止的节点可能已经修改文件或调用远程服务。
- **客户端文案归属 locale。** 字符串通过 locale 字典提供，以中文为编写侧，符合 `verify-client-ui-i18n` 的要求。
- **包的位置与命名。** 工作流能力放在 `packages/workflow/` 下并使用 `workflow-*` 前缀，客户端包为 `ui-mw-projects`；两者都不与既有 `ctx.workflowEngine` seam 或 `ui-workflow-run` 冲突。

## 考虑过的替代方案

**扩展 Desktop 应用，或改造内置 `web` profile。** 只在浏览器中运行、使用独立 profile 与组合包，使 Desktop 产品的界面与数据保持不变，两个产品可以独立变化。代价是要多维护一个组合包。

**分开设计与执行统筹。** 一个 Agent 与一条持续对话承担两种职责。拆分会重复上下文，并模糊是谁做出的决定。

**固定程序算子目录。** AI 编写的 Python 函数能表达任意逻辑；固定的分支与循环算子目录会把工作流限制在我们已交付的算子上。

**节点返回后继 ID。** 路由条件放在图连线上，因此可见图能解释执行，结果也不能通过名为 `next` 的字段操纵控制流。

**节点共享工作区或合并记忆。** 每个节点拥有自己的工作目录与记忆策略，通过明确的数据交接协作；共享状态会让两个节点的输入和历史在无记录的情况下相互依赖。

**修改仅在下次运行生效。** 原意是暂停受影响激活，并在当前运行中继续应用修改。已交付的调度器反而每次运行只读一份修订，并以 `scheduler/stale-result` 拒绝运行中修改；把修改应用到活动运行保持未实现，而不是静默近似。

**复用文档站的 Mermaid 渲染器。** 该渲染器是供 VitePress 使用的 Vue 组件，无法在客户端插件中运行；客户端自带一份 Mermaid chunk。

**复用 `mwf-workspace` 的项目列表作为项目模型。** 它拥有目录及其 Session，但没有工作流定义、运行或尝试。身份移到项目库，workspace 注册表则在该身份之上对 Session 分组，而不是保留第二套项目概念。

## 后果

产品只有一个浏览器界面，因此 Desktop 用户与 `web` profile 不受影响，而工作流体验在这两者中都不存在。第二个组合包是对 Web 各行的分叉而不是共享组合，因此 Web 表面的改动必须有意识地移植过来。

持久化与可检查性带来一条写路径：每个运行、激活、尝试、产物、决策与 outbox 行都在 SQLite 中，每个项目打开一个数据库。outbox 保证 Session 写入排在其状态行之后，但两者之间崩溃会留下未确认（而非丢失）的事件，且没有机制自动重试它。

Python 有意不受限。节点以宿主用户权限运行，因此可能破坏机器或访问网络；独立节点目录是组织手段，不是隔离。被终止的函数或工具调用可能已产生外部影响；持久提交防止调度器重复接受结果，而不是保证外部副作用只发生一次。

画布为其渲染器付出代价：Mermaid 作为该包的私有异步 chunk，传输约 1 MB，在首次打开项目时懒加载。第二个绘制定义的界面会自带一份副本，且画布在每次修订时重绘整张图，而不是对比源码。

工作台以四秒轮询反映状态。`projects.startRun` 在调度器停止派发时返回，因此长 Agent 节点会让请求保持打开，而不是流式报告进度；决策或节点颜色最多晚一个轮询间隔出现。缺少的是一套运行状态订阅。

一次运行只读一份修订是已交付范围中最大的缺口：结构编辑、统筹驱动的修复，以及受影响激活的版本一致重跑都未实现。统筹可以作答决策、列出决策并报告项目状态，但其 Session 没有定义编辑工具；详情面板只写节点标题与工具列表，源码、指令、结构、输入与连线均为只读。

边与循环是调度器特性，不是导入特性：回边必须在导入后编写，因为循环流程图会被拒绝。first-success 汇合也可能让目标因输入绑定到从未提交的分支而得不到输入，报告 `scheduler/input-missing`。

还有两项较小代价来自这种拆分。retained 节点 Session 不会被其执行器压缩，因此长周期项目依赖部署的压缩策略；删除项目会留下统筹 Session 日志，项目数据库与文件也会保留，除非删除操作显式删除目录。

## 相关记录

[PTC 沙箱裁决](../architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md)仍拥有 JavaScript 编排运行时及其沙箱；本次新增独立的 Python 执行路径，不改变该裁决。

[Domain KV 存储与 workspace 提案](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)对其记录的 storage domain 形式仍保持 proposed。其“workspace 实体拥有项目路径、标题与身份”的前提只部分成立：身份、目录与标题现在来自 `@metaworkflow/workflow-project-store`，workspace 注册表在该身份之上增加 Session 账目。该提案保持 active 并交叉链接，而不是归档，因为其 storage-domain 理由仍然适用。

[归档停止运行中工作裁决](2026-09-21-archive-stops-running-session-work.zh.md)继续保持 workspace 注册表应用于 Session 成员的归档语义。
