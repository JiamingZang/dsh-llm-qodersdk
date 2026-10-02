# dsh-llm-qodersdk

> **中文** | [English](README.en.md)

将 DeepSeek Harness 的 LLM 接缝（`ctx.llm`）路由到本机 **Qoder CLI** 的适配器插件（`@jiamingzang/dsh-llm-qoder`），基于 [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)。

它注册 `qoder` / `qoder-byok` 两个 provider 路由，让 harness 的模型请求复用本机 `qodercli` 的登录态——**无需任何凭据或设置项**。模型与账号自定义模型都从 qodercli 实时拉取。

## 特性

- **无配置接入**：完全复用本机 `qodercli` 登录态，不需要 API key 或 settings 段。
- **双路由**：`qoder` 广告账号内置模型；`qoder-byok` 只广告账号自定义模型（各自独立路由）。
- **长驻会话**：每个宿主 session id 对应一个 warm 内层 `query()` 子进程，对话延续、工具轮次都发生在会话内部；`maxSessions` 上限内按插入序 LRU 淘汰。
- **工具桥接**：宿主工具通过进程内 MCP server（`dsh-host`）暴露给内层模型；qodercli 一次执行一个调用、宿主一次回传整轮结果，二者通过 callId 配对（120s 内未回传则超时取消）。
- **模型目录**：实时从 CLI 拉取可用模型（含账号自定义模型），TTL 缓存 + 并发共享 + 超时保护，失败回退静态目录；另提供 `deepseek-v4-flash` → `dfmodel`、`deepseek-v4-pro` → `dmodel` 别名。
- **思考强度**：`resolveModel` 上报 CLI 的 reasoning efforts 与默认档位，模型选择器可直接切换；所选值随每次请求下发给内层会话。
- **上下文窗口**：`resolveModel` 只上报请求实际使用的窗口（`LlmModelContext` 在当前接缝里只有 `contextWindow` 一个字段），compaction 阈值与上下文环的分母因此和内层真实窗口一致。
- **视觉输入**：模型目录里 CLI 明确标记 `isVl: true` 的模型才广告 `image` modality；这类模型下，本轮新上传的图片与工具结果里的图片会以 base64 转发给内层 CLI。历史图片与文本模型仍走 harness 的占位文本，不会把像素重复计入每次请求。
- **旁路请求**：标题生成、compaction 等 side-channel 请求走冷启动一次性调用，不占用 warm 会话。
- **溢出可恢复**：内层模型因上下文超限失败时（如 `maximum context length ... you requested N tokens`），按 dsh-llm 的 `isContextWindowExceededError` 分类为 `CONTEXT_WINDOW_EXCEEDED` 上报，harness 的溢出自动恢复（配合 `compaction-basic`）可以接管而不是让轮次直接报废。

## 适配原理

这一节说明本插件把 harness 的 LLM 接缝映射到 qodercli 时，**每一层是怎么适配的、为什么这么设计**。

### 1. LLM 接缝适配（`ctx.llm` → qodercli）

harness 通过 `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)` 注册 `QoderAdapter`，实现 harness 的 `LlmAdapter` 契约：

| harness 接缝 | 本插件实现 |
| --- | --- |
| `providerInfo(provider)` | 返回 `qoder`（Qoder CLI）/ `qoder-byok`（Qoder 自定义）的展示名 |
| `listModels(provider)` | 实时拉取 qodercli 模型目录，按 provider 过滤（`qoder` 出内置、`qoder-byok` 出账号自定义 `source === 'user'`） |
| `resolveModel(provider, model)` | 从 live catalog / 静态表解析模型元数据（上下文窗口、思考档位、输出上限） |
| `stream(options)` | 把一次 `GenerateOptions` 转成 qodercli 的 `query()` 调用并流式回传 `StreamChunk` |

适配的核心是 **`stream()` 的分流**：

- **warm 会话路径**（有 `sessionId` 且无 `purpose`）：复用或新建一个内层 `query()` 子进程，增量喂入新消息，工具通过 MCP 往返。
- **side-channel 路径**（无 `sessionId`，或带 `purpose`，如标题生成、compaction 摘要）：走 `coldStream()` 一次性调用，不占 warm 会话。**该路径复用主会话的模型**（`resolveQoderModelId(options.model)`），保证 dsh 记录的调用目标与实际执行的模型一致。

### 2. 会话模型适配

- **一宿主会话对应一 warm qodercli 会话**：`QoderSessionManager` 以宿主 `sessionId` 为键维护 `query()` 子进程，超出 `maxSessions` 按插入序 LRU 淘汰。
- **增量 feed**：宿主每次请求携带完整消息列表，插件通过 `planContinuation` 对比上一次，只把新用户轮次与改写消息渲染成 feed；工具结果不进入 feed（走 MCP）。feed 默认是纯文本，只有本轮带图片且模型广告了 `image` 时才变成"文本 + 图片"块。
- **重建检测**：当宿主 surface 被改写（例如 compaction 折叠了历史）导致消息数变少或结构变化，`planContinuation` 返回 `rebuild: true`，插件 dispose 旧 warm 会话并按新 surface 冷启动。**这保证了 dsh 侧的压缩与 qodercli 内部缓存不会产生双份状态**。
- **模型切换**：`setModel` 把 `reasoningEffort` 作为 model-policy 参数传给内层会话。当前接缝的 `GenerateOptions` 不带 per-request 窗口，内层会话因此始终运行在 CLI 自己的默认窗口上，与 `resolveModel` 上报的值同源。

### 3. 工具桥接适配（MCP）

宿主工具不直接发给 qodercli，而是通过**进程内 MCP server**（`dsh-host`）：

1. `ensureTools()` 把宿主 `ToolSchema` 转成 zod shape 注册到 MCP server；
2. qodercli 的 `canUseTool` 允许 `mcp__dsh-host__*` 前缀的工具，并记录 tool-use id；
3. MCP handler **park** 在一个 promise 上，等待宿主在下一轮请求里 `deliverToolResults()` 回传结果；
4. 结果按 `callId ↔ toolUseId` 配对投递；超时（`TOOL_RESULT_TIMEOUT_MS`）则返回错误让 qodercli 恢复。

这样宿主工具调用是**宿主侧的普通工具轮次**，qodercli 只看到 MCP 工具被"执行了一次"。

### 4. 模型目录适配

- **实时目录**：`QoderModelCatalog` 向 qodercli 发 `get_models` 控制请求，TTL 缓存（默认 300s）、并发共享、超时回退静态表。
- **静态回退**：`QODER_MODELS` 内置捕获的模型表（含 `deepseek-v4-flash` / `deepseek-v4-pro` 别名），CLI 不可达时使用。
- **provider 分组**：`listModels` 按 `source` 字段分流——内置模型进 `qoder`，账号自定义模型（`source === 'user'`）进 `qoder-byok`，无需任何手动配置，全部从 qodercli 实时拉取。

### 5. 上下文窗口与压缩阈值的适配

qodercli 的 live catalog 对每个模型同时上报**上限**与**实际窗口**：

```
maxInputTokens: 1000000          ← 模型上限（1M）
availableContextWindows: [200000, 400000, 1000000]
defaultContextWindow: 200000     ← 请求实际使用的窗口
```

harness 的 compaction 引擎用 `resolveModel().context.contextWindow` 计算自动压缩阈值（`thresholdTokens = 0.8 × contextWindow`，compaction-basic 默认 `thresholdRatio: 0.8`），UI 上下文环也以它为分母。因此 `contextWindow` 必须反映**请求实际使用的窗口**，而不是模型上限：

```ts
contextWindow: live.defaultContextWindow ?? live.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW
```

- 取 `defaultContextWindow`（实际窗口，如 200K）→ 阈值 = 160K，与 provider 真实能力对齐；
- 若误用上限，阈值会被放大（如 800K），压缩永远不会在 provider 拒绝前触发；
- 当前接缝的 `LlmModelContext` 只有 `contextWindow` 一个字段，CLI 的可选档位不再随元数据下发（选择器无法切换窗口，只能由 CLI 自己决定）。

### 4.5 派发代次的绑定（`prepareCall`）

harness 先 `prepareCall(provider, model, signal)` 绑定"这一次调用的模型元数据"，再在稍后派发流式请求（`dsh-agent-loop` 用的就是这条路径）。插件覆写它，把解析结果与由它推导出的能力（是否视觉模型）一起钉在同一代次上：即使 CLI 目录或登录态在 prepare 与 stream 之间发生变化，这一轮也不会把"上一代的能力"接到"下一代的端点"上。

**这也是 `registration.adapter.prepareCall is not a function` 的根治点**：该方法是 dsh-llm 0.1.1-rc.2 起 `LlmAdapter` 基类新增的具体方法，插件必须编译/安装在一个含该方法的 dsh-llm 上，否则运行时会直接炸（见 issue #2）。

### 6. 上下文占用计量的适配

qodercli 的流事件 `usage` 帧（`input_tokens` / `output_tokens`）默认全零（无 metering 数据），因此无法直接上报真实用量。harness 的 `contextPressure` 投影以最近一次请求的 `inputTokens` 为分子（`pressureTokens`）驱动 UI 环与压缩判断。

适配方式：**在插件侧按 harness 前端 token-meter 相同的口径估算每次请求的输入**。

`adapter.stream()` 每次请求调用 `session.recordRequestInput(system, messages)`，用 `renderInitialFeed(system, messages)` 渲染完整会话（系统提示 + 全部消息），按 `rendered.length / 4` 估算 token —— 与 harness `estimate.ts` 的 `CHARS_PER_TOKEN = 4` 同口径。`usage()` 优先返回该估算值：

```ts
if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
  return { inputTokens: this.estimatedInputTokens, ... }
}
```

这样 UI 上下文环、自动压缩阈值与插件上报值**使用同一套估算口径**，占用显示与压缩行为一致，不会出现"UI 显示 2% 而实际已接近上限"的割裂。

### 7. 错误分类适配

qodercli 把上下文超限、配额不足等拒绝统一报成 generic per-turn error（`error_during_execution`）。harness 的 overflow recovery 依赖错误码 `CONTEXT_WINDOW_EXCEEDED` 才会触发（prune + compact + retry）。因此插件用 dsh-llm 的共享分类器把 qodercli 的报错文本映射成 harness 可路由的错误码：

```ts
function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}
```

这样 provider 的上下文超限能触发 harness 的自动恢复，配额不足能正确展示，而不是当作普通后端错误死掉。

### 8. 压缩职责分工（dsh vs qoder）

- **压缩由 dsh（harness compaction-basic）执行**：决定压缩范围、保留比例（默认 `retainRatio: 0.16` 保留最近 16%）、调用 LLM 生成 checkpoint、改写会话 surface。
- **qoder 插件只充当 LLM 后端**：把 dsh 的消息喂给 qodercli、取回回复。压缩摘要请求通过 side-channel 走 `coldStream()`，并复用主会话模型（见第 1 节），保证 dsh 记录的摘要目标与实际执行一致。
- **无冲突保证**：dsh 压缩改写 surface 后，插件 `planContinuation` 检测到消息结构变化（`rebuild: true`），主动重建 warm 会话。qodercli 内部缓存随 dsh 压缩被作废，**不存在"两边各压一遍"**。
- 摘要生成默认走主会话路由；需要绕开特定 provider 配额时，可在 `cordis.patch.yml` 给 compaction-basic 配置 `summarizationProvider` / `summarizationModel` 指向其它有额度的模型。

## 兼容性

| dsh 运行时 | 是否可用 | 说明 |
| --- | --- | --- |
| `0.1.7-rc.1` ~ `0.2.x` | ✅ | 本仓库编译并测试在这一代接缝上（`@deepseek-ai/dsh-llm` 的 `RequestMessage` / `role: 'tool'` 工具结果 / `ToolCallId` / `prepareCall`） |
| `0.1.1-rc.2` ~ `0.1.2-rc.1` | ❌ | 工具结果还是 `tool-result` 内容块、品牌函数还叫 `CallId`，且 `GenerateOptions` 里没有 `contextWindow`；类型与运行时都不匹配 |
| `0.1.0-rc.x` | ❌ | 该基类没有 `prepareCall`，选中 qoder 路由后一发消息就报 `registration.adapter.prepareCall is not a function`（issue #2） |

peer 范围写死为 `^0.1.7-rc.1 || ^0.2.0-rc.1`，不用 `^0.1.0-rc.5` 这类跨元组写法：npm 的 semver 对 prerelease 只在同 `[major,minor,patch]` 元组内匹配，旧范围既匹配不到修复版，也会被 dsh 的 profile 安装器判定为与运行时不兼容而拒绝安装。

## 安装

前置条件：本机已安装并登录 qodercli（`qodercli --version` 可运行）。插件完全复用 qodercli 登录态，不需要 API key 或 settings 段。

### 渠道一：Git 直装（无需本地构建）

```sh
dsh plugin --profile <profile> add git+https://github.com/JiamingZang/dsh-llm-qodersdk.git
```

仓库里**已提交构建产物** `lib/index.js` 与 `lib/types/*.d.ts`，所以这条路径不需要 pnpm 运行插件自己的 `prepare` 脚本（在新 pnpm 上，未批准的 `prepare` 是硬失败 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，而不是安静跳过）。

安装时如果看到 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @qoder-ai/qoder-agent-sdk`，**可以先不管**：发布版 SDK 的默认 runtime 是 Worker，它的 postinstall 本来就不下载 `qodercli` 二进制（见 `scripts/postinstall.cjs`），实测"跳过构建脚本"后插件仍能正常加载并发起内层会话。需要下面任一情况时才批准：

- 你的环境跑不了 Worker runtime，需要进程内 CLI fallback：把 profile `~/.dsh/profiles/<profile>/pnpm-workspace.yaml` 里 `allowBuilds` 对应键改成 `true` 重跑 add（或在 dsh Web 界面的构建审批里确认），等价于 `QODER_INSTALL_BUNDLED_CLI=1`；
- 你想用本机已有的 `qodercli`：不用批准，直接设 `QODERCLI_PATH`。

真正的前置条件只有一个：**本机 `qodercli` 已登录**。未登录时插件会正常注册、正常发请求，轮次以错误结束并回传 `No qodercli login found. Run "qodercli login" first.`

### 渠道二：本地包（tgz / 目录）

```sh
dsh plugin --profile <profile> add ./jiamingzang-dsh-llm-qoder-<version>.tgz
```

`pnpm pack` 产出的包已含 `lib/`，安装流程与渠道一相同（构建脚本非必需，见上）。

### 渠道三：npm

`@jiamingzang/dsh-llm-qoder` 目前尚未发布到 npm（`npm view` 返回 404）。发布后 `dsh plugin add @jiamingzang/dsh-llm-qoder` 即为最省事的路径；在此之前请用上面两个渠道之一。

### 验证与手动挂载

- 验证：`dsh --profile <profile> --dump-config | grep llm-qoder` 应出现插件条目；服务启动后模型选择器出现 `Qoder CLI` / `Qoder 自定义` 两个分组（首次启动 >10s 属正常）。
- 不经过 plugin 命令时，可在 cordis.yml 或 patch 层直接声明（插件 package.json 也声明了 `dsh.bundle`，plugin add 后会自动进 profile 的 bundles）：

```yaml
- id: llm-qoder
  name: '@jiamingzang/dsh-llm-qoder'
```

### 使用与排障

- 在对话框模型选择器或 Models 设置页选择 `Qoder CLI`（账号内置）或 `Qoder 自定义`（账号自定义）下的模型；思考档位可在模型面板切换。
- **看不到自定义模型**：多为 qodercli 自动升级窗口期或账号配额用尽（服务端把模型标 `isEnabled: false`）导致 live 目录拉取失败，插件回退静态目录。拉取失败不缓存，CLI 恢复后自动回来，无需重启服务。
- **图片发过去模型看不到**：只有 live catalog 标记 `isVl: true` 的模型会广告图像输入；其余模型下宿主会把图片投影成占位文本，插件不会伪造视觉能力。
- **轮次直接报错结束**：先看是否为 `No qodercli login found`——内层复用本机 qodercli 登录态，未登录时插件本身注册与目录都正常，只有请求会失败。

## 配置

配置项就是插件 profile 条目的 `Config`（设置页由 dsh-settings 直接投影该 schema，插件不再自己注册命名空间）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxSessions` | number | `8` | 同时保持 warm 的内层 qodercli 会话上限（超出按插入序 LRU 淘汰） |
| `modelCacheTtlSeconds` | number | `300` | CLI 模型目录的缓存保鲜秒数 |

改配置后由 profile 载入器重新 `apply()`：新适配器接管路由，旧适配器的 warm 会话随 effect 关闭。

## 上下文管理与压缩

warm 内层会话会累积整段宿主历史：首轮喂入全量历史（`renderInitialFeed`），之后每轮只喂增量（新用户消息、原位刷新）。内层上下文因此随对话增长，模型有硬上限（如 1048576 tokens）。

- **溢出自动恢复**：内层模型报上下文超限时，插件上报 `CONTEXT_WINDOW_EXCEEDED`。harness 的溢出恢复（`dsh-compaction-basic` 的 `agent/request-error` 处理器）会压缩宿主历史并重试；压缩后宿主历史变短，下个请求插件检测到历史回退，自动重建内层会话、冷喂压缩后的历史。
- **前提**：部署里必须加载 `dsh-compaction-basic`（`auto` 默认 `true`）和 `dsh-token-meter`。没装压缩插件时，超限轮次仍会失败——只能新开会话或手动压缩。
- **建议把压力阈值调低**：默认 `thresholdRatio` 0.8 × 模型 contextWindow（1048576 → 约 838k）可能偏晚，尤其宿主侧 token 估算与内层真实用量有偏差时。建议调低到 0.6，让压力压缩远早于溢出触发：

  ```yaml
  - id: compaction-basic
    config:
      auto: true
      thresholdRatio: 0.6
      retainRatio: 0.16
  ```

  也可用 `modelPolicies` 给 `qoder` 路由单独配置。
- **手动压缩**：加载 `dsh-command-compact` 后，对话中输入 `/compact` 立即压缩一次。
- **已超限的会话**：历史已经超过模型上限时，"继续"只会带着更长历史重试失败；先 `/compact` 压缩（或调低阈值后等压力压缩触发），否则新开会话。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：`ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`；用 `ctx.inject(['attachments'])` 软依赖宿主附件存储（未挂载则图片降级为占位文本） |
| `src/adapter.ts` | `QoderAdapter`：模型列表/解析/流式生成、`prepareCall` 代次绑定、视觉能力判定与图片字节解析、warm 会话管理、续轮规划、side-channel 模型传递、请求输入估算 |
| `src/session.ts` | `QoderSession`：内层 `query()` 子进程、MCP 工具桥、SDK 流事件 → harness `StreamChunk`、usage 上报（真实输入估算 + 错误分类） |
| `src/models.ts` | 实时模型目录拉取（TTL 缓存、并发共享、超时、静态回退），并带出 CLI 的 `isVl` |
| `src/catalog.ts` | 静态模型表与 `deepseek-v4-*` 别名（静态表一律不广告视觉能力） |
| `src/render.ts` | 宿主消息 → 内层 feed：纯文本或"文本 + 图片引用"部分；身份覆盖 |
| `src/jsonschema.ts` | dsh `ToolSchema.parameters` → zod shape（MCP 工具注册用） |

## 开发与构建

本仓库的发布物是**入库的构建产物**：`lib/index.js`（tsdown 打包）与 `lib/types/*.d.ts`（tsc 声明）。改完 `src/` 必须连同 `lib/` 一起提交，否则 Git 直装的用户拿到的仍是旧 bundle。

```sh
pnpm install
pnpm run typecheck   # tsc 类型检查 src + tests（vitest 不做类型检查）
pnpm test            # vitest 单元测试
pnpm run build       # tsc 产出 lib/types/*.d.ts，tsdown 产出 lib/index.js
pnpm pack            # 生成 jiamingzang-dsh-llm-qoder-<version>.tgz
pnpm publish         # prepublishOnly 自动先构建
```

`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 在 `tsdown.config.ts` 里保持 external，由运行时 profile 提供；`@deepseek-ai/dsh-attachment` 只在 devDependencies 里提供类型（附件存储的实例来自宿主）。

> **为什么依赖要钉死**：曾用的 `^0.1.0-rc.5` 因 semver 的 prerelease 元组规则永远匹配不到 `0.1.1-rc.x`/`0.1.7-rc.x`，插件会编译进一个没有 `prepareCall` 的 `LlmAdapter` 基类；`pnpm update` 也修不出来，只能显式改 manifest（issue #2）。同时 dsh 的 profile 安装器会把 `@deepseek-ai/dsh-*` 的 peer 范围与运行时版本比对，范围过窄会直接拒绝安装。

## License

[MIT](LICENSE) © 2026 dsh-llm-qodersdk contributors
