---
description: "The MetaWorkFlow browser application bundle: the MetaWorkFlow product patch layer over mwf-base plus its runtime glue plugin, shipped as the metaworkflow profile."
kind: "package-bundle"
---

# @metaworkflow/app

English | [中文](README.zh.md)

MetaWorkFlow is an independent product surface. This bundle restates the [Web surface](../web-app/README.md) rows under MetaWorkFlow's own package so the two products can change separately, and it ships as the `metaworkflow` profile template.

## Summary

Use `mwf --profile metaworkflow` for the MetaWorkFlow browser GUI. The profile stacks this bundle over `mwf-base` and serves the same chat, model and settings management, session history, tools, and safety defaults as the Web surface, from its own Harness home, so `~/.mwf` and the Desktop application are never touched. Startup prints a tokenized URL and accepts the Web flag family. Each session selects a shipped agent preset, `standard` by default.

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

Point `MWF_HOME` at a MetaWorkFlow-owned directory and launch the profile. The first launch initializes `$MWF_HOME/profiles/metaworkflow` from the shipped template, so the profile never shares sessions, settings, credentials, or patch files with another mwf installation.

```sh
export MWF_HOME=/absolute/path/to/metaworkflow-home
mwf --profile metaworkflow
mwf metaworkflow --no-open --port 8080
```

The launch guard refuses to start when `MWF_HOME` is unset or resolves to the shared Harness home (`~/.mwf` or the pre-rename `~/.dsh`). The refusal names the offending home and prints the command that fixes it: `$env:MWF_HOME = "<repo>\.mwf-home"` in PowerShell with the checkout's real path filled in. Any other explicit home is accepted.

`mwf metaworkflow` abbreviates `mwf --profile metaworkflow`. Every Web flag family behaves exactly as the [Web surface](../web-app/README.md#use-this-package) documents: `--host` binds one concrete local address, `--port` chooses the listener, `--tls-cert`/`--tls-key` serve HTTPS, `--public-url` and `--trusted-host` describe a prefix-stripping proxy deployment, and `--no-open` suppresses the browser handoff. The startup URL line, token exchange, signed cookie, and browser-trust fence are the same ones the Web profile uses.

The agent plane is composed per session from the shipped presets (`standard`, `ptc`, `minimal`, `cordis`). Settings → Models shows **DeepSeek** over `DEEPSEEK_API_KEY`; the Agent presets page changes the default preset and edits preset child plugins, and saves land in `$MWF_HOME/profiles/metaworkflow/cordis.patch.yml`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch layer over `mwf-base`: `cordis.patch.yml` restates the surface-specific base values, then inserts the web-only host rows, the transport layer, the browser roster, and the preset registry; each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `mwf.bundle.patch` lists them. [`src/index.ts`](src/index.ts) is the runtime glue plugin — frontend dist resolution, the advertised application URL, the `MWF_WEB_URL` bash variable, the URL line, and the browser handoff — and [`src/startup.ts`](src/startup.ts) provides the `webStartup` service that the `--host`, `--port`, `--public-url`, `--trusted-host`, `--no-open`, and TLS rows inject. The startup action first applies [`src/home-guard.ts`](src/home-guard.ts), so a refused home never publishes `webStartup` and the server-bound rows that inject it stay inactive. The browser roster additionally mounts `@metaworkflow/client-ui-mw-projects`, the [project dashboard](../../client/ui-mw-projects/README.md) this profile opens on.

Row ids, the `webStartup` service, the `webApp` service, and the plugin package names differ only where the product differs; a `--patch` overlay written against the Web composition therefore applies unchanged here. The committed rows and preset declarations are copies of the Web layer: changing a shared row means changing both bundles, and no mechanism keeps them in step.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `metaworkflow-app` glue plugin: dist resolution, advertised application URL, bash variable, URL line, browser handoff |
| [`src/public-url.ts`](src/public-url.ts) | Advertised-root validation and trailing-slash normalization; a leaf module for local imports, not package API |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--tls-cert`, `--tls-key`, `--public-url`, `--trusted-host`, `--no-open`, `--help` |
| [`src/home-guard.ts`](src/home-guard.ts) | Home-isolation rule, fix-command text, and the checkout lookup the startup action applies before publishing `webStartup` |
| [`cordis.patch.yml`](cordis.patch.yml) | The MetaWorkFlow patch: restated base values, host rows, browser roster, preset registry |
| [`presets/`](presets) | One `@metaworkflow/agent-preset` declaration per shipped preset (`standard`, `ptc`, `minimal`, `cordis`), each its own patch file |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web surface](../web-app/README.md) — the browser-surface bundle this product layer restates.
- [mwf-base](../base/README.md) — the shared core every MetaWorkFlow session runs on.
- [app-boot](../../boot/app-boot/README.md) — how profiles resolve, layer, and customize their bundles.
- [Generated configuration catalog](../../../docs/config-catalog.md#metaworkflowapp) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Web runtime variable

#### What the model sees

When `surfaceContext` is true, `MWF_WEB_URL` appears in the managed bash environment with its description, resolved per invocation as the advertised application URL. When it is false, the variable is not registered. The GUI orientation, the implementation checkout, and the current GUI URL come from the [`mwf-harness-dev-context`](../../context/harness-dev-context/README.md) row this bundle mounts.

#### Token effect

Two managed-environment variable lines; constant per process.

#### KV Cache effect

None; the plugin contributes no system-prompt text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The patch rows are copies** — this bundle restates the Web layer instead of referencing it, so a row change must be applied to both bundles by hand; nothing detects the drift.
- **The shipped presets are copies** — `standard`, `ptc`, `minimal`, and `cordis` restate the Web declarations under this package, with the same keep-in-step obligation.
- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **Only the home guard has local tests** — the runtime glue remains a copy covered by the Web package's tests, while the guard and the startup refusal carry their own keyless suite.
- **The profile owns its Harness home** — sessions, settings, credentials, and the user patch layer stay under the `MWF_HOME` the launcher points at; startup refuses an unset home and the shared `~/.mwf`/`~/.dsh` homes, and accepts any other explicit path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package is `private` and ships inside the mwf installation as the `metaworkflow` profile template; it is not an on-demand bundle, so it is absent from `OPTIONAL_BUNDLES` and the Official plugin catalog.

</details>
