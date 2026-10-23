---
description: "Run one AI-written Python node function on the host: interpreter resolution, the project .venv, wheels-only dependency installation, and a JSON result protocol that survives log truncation, deadlines, and aborts on Windows, Linux, and macOS."
kind: "package-reference"
---

# @metaworkflow/workflow-python-runner

English | [中文](README.zh.md)

## Summary

Run one AI-written Python node function on the host and get its JSON value back with its logs. `ctx.mwfPythonRunner` picks the interpreter, keeps the project's `.venv`, installs published wheels only, and runs the node in its own directory with UTF-8 stdio. The value travels on a separate sentinel line, so a truncated log can never swallow it, and Chinese text and emoji survive a host whose default encoding is not UTF-8. Failures are structured: an unusable interpreter rejects the call, while a node that raises or times out returns `ok: false`. Nothing schedules work or renders a result yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a Host composition and drive it through `ctx.mwfPythonRunner`; no other plugin is required.

### When to choose it

Choose it when a workflow node is Python an AI wrote and must run as a real child process on the user's machine, and when a project needs its own dependencies installed without a compiler. Do not use it to run untrusted code in a sandbox: the node runs with the host user's authority, and process termination is ownership, not confinement. Do not use it as a general process runner either — `@metaworkflow/subprocess` owns that seam, and this package uses it only for the environment scrub. The workflow scheduler and the GUI are later stages; nothing consumes this service today.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-python-runner'
```

| Field | Default | Meaning |
|---|---|---|
| `interpreterPath` | probed | Interpreter or launcher used when neither the caller nor a project `.venv` supplies one |
| `timeoutMs` | `120000` | Default wall-clock deadline of one node run |
| `maxStdoutBytes` | `65536` | Default cap for a run's stdout log |
| `maxStderrBytes` | `65536` | Default cap for a run's stderr log |
| `installTimeoutMs` | `300000` | Deadline for one `.venv` creation or `pip install` |

The generated [configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-python-runner) is the exhaustive source for every accepted field.

### Service API

| Method | Behavior |
|---|---|
| `resolveInterpreter({ interpreterPath?, projectDir? })` | Validates the caller's path, then an existing project `.venv`, then the configured path, then a platform probe; every tier must report 3.10–3.14 with the GIL |
| `ensureVenv(projectDir)` | Creates `<projectDir>/.venv` when missing and returns its interpreter; concurrent calls for one project serialize |
| `installRequirements(projectDir, requirements)` | Runs `pip install --only-binary=:all:` in the project environment and reports pip's exit facts |
| `runNode({ projectDir, nodeId, source, inputs?, timeoutMs?, env?, maxStdoutBytes?, maxStderrBytes?, signal? })` | Writes the node, runs it, and returns `{ ok, value?, error?, stdout, stderr, exitCode, durationMs, timedOut }` |

`resolveInterpreter`, `ensureVenv`, `installRequirements`, and `runNode` reject with a typed `PythonRunnerError` code for environment problems: `python/not-found`, `python/unsupported-version`, `python/free-threaded`, `venv/create-failed`, `project/path-too-long`, or `node/invalid-id`. A node's own failure resolves with `ok: false` and one of `node/exception`, `node/invalid-return`, `node/timeout`, or `node/output-too-large`, so one bad node never aborts a batch. An aborted run rejects with the signal's reason.

### Node protocol

The runner writes `source` to `<projectDir>/nodes/<nodeId>/node_main.py` and adds `node_runner.py` beside it. The node module must define `nodemain_<id>(inputs)` — every character outside `[A-Za-z0-9_]` in the id becomes `_` — and return a `str` holding JSON.

```python
import json

def nodemain_extract(inputs):
    return json.dumps({"title": inputs["title"], "ok": True})
```

The wrapper reads UTF-8 JSON from stdin, calls the node, and writes exactly one `__MWF_RESULT__ <json>` line. A raised exception prints its traceback to stderr and exits `1`; a return value that is not a `str`, or a `str` that is not JSON, exits `2`. The runner accepts exactly one result line and rejects a missing or duplicated line as `node/invalid-return`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service holds two pieces of state: the resolved settings and one `VenvManager` that serializes environment creation per project directory. Every other decision is a pure function over its inputs, which is why the package has no teardown.

**Interpreter precedence.** A named tier is authoritative: an unusable explicit path, project `.venv`, or configured path refuses the call instead of silently running elsewhere. The probe tier instead walks `py -3` and `python` on Windows, or `python3` elsewhere, because a host can register a free-threaded build as its default launcher and still hold a supported interpreter; the first qualifying launcher wins, and the first structured refusal is reported when none does. The probe prints the version, the GIL flag, and `sys.executable`, so a launcher resolves to the absolute binary every later spawn uses.

**Encoding.** A Windows Python writes GBK on stdio by default, which silently mangles Chinese text and raises on emoji. Three layers stop that: `-X utf8` on the interpreter's argv, `PYTHONUTF8`/`PYTHONIOENCODING`/`PYTHONUNBUFFERED` in the child environment, and `ensure_ascii=True` when the generated wrapper serializes the result line. `PYTHONUNBUFFERED` also keeps a killed node's last log lines.

**Output caps.** Each stream is capped independently before decoding, stdout keeps its head and stderr keeps its tail because a traceback ends with the diagnosis. Dropped bytes are reported in the captured text, and the result line never enters the capped buffer: the scanner splits stdout into lines as it arrives and diverts the sentinel line into its own slot, with a separate 8 MiB cap for the value itself.

**Termination.** `child.kill()` reaches only the process the runner started, and a node may spawn its own child. A deadline or an abort therefore terminates the whole tree — `taskkill /PID <pid> /T /F` on Windows, a signal to the process group the runner created off Windows — and retries once after two seconds when the root is still alive.

**Environment.** The child environment starts from the host scrub in `@metaworkflow/subprocess` (credential-shaped and `MWF_*` names never reach a node implicitly), adds the UTF-8 triple, then `VIRTUAL_ENV` and a leading `PATH` entry when a project environment exists. The caller's explicit entries merge last, and a name mapped to `undefined` is removed.

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin, config defaults, and the four service methods |
| `src/interpreter.ts` | Precedence, probe program, version and GIL refusals |
| `src/venv.ts` | `.venv` layout, serialized creation, `--only-binary=:all:` installation |
| `src/wrapper.ts` | Node directory layout, identifier rules, generated entry program |
| `src/output.ts` | Byte caps, result-line scanning, value decoding, run verdicts |
| `src/terminate.ts` | Whole-tree termination on both platforms |
| `src/env.ts` | Child environment assembly |
| `src/command.ts` | Helper commands for probing, `venv`, and `pip` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam a Python node plugs into.
- [Workflow project store](../project-store/README.md) — where node definitions and runs are durable.
- [Subprocess service](../../subprocess/subprocess/README.md) — the environment scrub this package reuses.
- [Generated configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-python-runner) — every accepted field.
- [Testing policy](../../../docs/testing.md) — why these suites spawn a real interpreter.

-----

<a id="model-experience"></a>
## Model Experience

None, as the runner executes host Python for callers and registers no prompt, tool, or session event.

#### KV Cache effect

No model request is assembled here, so no cached prefix changes; the consumer that renders a node's value owns any resulting invalidation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

No scheduler, tool, or GUI binds this service yet, so every call arrives from a later stage; the node protocol and error codes are the contract those stages consume.

- **No confinement** — a node runs with the host user's authority. Process-tree termination is ownership, not a sandbox; use `@metaworkflow/sandbox-local` when a node must be confined.
- **Windows working-directory ceiling** — a project directory over 200 characters is rejected with `project/path-too-long`, because a longer one makes `CreateProcess` fail with `WinError 267`.
- **Free-threaded builds are refused** — a `3.14t` interpreter fails with `python/free-threaded` instead of running nodes whose wheels assume the GIL.
- **Ambient pip configuration** — `pip install` inherits the user's index, proxy, and certificate settings; the runner sets no index URL.
- **No environment pruning** — `.venv` directories are created and reused, never garbage-collected, and a project directory keeps its last installed set.
- **Nothing is retained per run** — the captured logs live only in the result value; a spill file for a long log is deferred to the consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The real-process suites skip on a host without a supported GIL-enabled launcher, which is why `tests/support/python.ts` detects one synchronously and the coverage lane depends on it. Windows Python translates `\n` to CRLF on stdio, so exact line endings are never asserted; the scanner normalizes them to one line ending per line.

</details>
