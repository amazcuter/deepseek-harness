---
kind: upgrade-guide
description: "The `agent-instructions` row no longer accepts `mwfHome`; instruction loading always resolves the harness home from `$MWF_HOME` or `~/.mwf`."
---

# Instruction loading resolves one harness home

English | [中文](guide.zh.md)

## Change

`@metaworkflow/agent-instructions` removed its `mwfHome` config field. The plugin resolves the harness home through `resolveMwfHome()` from `@metaworkflow/home-paths`, like every other harness consumer: the home is `$MWF_HOME` when it is set and non-blank, otherwise `~/.mwf`, with tilde expansion.

A `cordis.yml`, profile patch, or `--patch` overlay that still sets `mwfHome` on the `agent-instructions` row has no effect: the row keeps the stray key and the plugin ignores it, so instruction loading follows the process home. Other providers, such as `mwf-skill-filesystem` and `mwf-shell-env`, keep their own home fields; this removal covers the instruction loader only.

## Migration

1. Delete `mwfHome` from the `agent-instructions` row in `cordis.yml`, `$MWF_HOME/cordis.patch.yml`, `$MWF_HOME/profiles/<profile>/cordis.patch.yml`, and any `--patch` overlay.
2. Where the override pointed at a non-default home, export `MWF_HOME` for the process instead, so every harness consumer reads that home.
3. Confirm with `mwf --profile <profile> --dump-config` that the `agent-instructions` row lists only its remaining fields, and that a new session's first request shows `Instructions from: $MWF_HOME/AGENTS.md` (or `~/.mwf/AGENTS.md`) when that file exists.
