# Agent Note: One harness home resolver

Status: implemented

English | [中文](2026-07-24-single-harness-home-resolver.zh.md)

## Problem

The harness had two inconsistent conventions for "where does DeepSeek Harness user data live":

- `@metaworkflow/home` resolved `configured ?? $MWF_HOME ?? ~/.mwf`.
- `@metaworkflow/home-paths` shipped a **second** `resolveMwfHome` with the same precedence plus tilde expansion — a near-duplicate of `mwf-home` that no gate flagged because the two lived in different packages and had already drifted (only one expanded tildes).

Two resolvers for the same cross-cutting fact meant there was no single home policy.

## Decision

One resolver owns the harness home, in `@metaworkflow/home-paths`, single-root:

```
explicit configured path  >  $MWF_HOME  >  ~/.mwf
```

An empty or whitespace-only `$MWF_HOME` is treated as unset; otherwise `resolve('')` would silently place the home at the current working directory. The harness keeps all user data under one root; there is no XDG config/data/cache split. `mwfHomePath(...segments)` joins deployment-owned children onto that root, and `mwf-app-boot` exposes it to Loader `!!js` config expressions before mounting entries, so shipped compositions derive `sessions` and `storages` without copying the resolver. `mwfHomeDisplay()` names a resolved root symbolically for user-facing paths — `~/.mwf` for the default home, `$MWF_HOME` for any configured home — so the user-global `AGENTS.md` label never leaks an absolute machine path. It replaces agent-instructions's bespoke default-vs-`$MWF_HOME` check. Home is process policy rather than row configuration: `mwf-agent-instructions` accepts no home override, so a composition cannot point instruction loading at a root that sessions, skills, and storage would not read. `resolveAgentsHome()` and `agentsHomeDisplay()` apply the same precedence, tilde expansion, and symbolic labelling to the shared agent configuration root (`$MWF_AGENTS_HOME` or `~/.agents`), which stays outside the harness home because other agent tools share it ([shared agents root](2026-10-05-shared-agents-root-instructions.md)); `mwf-skill-filesystem` still accepts its own `mwfHome` and `agentsHome` fields, which select its own skill roots and resolve through the shared resolver in the instruction-loading change.

`mwfCachePath(...segments)` derives paths below the resolved home's `cache` directory. An initial `{ mwfHome }` option preserves a provider's explicit home override. It resolves paths without creating directories; callers own directory creation. `attachment-local` uses this helper for regenerable request-image variants while retaining durable attachment objects in their versioned storage tree, so clearing the cache cannot remove Session attachments. Existing request-image cache entries are left in place and are not read or copied; a cache miss regenerates the variant from its durable attachment.

`@metaworkflow/home` is deleted. Home-owning providers and boot packages import `resolveMwfHome` from `mwf-home-paths`; composition bundles contain only the resolved configuration rows.

`mwf-telemetry` and its separate home policy are absent under the [SDK project toolchain removal](../../archived/simplification/2026-08-11-remove-sdk-project-toolchain.md), leaving this resolver as the sole home policy.

## Alternatives considered

**Leave the two `resolveMwfHome` copies in place.** They had already drifted (one expands tildes, one didn't) and encode the same cross-cutting fact twice. Consolidation is the point of the `util/` layer; a duplicate resolver is a latent divergence bug.

**Adopt XDG (honor `$XDG_CONFIG_HOME`, or split config/data/cache into separate trees).** Considered and dropped in favor of one obvious root. A single `$MWF_HOME || ~/.mwf` ground truth matches `~/.claude` / `~/.aws`, needs no per-kind reclassification of every `~/.mwf` consumer, and leaves no resolver asymmetry to reconcile.

## Consequences

- One home fact, one resolver. `mwf-home-paths` is the sole owner; the `util/` group loses the `home` package.
