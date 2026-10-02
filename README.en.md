# dsh-llm-qodersdk

> [中文](README.md) | **English**

An adapter plugin (`@jiamingzang/dsh-llm-qoder`) that routes DeepSeek Harness's LLM seam (`ctx.llm`) to the local **Qoder CLI**, built on [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk).

It registers the `qoder` / `qoder-byok` provider routes so the harness's model requests reuse the local `qodercli` login state — **no credentials or settings required**. Both built-in models and account-custom models are fetched live from qodercli.

## Features

- **Zero-config**: fully reuses the local `qodercli` login state; no API key or settings section needed.
- **Two routes**: `qoder` advertises built-in account models; `qoder-byok` advertises only account-custom models (each with its own independent route).
- **Persistent sessions**: one warm inner `query()` subprocess per host session id; conversation continuation and tool rounds all happen inside the session, LRU-evicted by insertion order within the `maxSessions` cap.
- **Tool bridging**: host tools are exposed to the inner model through an in-process MCP server (`dsh-host`); qodercli executes one call at a time and the host returns the whole round of results, paired by callId (timed out and cancelled if not delivered within 120s).
- **Model catalog**: fetches available models (including account-custom ones) live from the CLI with TTL caching + shared concurrency + timeout protection, falling back to a static catalog on failure; also provides `deepseek-v4-flash` → `dfmodel` and `deepseek-v4-pro` → `dmodel` aliases.
- **Reasoning effort**: `resolveModel` reports the CLI's reasoning efforts and default level, switchable directly in the model selector; the selected value is sent down to the inner session with every request.
- **Context window**: `resolveModel` reports only the window the requests actually use (`LlmModelContext` in the current seam has `contextWindow` as its only field), so the compaction threshold and the context ring's denominator stay consistent with the inner real window.
- **Vision input**: only models the CLI explicitly marks `isVl: true` in the model catalog advertise the `image` modality; for those models, images newly uploaded this round and images inside tool results are forwarded to the inner CLI as base64. Historical images and text-only models still go through the harness placeholder text, so pixels are never re-counted into every request.
- **Side-channel requests**: titles, compaction summaries, and other side-channel requests use one-shot cold calls that never occupy a warm session.
- **Overflow recoverable**: when the inner model fails on context overflow (e.g. `maximum context length ... you requested N tokens`), the error is classified as `CONTEXT_WINDOW_EXCEEDED` via dsh-llm's `isContextWindowExceededError`, so the harness's overflow auto-recovery (with `compaction-basic`) takes over instead of wasting the turn.

## Adaptation Principles

This section explains how the plugin maps the harness's LLM seam to qodercli — **what each layer adapts and why it is designed that way**.

### 1. LLM seam adaptation (`ctx.llm` → qodercli)

The harness registers `QoderAdapter` via `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`, implementing the harness's `LlmAdapter` contract:

| Harness seam | This plugin's implementation |
| --- | --- |
| `providerInfo(provider)` | Returns the display names for `qoder` (`Qoder CLI`) / `qoder-byok` (`Qoder 自定义`, i.e. Qoder custom) |
| `listModels(provider)` | Fetches the qodercli model catalog live, filtered by provider (`qoder` → built-in; `qoder-byok` → account-custom `source === 'user'`) |
| `resolveModel(provider, model)` | Resolves model metadata (context window, reasoning effort, output limit) from the live catalog / static table |
| `stream(options)` | Turns a `GenerateOptions` into a qodercli `query()` call and streams back `StreamChunk` |

The core of the adaptation is **`stream()` routing**:

- **Warm session path** (has `sessionId` and no `purpose`): reuse or spawn an inner `query()` subprocess, feed new messages incrementally, and round-trip tools over MCP.
- **Side-channel path** (no `sessionId`, or carries `purpose`, e.g. title generation, compaction summaries): one-shot `coldStream()` call that does not occupy a warm session. **This path reuses the main session's model** (`resolveQoderModelId(options.model)`), so the call target dsh records matches the model actually executed.

### 2. Session model adaptation

- **One host session ↔ one warm qodercli session**: `QoderSessionManager` keys `query()` subprocesses by host `sessionId`; beyond `maxSessions` they are evicted LRU by insertion order.
- **Incremental feed**: the host sends the full message list on every request; the plugin uses `planContinuation` to diff against the previous one and renders only the new user turns and rewritten messages into the feed; tool results do not enter the feed (they go over MCP). The feed is plain text by default, and only becomes "text + image" blocks when this round carries images and the model advertises `image`.
- **Rebuild detection**: when the host surface is rewritten (e.g. compaction folds history) so messages shrink or restructure, `planContinuation` returns `rebuild: true` and the plugin disposes the old warm session and cold-starts from the new surface. **This guarantees dsh-side compaction and qodercli's internal cache never hold duplicate state.**
- **Model switching**: `setModel` forwards `reasoningEffort` to the inner session as a model-policy parameter. `GenerateOptions` in the current seam carries no per-request window, so the inner session always runs on the CLI's own default window — the same source as the value `resolveModel` reports.

### 3. Tool bridging adaptation (MCP)

Host tools are not sent directly to qodercli; they go through an **in-process MCP server** (`dsh-host`):

1. `ensureTools()` converts host `ToolSchema` to zod shapes and registers them on the MCP server;
2. qodercli's `canUseTool` allows tools with the `mcp__dsh-host__*` prefix and records tool-use ids;
3. the MCP handler **parks** on a promise, waiting for the host to deliver results via `deliverToolResults()` in the next request round;
4. results are paired by `callId ↔ toolUseId`; on timeout (`TOOL_RESULT_TIMEOUT_MS`) an error is returned so qodercli can recover.

Host tool calls thus remain ordinary tool rounds on the host side, while qodercli only sees an MCP tool "executed once".

### 4. Model catalog adaptation

- **Live catalog**: `QoderModelCatalog` sends a `get_models` control request to qodercli, with TTL caching (default 300s), shared concurrency, and a timeout fallback to the static table.
- **Static fallback**: `QODER_MODELS` is a captured built-in model table (including `deepseek-v4-flash` / `deepseek-v4-pro` aliases), used when the CLI is unreachable.
- **Provider grouping**: `listModels` splits by the `source` field — built-in models go to `qoder`, account-custom models (`source === 'user'`) go to `qoder-byok`. No manual configuration; everything is fetched live from qodercli.

### 5. Context window & compaction threshold adaptation

The qodercli live catalog reports both the **ceiling** and the **actual window** for each model:

```
maxInputTokens: 1000000          ← model ceiling (1M)
availableContextWindows: [200000, 400000, 1000000]
defaultContextWindow: 200000     ← the window requests actually use
```

The harness compaction engine derives the auto-compaction threshold from `resolveModel().context.contextWindow` (`thresholdTokens = 0.8 × contextWindow`; compaction-basic default `thresholdRatio: 0.8`), and the UI context ring uses it as the denominator. `contextWindow` must therefore reflect **the window requests actually use**, not the model ceiling:

```ts
contextWindow: live.defaultContextWindow ?? live.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW
```

- Using `defaultContextWindow` (the actual window, e.g. 200K) → threshold = 160K, aligned with the provider's real capacity;
- If the ceiling were used, the threshold would be inflated (e.g. 800K) and compaction would never fire before the provider rejects the request;
- `LlmModelContext` in the current seam has `contextWindow` as its only field, so the CLI's optional tiers are no longer shipped with the metadata (the selector cannot switch windows; only the CLI itself decides).

### 4.5 Call-generation binding (`prepareCall`)

The harness first calls `prepareCall(provider, model, signal)` to bind "the model metadata for this one call", and dispatches the streaming request later (`dsh-agent-loop` uses exactly this path). The plugin overrides it to pin the resolved metadata together with the capabilities derived from it (whether it is a vision model) onto the same generation: even if the CLI catalog or the login state changes between prepare and stream, this round never attaches "the previous generation's capabilities" to "the next generation's endpoint".

**This is also the root-cause fix for `registration.adapter.prepareCall is not a function`**: that method is a concrete method added to the `LlmAdapter` base class in dsh-llm 0.1.1-rc.2, so the plugin must be compiled/installed against a dsh-llm that contains it, or it blows up at runtime (see issue #2).

### 6. Context usage metering adaptation

The qodercli stream `usage` frames (`input_tokens` / `output_tokens`) are zeroed by default (no metering data), so real usage cannot be reported directly. The harness `contextPressure` projection uses the most recent request's `inputTokens` as the numerator (`pressureTokens`) to drive the UI ring and compaction checks.

Adaptation: **estimate each request's input on the plugin side with the same measure the harness front-end token meter uses.**

`adapter.stream()` calls `session.recordRequestInput(system, messages)` on every request, rendering the full conversation (system prompt + all messages) via `renderInitialFeed(system, messages)`, estimating text tokens as `characters / 4` — the same `CHARS_PER_TOKEN = 4` convention as harness `estimate.ts` — while each image forwarded this round adds `width x height / 750` tile tokens. `usage()` prefers this estimate:

```ts
if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
  return { inputTokens: this.estimatedInputTokens, ... }
}
```

The UI context ring, auto-compaction threshold, and the plugin-reported values thus **share one estimation convention**: occupancy display and compaction behavior agree, with no "UI shows 2% while actually near the limit" split.

**Image metering is an estimate, not provider data**: qodercli reports no usage for vision payloads, and the plugin declares neither `imageRequestPricing` nor an image budget, since there is no trustworthy per-model visual-token price to fill in. The tile formula therefore only keeps the context ring and the compaction threshold from under-counting; the `IMAGE_OFFLOAD_REQUIRED` budget-driven per-image offload path never fires on the `qoder` route, and image-heavy overflow surfaces as an inner error.

### 7. Error classification adaptation

qodercli reports context overflow, quota exhaustion, and other rejections uniformly as a generic per-turn error (`error_during_execution`). The harness overflow recovery only triggers on the `CONTEXT_WINDOW_EXCEEDED` code (prune + compact + retry). The plugin therefore maps qodercli error text to harness-routable codes using dsh-llm's shared classifier:

```ts
function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}
```

Provider context overflow thus triggers harness auto-recovery and quota exhaustion surfaces correctly, instead of dying as an ordinary backend error.

### 8. Compaction responsibility split (dsh vs qoder)

- **Compaction is executed by dsh** (harness compaction-basic): it decides the compaction scope and retention ratio (default `retainRatio: 0.16` keeps the most recent 16%), calls the LLM to produce a checkpoint, and rewrites the session surface.
- **The qoder plugin only acts as the LLM backend**: it feeds dsh's messages to qodercli and returns the replies. Compaction summary requests go through the side-channel `coldStream()` and reuse the main session's model (see §1), so the summary target dsh records matches what actually runs.
- **No-conflict guarantee**: after dsh compaction rewrites the surface, the plugin's `planContinuation` detects the message structure change (`rebuild: true`) and rebuilds the warm session. qodercli's internal cache is invalidated along with the dsh compaction — **there is never "both sides compacting"**.
- Summaries default to the main session route; to bypass a specific provider's quota, point compaction-basic's `summarizationProvider` / `summarizationModel` at another model with quota in `cordis.patch.yml`.

## Compatibility

| dsh runtime | Usable | Notes |
| --- | --- | --- |
| `0.1.7-rc.1` ~ `0.2.x` | ✅ | This repository is compiled and tested against this seam generation (`@deepseek-ai/dsh-llm`'s `RequestMessage` / `role: 'tool'` tool results / `ToolCallId` / `prepareCall`) |
| `0.1.1-rc.2` ~ `0.1.2-rc.1` | ❌ | Tool results are still `tool-result` content blocks, the call-id function is still named `CallId`, and `GenerateOptions` has no `contextWindow`; neither the types nor the runtime match |
| `0.1.0-rc.x` | ❌ | The base class has no `prepareCall`; after selecting a qoder route, the very first message fails with `registration.adapter.prepareCall is not a function` (issue #2) |

The peer range is pinned to `^0.1.7-rc.1 || ^0.2.0-rc.1` rather than a cross-tuple form like `^0.1.0-rc.5`: npm's semver matches prereleases only inside the same `[major,minor,patch]` tuple, so the old range would never resolve to the fixed versions and would also be judged incompatible with the runtime by dsh's profile installer, which then refuses the install.

## Installation

Prerequisites: a local `qodercli` binary with an active login (`qodercli --version` runs). The plugin fully reuses the qodercli login state — no API key or settings section needed.

### Channel 1: direct from Git (no local build needed)

```sh
dsh plugin --profile <profile> add git+https://github.com/JiamingZang/dsh-llm-qodersdk.git
```

The repository **commits the build artifacts** — `lib/index.js` and `lib/types/*.d.ts` — so this path does not need pnpm to run the plugin's own `prepare` script (on newer pnpm, an unapproved `prepare` hard-fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` instead of being silently skipped).

If the install prints `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @qoder-ai/qoder-agent-sdk`, **you can ignore it for now**: the published SDK's default runtime is Worker, and its postinstall does not download the `qodercli` binary in the first place (see `scripts/postinstall.cjs`); tested in practice, the plugin still loads and starts the inner session normally with the build script skipped. Approve it only when one of the following applies:

- your environment cannot run the Worker runtime and you need the in-process CLI fallback: change the corresponding key under `allowBuilds` in the profile `~/.dsh/profiles/<profile>/pnpm-workspace.yaml` to `true` and rerun add (or confirm it in the build approval UI of the dsh Web interface) — equivalent to `QODER_INSTALL_BUNDLED_CLI=1`;
- you want to use your already-installed local `qodercli`: no approval needed, just set `QODERCLI_PATH`.

There is only one real prerequisite: **the local `qodercli` is logged in**. When it is not, the plugin still registers normally and still sends requests; the turn ends in error and returns `No qodercli login found. Run "qodercli login" first.`

### Channel 2: local package (tgz / directory)

```sh
dsh plugin --profile <profile> add ./jiamingzang-dsh-llm-qoder-<version>.tgz
```

The package produced by `pnpm pack` already contains `lib/`, and the install flow is the same as channel 1 (the build script is not required, see above).

### Channel 3: npm

`@jiamingzang/dsh-llm-qoder` is not published to npm yet (`npm view` returns 404). Once published, `dsh plugin add @jiamingzang/dsh-llm-qoder` becomes the least effort path; until then use one of the two channels above.

### Verification & manual mount

- Verify: `dsh --profile <profile> --dump-config | grep llm-qoder` should show the plugin entry; once the service starts, the model selector shows the two groups `Qoder CLI` / `Qoder 自定义` (Qoder custom) (taking >10s on the first start is normal).
- Without going through the plugin command, declare it directly in cordis.yml or a patch layer (the plugin's package.json also declares `dsh.bundle`, so plugin add joins it to the profile's bundles automatically):

```yaml
- id: llm-qoder
  name: '@jiamingzang/dsh-llm-qoder'
```

### Usage & troubleshooting

- Pick a model under `Qoder CLI` (account built-ins) or `Qoder 自定义` (Qoder custom, account custom models) in the dialog model selector or on the Models settings page; reasoning effort levels can be switched in the model panel.
- **Custom models not visible**: usually the live catalog fetch failed during a qodercli auto-upgrade window or because the account quota ran out (the server side marks models `isEnabled: false`), so the plugin fell back to the static catalog. Failed fetches are not cached; once the CLI recovers the live catalog comes back automatically — no service restart needed.
- **Images sent but invisible to the model**: only models the live catalog marks `isVl: true` advertise image input; for the other models the host projects images into placeholder text, and the plugin does not fake vision capability.
- **Turns ending straight in error**: first check whether it is `No qodercli login found` — the inner session reuses the local qodercli login state, so when you are not logged in the plugin's own registration and catalog are both fine and only the request fails.

## Configuration

The configuration options are the plugin profile entry's `Config` (the settings page projects that schema directly via dsh-settings; the plugin no longer registers its own namespace):

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxSessions` | number | `8` | Max warm inner qodercli sessions kept (beyond this, LRU eviction by insertion order) |
| `modelCacheTtlSeconds` | number | `300` | Freshness TTL for the CLI model catalog cache |

After a configuration change, the profile loader re-`apply()`s: the new adapter takes over the routes, and the old adapter's warm sessions close along with the effect.

## Context Management & Compaction

Warm inner sessions accumulate the whole host history: the first turn feeds the full history (`renderInitialFeed`), and each later turn feeds only the increment (new user messages, in-place refreshes). The inner context thus grows with the conversation, while the model has a hard ceiling (e.g. 1048576 tokens).

- **Overflow auto-recovery**: when the inner model reports context overflow, the plugin reports `CONTEXT_WINDOW_EXCEEDED`. The harness overflow recovery (`dsh-compaction-basic`'s `agent/request-error` handler) compacts the host history and retries; once the history shrinks, the next request detects the rollback and rebuilds the inner session, cold-feeding the compacted history.
- **Prerequisite**: the deployment must load `dsh-compaction-basic` (`auto` defaults to `true`) and `dsh-token-meter`. Without a compaction plugin, the overflowing turn still fails — only a new session or manual compaction helps.
- **Consider lowering the pressure threshold**: the default `thresholdRatio` of 0.8 × model contextWindow (1048576 → ~838k) may fire late, especially since host-side token estimation can drift from the inner real usage. Lowering it to 0.6 makes pressure compaction fire well before overflow:

  ```yaml
  - id: compaction-basic
    config:
      auto: true
      thresholdRatio: 0.6
      retainRatio: 0.16
  ```

  You can also configure the `qoder` route separately via `modelPolicies`.
- **Manual compaction**: with `dsh-command-compact` loaded, type `/compact` in the conversation to compact immediately.
- **Already-overflowed sessions**: when the history already exceeds the model ceiling, "continue" only retries with longer history and fails again; run `/compact` first (or wait for pressure compaction after lowering the threshold), otherwise start a new session.

## Source Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry: `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`; soft-depends on the host attachment store via `ctx.inject(['attachments'])` (if it is not mounted, images degrade to placeholder text) |
| `src/adapter.ts` | `QoderAdapter`: model listing/resolution/streaming, `prepareCall` generation binding, vision-capability determination and image byte resolution, warm session management, continuation planning, side-channel model pass-through, request input estimation |
| `src/session.ts` | `QoderSession`: inner `query()` subprocess, MCP tool bridge, SDK stream events → harness `StreamChunk`, usage reporting (real input estimation + error classification) |
| `src/models.ts` | Live model catalog fetch (TTL cache, shared concurrency, timeout, static fallback), also carrying the CLI's `isVl` |
| `src/catalog.ts` | Static model table and `deepseek-v4-*` aliases (the static table never advertises vision capability) |
| `src/render.ts` | Host messages → inner feed: plain text, or "text + image reference" parts; identity override |
| `src/jsonschema.ts` | dsh `ToolSchema.parameters` → zod shape (for MCP tool registration) |

## Development & Build

The release artifact of this repository is the **build output committed into the repo**: `lib/index.js` (tsdown bundle) and `lib/types/*.d.ts` (tsc declarations). After changing `src/` you must commit `lib/` together with it, otherwise users installing directly from Git still get the old bundle.

```sh
pnpm install
pnpm run typecheck   # tsc type check over src + tests (vitest does not type-check)
pnpm test            # vitest unit tests
pnpm run build       # tsc emits lib/types/*.d.ts, tsdown bundles lib/index.js
pnpm pack            # produces jiamingzang-dsh-llm-qoder-<version>.tgz
pnpm publish         # prepublishOnly builds first
```

`@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` stay external in `tsdown.config.ts` and are provided by the runtime profile; `@deepseek-ai/dsh-attachment` appears only in devDependencies to provide types (the attachment store instance comes from the host).

> **Why the dependencies are pinned**: the previously used `^0.1.0-rc.5` could never match `0.1.1-rc.x`/`0.1.7-rc.x` because of semver's prerelease tuple rule, so the plugin compiled against an `LlmAdapter` base class without `prepareCall`; `pnpm update` cannot fix it either — the manifest has to be edited explicitly (issue #2). At the same time, dsh's profile installer compares the peer ranges of `@deepseek-ai/dsh-*` against the runtime version, and a too-narrow range makes it refuse the install outright.

## License

[MIT](LICENSE) © 2026 dsh-llm-qodersdk contributors
