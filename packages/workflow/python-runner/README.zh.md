---
description: "在主机上运行一个由 AI 编写的 Python 节点函数：解释器解析、项目 .venv、仅二进制依赖安装，以及能在日志截断、超时与取消后仍然存活于 Windows、Linux 和 macOS 的 JSON 结果协议。"
kind: "package-reference"
---

# @metaworkflow/workflow-python-runner

[English](README.md) | 中文

## 概述

在主机上运行一个由 AI 编写的 Python 节点函数，连同日志一起取回它的 JSON 值。`ctx.mwfPythonRunner` 选定解释器、维护项目的 `.venv`、只安装已发布的二进制 wheel，并在节点自己的目录里以 UTF-8 stdio 运行节点。结果值走独立的哨兵行，因此被截断的日志不会吞掉它；即使主机默认编码不是 UTF-8，中文与 emoji 也能原样返回。失败是结构化的：解释器不可用会拒绝调用，而节点抛异常或超时则返回 `ok: false`。目前还没有任何组件调度工作或渲染结果。

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

在 Host 组合中挂载该插件，并通过 `ctx.mwfPythonRunner` 使用它；不需要其他插件。

### 何时选用

当一个工作流节点是由 AI 编写的 Python、且必须作为真实子进程运行在用户机器上时选用；当项目需要在不安装编译器的情况下安装自己的依赖时选用。不要用它来在沙箱中运行不可信代码：节点以主机用户的权限运行，终止进程树是归属权管理而非隔离。也不要把它当作通用进程运行器——`@metaworkflow/subprocess` 拥有那个 seam，本包只复用它的环境清洗。工作流调度器与 GUI 属于后续阶段；目前没有调用方。

### 最小配置

```yaml
- name: '@metaworkflow/workflow-python-runner'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `interpreterPath` | 探测 | 当调用方与项目 `.venv` 都没有提供解释器时使用的解释器或启动器 |
| `timeoutMs` | `120000` | 单次节点运行的默认实际耗时上限 |
| `maxStdoutBytes` | `65536` | 单次运行 stdout 日志的默认上限 |
| `maxStderrBytes` | `65536` | 单次运行 stderr 日志的默认上限 |
| `installTimeoutMs` | `300000` | 单次 `.venv` 创建或 `pip install` 的上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-python-runner)是每个受支持字段的完整来源。

### 服务 API

| 方法 | 行为 |
|---|---|
| `resolveInterpreter({ interpreterPath?, projectDir? })` | 依次校验调用方路径、项目已有的 `.venv`、配置路径、平台探测；每一层都必须报告 3.10–3.14 且持有 GIL |
| `ensureVenv(projectDir)` | 在缺失时创建 `<projectDir>/.venv` 并返回其解释器；同一项目的并发调用会串行化 |
| `installRequirements(projectDir, requirements)` | 在项目环境中执行 `pip install --only-binary=:all:` 并回报 pip 的退出事实 |
| `runNode({ projectDir, nodeId, source, inputs?, timeoutMs?, env?, maxStdoutBytes?, maxStderrBytes?, signal? })` | 写入并运行节点，返回 `{ ok, value?, error?, stdout, stderr, exitCode, durationMs, timedOut }` |

`resolveInterpreter`、`ensureVenv`、`installRequirements` 与 `runNode` 在环境问题上以带类型的 `PythonRunnerError` 码拒绝：`python/not-found`、`python/unsupported-version`、`python/free-threaded`、`venv/create-failed`、`project/path-too-long` 或 `node/invalid-id`。节点自身的失败则以 `ok: false` 结出，码为 `node/exception`、`node/invalid-return`、`node/timeout` 或 `node/output-too-large` 之一，因此一个坏节点不会中止整批运行。被取消的运行会以 signal 的 reason 拒绝。

### 节点协议

运行器把 `source` 写入 `<projectDir>/nodes/<nodeId>/node_main.py`，并在旁边生成 `node_runner.py`。节点模块必须定义 `nodemain_<id>(inputs)`——id 中所有 `[A-Za-z0-9_]` 之外的字符都变成 `_`——并返回一个装着 JSON 的 `str`。

```python
import json

def nodemain_extract(inputs):
    return json.dumps({"title": inputs["title"], "ok": True})
```

包装程序从 stdin 读取 UTF-8 JSON，调用节点，并只写一行 `__MWF_RESULT__ <json>`。抛出的异常把 traceback 打到 stderr 并以 `1` 退出；返回值不是 `str`、或 `str` 不是 JSON，则以 `2` 退出。运行器只接受一行结果，缺失或重复的结果行都按 `node/invalid-return` 拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

服务只持有两样状态：已解析的设置，以及一个按项目目录串行化的 `VenvManager`。其余每个决定都是对其输入求值的纯函数，这也是本包没有拆卸逻辑的原因。

**解释器优先级。** 具名层是权威的：不可用的显式路径、项目 `.venv` 或配置路径会拒绝调用，而不是悄悄换一个解释器运行。探测层则逐个尝试 Windows 上的 `py -3` 与 `python`，或其他平台上的 `python3`，因为主机可能把 free-threaded 构建注册为默认启动器，从而同时保留一个受支持的解释器；第一个合格启动器胜出，全部不合格时报告第一个结构化拒绝。探测会打印版本、GIL 标志和 `sys.executable`，因此启动器会被解析为后续每次 spawn 使用的绝对二进制。

**编码。** Windows 上的 Python 默认在 stdio 上写 GBK，会静默损坏中文并对 emoji 抛错。三层防线阻止它：解释器 argv 上的 `-X utf8`、子进程环境中的 `PYTHONUTF8`/`PYTHONIOENCODING`/`PYTHONUNBUFFERED`，以及生成包装程序序列化结果行时的 `ensure_ascii=True`。`PYTHONUNBUFFERED` 还能保住被终止节点最后的日志行。

**输出上限。** 每个流在解码前独立封顶，stdout 保留头部、stderr 保留尾部，因为 traceback 以诊断结尾。被丢弃的字节数会写进捕获文本，而结果行从不进入可截断缓冲区：扫描器在字节到达时按行切分，把哨兵行转入独立槽位，值本身另有 8 MiB 上限。

**终止。** `child.kill()` 只能触及运行器启动的那个进程，而节点可能自己再起子进程。因此超时或取消会终止整棵进程树——Windows 上用 `taskkill /PID <pid> /T /F`，其他平台向运行器创建的进程组发信号——根进程仍存活时在 2 秒后重试一次。

**环境。** 子进程环境从 `@metaworkflow/subprocess` 的主机清洗结果出发（凭据形状与 `MWF_*` 名称不会隐式到达节点），加上 UTF-8 三件套，再在存在项目环境时注入 `VIRTUAL_ENV` 与前置的 `PATH` 条目。调用方显式条目最后合并，映射为 `undefined` 的名称会被移除。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件、配置默认值与四个服务方法 |
| `src/interpreter.ts` | 优先级、探测程序、版本与 GIL 拒绝 |
| `src/venv.ts` | `.venv` 布局、串行创建、`--only-binary=:all:` 安装 |
| `src/wrapper.ts` | 节点目录布局、标识符规则、生成的入口程序 |
| `src/output.ts` | 字节上限、结果行扫描、值解码、运行判定 |
| `src/terminate.ts` | 两个平台上的整树终止 |
| `src/env.ts` | 子进程环境组装 |
| `src/command.ts` | 用于探测、`venv` 与 `pip` 的辅助命令 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——Python 节点接入的 seam。
- [工作流项目存储](../project-store/README.zh.md)——节点定义与运行的持久化之处。
- [subprocess 服务](../../subprocess/subprocess/README.zh.md)——本包复用的环境清洗。
- [生成的配置目录](../../../docs/config-catalog.zh.md#metaworkflowworkflow-python-runner)——每个受支持字段。
- [测试策略](../../../docs/testing.zh.md)——这些套件为什么必须启动真实解释器。

-----

<a id="model-experience"></a>
## 模型体验

无：本包为调用方执行主机 Python，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

这里不组装任何模型请求，因此没有缓存前缀被改写；渲染节点值的调用方负责相应的失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

目前没有调度器、工具或 GUI 绑定本服务，所有调用都来自后续阶段；节点协议与错误码就是那些阶段要消费的契约。

- **没有隔离**——节点以主机用户的权限运行。终止进程树属于归属权管理，不是沙箱；需要限制节点时请使用 `@metaworkflow/sandbox-local`。
- **Windows 工作目录上限**——超过 200 字符的项目目录会以 `project/path-too-long` 拒绝，因为更长的路径会让 `CreateProcess` 以 `WinError 267` 失败。
- **拒绝 free-threaded 构建**——`3.14t` 解释器会以 `python/free-threaded` 失败，而不是运行那些假定有 GIL 的 wheel。
- **沿用环境中的 pip 配置**——`pip install` 继承用户的索引、代理与证书设置；运行器不设置索引 URL。
- **不清理环境**——`.venv` 目录只创建与复用，从不回收，项目目录会保留最后一次安装的集合。
- **每次运行不留存**——捕获的日志只存在于结果值中；长日志的落盘文件留给调用方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

在没有受支持的 GIL 启动器的主机上，真实进程套件会跳过，这就是 `tests/support/python.ts` 同步探测一个的原因，也是覆盖率通道依赖它的原因。Windows 上的 Python 会把 stdio 的 `\n` 翻译成 CRLF，因此断言行尾从不精确匹配；扫描器会把每行归一成一个行尾。

</details>
