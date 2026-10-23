---
description: "MetaWorkFlow 浏览器应用组合包：基于 mwf-base 的 MetaWorkFlow 产品 patch 层及其运行时粘合插件，作为 metaworkflow profile 随发行版交付。"
kind: "package-bundle"
---

# @metaworkflow/app

[English](README.md) | 中文

MetaWorkFlow 是一个独立的产品表层。本组合包把 [Web 表层](../web-app/README.zh.md)的配置行改写为 MetaWorkFlow 自有包名，使两个产品可以分别演进，并以 `metaworkflow` profile 模板随发行版交付。

## 概述

使用 `mwf --profile metaworkflow` 启动 MetaWorkFlow 浏览器 GUI。该 profile 把本组合包叠放在 `mwf-base` 之上，提供与 Web 表层相同的聊天、模型与设置管理、会话历史、工具与安全默认值，并使用自己的 Harness home，因此不会触碰 `~/.mwf` 与 Desktop 应用。启动时会打印带 token 的 URL，并接受 Web 的全部 flag。每个会话选择一个随发行版交付的 agent preset，默认为 `standard`。

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

把 `MWF_HOME` 指向 MetaWorkFlow 自有目录后启动。首次启动会用随发行版的模板初始化 `$MWF_HOME/profiles/metaworkflow`，因此该 profile 不会与其他 mwf 安装共用会话、设置、凭据或 patch 文件。

```sh
export MWF_HOME=/absolute/path/to/metaworkflow-home
mwf --profile metaworkflow
mwf metaworkflow --no-open --port 8080
```

启动守卫在 `MWF_HOME` 未设置或解析为共享 Harness home（`~/.mwf` 或重命名前的 `~/.dsh`）时拒绝启动。拒绝信息会指出问题 home，并打印修复命令：PowerShell 中的 `$env:MWF_HOME = "<repo>\.mwf-home"`，其中填入 checkout 的实际路径。任何其他显式 home 都会被接受。

`mwf metaworkflow` 是 `mwf --profile metaworkflow` 的缩写。Web 的每个 flag 家族行为都与 [Web 表层](../web-app/README.zh.md#use-this-package)的说明完全一致：`--host` 绑定一个具体的本机地址，`--port` 选择监听端口，`--tls-cert`/`--tls-key` 直接提供 HTTPS，`--public-url` 与 `--trusted-host` 描述剥离前缀的代理部署，`--no-open` 抑制浏览器交接。启动 URL 行、token 交换、签名 cookie 与浏览器信任围栏都与 Web profile 相同。

Agent 平面按会话从随发行版的 preset（`standard`、`ptc`、`minimal`、`cordis`）组合。设置 → 模型使用 `DEEPSEEK_API_KEY` 显示 **DeepSeek**；Agent presets 页面可以更改默认 preset 并编辑 preset 子插件，保存结果写入 `$MWF_HOME/profiles/metaworkflow/cordis.patch.yml`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本组合包是 `mwf-base` 之上的一层 patch：`cordis.patch.yml` 重述表层相关的 base 取值，然后插入 Web 专属的 host 行、传输层、浏览器名册与 preset 注册表；每个 `presets/<id>.patch.yml` 插入一个随发行版交付的 preset 声明，按 `mwf.bundle.patch` 列出的顺序应用。[`src/index.ts`](src/index.ts) 是运行时粘合插件——解析前端 dist、公告应用 URL、注册 `MWF_WEB_URL` bash 变量、打印 URL 行、交接浏览器——[`src/startup.ts`](src/startup.ts) 提供 `webStartup` 服务，供 `--host`、`--port`、`--public-url`、`--trusted-host`、`--no-open` 与 TLS 各行注入。 启动 action 最先应用 [`src/home-guard.ts`](src/home-guard.ts)，因此被拒绝的 home 绝不会发布 `webStartup`，依赖它的服务端行会保持未激活。浏览器名册还会挂载 `@metaworkflow/client-ui-mw-projects`，即该 profile 打开时显示的[项目首页](../../client/ui-mw-projects/README.zh.md)。

行 id、`webStartup` 服务、`webApp` 服务与插件包名只在产品不同处不同，因此针对 Web 组合编写的 `--patch` 覆盖层在这里同样适用。提交在此的配置行与 preset 声明是 Web 层的副本：修改共享行意味着同时修改两个组合包，且没有任何机制让二者保持同步。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `metaworkflow-app` 粘合插件：dist 解析、公告应用 URL、bash 变量、URL 行、浏览器交接 |
| [`src/public-url.ts`](src/public-url.ts) | 公告根校验与结尾斜杠规范化；供本地导入的叶子模块，不属包 API |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供者：`--host`、`--port`、`--tls-cert`、`--tls-key`、`--public-url`、`--trusted-host`、`--no-open`、`--help` |
| [`src/home-guard.ts`](src/home-guard.ts) | home 隔离规则、修复命令文本，以及启动 action 在发布 `webStartup` 前使用的 checkout 查找 |
| [`cordis.patch.yml`](cordis.patch.yml) | MetaWorkFlow patch：重述的 base 取值、host 行、浏览器名册、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis`）一个 `@metaworkflow/agent-preset` 声明，各自一个 patch 文件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 表层](../web-app/README.zh.md)——本产品层重述的浏览器表层组合包。
- [mwf-base](../base/README.zh.md)——每个 MetaWorkFlow 会话运行的共享核心。
- [app-boot](../../boot/app-boot/README.zh.md)——profile 如何解析、分层与定制其组合包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#metaworkflowapp)——每个被接受的配置字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Web 运行时变量

#### 模型看到什么

当 `surfaceContext` 为 true 时，`MWF_WEB_URL` 连同描述出现在受管 bash 环境中，每次调用时解析为公告应用 URL。为 false 时不注册该变量。GUI 定位、实现 checkout 与当前 GUI URL 由本 bundle 挂载的 [`mwf-harness-dev-context`](../../context/harness-dev-context/README.zh.md) 行提供。

#### Token 影响

两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

无；该插件不贡献系统提示词文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **配置行是副本**——本组合包重述 Web 层而不是引用它，因此行变更必须手工同步到两个组合包；没有任何检查能发现漂移。
- **随发行版的 preset 是副本**——`standard`、`ptc`、`minimal` 与 `cordis` 在本包下重述 Web 的声明，同样需要手工保持同步。
- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **只有 home 守卫有本包测试**——运行时粘合仍是 Web 版本的副本，由 Web 包的测试覆盖；守卫与启动拒绝则有各自的 keyless 测试。
- **profile 拥有自己的 Harness home**——会话、设置、凭据与用户 patch 层都保存在启动器指向的 `MWF_HOME` 下；启动会拒绝未设置、`~/.mwf` 与 `~/.dsh`，并接受任何其他显式路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

该包为 `private`，随 mwf 安装作为 `metaworkflow` profile 模板交付；它不是按需安装的组合包，因此不出现在 `OPTIONAL_BUNDLES` 与 Official 插件目录中。

</details>
