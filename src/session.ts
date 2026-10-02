/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */

import { randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, ToolCallId,
  isContextWindowExceededError, isQuotaExceededError, textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, ToolSchema, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { createSdkMcpServer, qodercliAuth, query } from '@qoder-ai/qoder-agent-sdk'
import type { CanUseTool, Query } from '@qoder-ai/qoder-agent-sdk'
import { jsonSchemaToShape } from './jsonschema.ts'
import { feedImageRefs, feedTextLength, renderInitialFeed } from './render.ts'

/** MCP server name this adapter exposes host tools under. */
export const MCP_SERVER_NAME = 'dsh-host'
/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** How long an MCP tool handler waits for the host tool result before failing the call. */
const TOOL_RESULT_TIMEOUT_MS = 120_000

/**
 * One user-turn content block on the streaming-input channel. Text is the
 * historical shape; image blocks use the SDK's Claude-compatible base64
 * vision shape (`ImageContentBlock`).
 */
export type ChannelContent =
  | { type: 'text', text: string }
  | { type: 'image', source: { type: 'base64', media_type: string, data: string } }

/** One MCP tool-result content block: text, or the MCP image shape. */
export type McpContent =
  | { type: 'text', text: string }
  | { type: 'image', data: string, mimeType: string }

/** A host tool result delivered to a parked or buffered MCP handler. */
export interface ToolResultPayload {
  content: McpContent[]
  isError: boolean
}

/**
 * Request-image bytes resolved by the adapter, keyed by attachment id. An id
 * missing from the map degrades to handle text instead of failing the turn.
 */
export type ResolvedImages = ReadonlyMap<string, { data: string, mediaType: string }>

interface ChannelMessage {
  type: 'user'
  message: { role: 'user', content: ChannelContent[] }
  parent_tool_use_id: null
}

/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel(): AsyncIterable<ChannelMessage> & { push(message: ChannelMessage): void } {
  const queue: ChannelMessage[] = []
  let resolve: ((result: IteratorResult<ChannelMessage>) => void) | null = null
  return {
    push(message: ChannelMessage): void {
      if (resolve !== null) {
        const settle = resolve
        resolve = null
        settle({ value: message, done: false })
      } else {
        queue.push(message)
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ChannelMessage> {
      return {
        next(): Promise<IteratorResult<ChannelMessage>> {
          const message = queue.shift()
          if (message !== undefined) return Promise.resolve({ value: message, done: false })
          return new Promise(settle => { resolve = settle })
        },
      }
    },
  }
}

type QueueItem =
  | { kind: 'chunk', chunk: StreamChunk }
  | { kind: 'turn-end', reason: FinishReason, usage?: TokenUsage }

/** Unbounded FIFO the consumer pushes into and the active turn pumps out. */
class TurnQueue implements AsyncIterable<QueueItem> {
  private readonly items: QueueItem[] = []
  private resolve: ((result: IteratorResult<QueueItem>) => void) | null = null
  private closed = false

  push(item: QueueItem): void {
    if (this.closed) return
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QueueItem> {
    return {
      next: (): Promise<IteratorResult<QueueItem>> => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(settle => { this.resolve = settle })
      },
    }
  }

  /** Whether the turn already ended; late pushes are dropped. */
  get isClosed(): boolean {
    return this.closed
  }
}

interface ParkedResolver { (result: ToolResultPayload): void }

/** One tool-use block under assembly in the active turn. */
interface ToolUnderAssembly {
  chunkIndex: number
  callId: string
  name: string
  arguments: string
}

/** Structural view of the SDK usage this consumer forwards to the harness. */
interface SdkUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Structural view of the SDK stream events this consumer cares about. */
interface SdkStreamEvent {
  type: string
  content_block?: { type?: string, id?: string, name?: string, input?: unknown }
  delta?: { type?: string, text?: string, thinking?: string, partial_json?: string }
  usage?: SdkUsage
  message?: { content?: unknown, usage?: SdkUsage }
}

/** Structural view of the SDK messages this consumer cares about. */
interface SdkMessage {
  type: string
  subtype?: string
  event?: SdkStreamEvent
  message?: { content?: Array<{ type?: string, text?: string }>, usage?: SdkUsage }
  usage?: SdkUsage
  errors?: unknown
}

/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip the prefix on the way out.
 */
export function hostToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
}

/** Deny native tools, allow this adapter's MCP tools. */
export async function gateTools(toolName: string, _input: unknown, options: { toolUseID?: string }): Promise<unknown> {
  const echo = options.toolUseID !== undefined ? { toolUseID: options.toolUseID } : {}
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return { behavior: 'allow', ...echo }
  return {
    behavior: 'deny',
    message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
    ...echo,
  }
}

/** The SDK permission callback shape this adapter implements per session. */
type SessionCanUseTool = (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>

/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export class QoderSession {
  private readonly channel = createChannel()
  /**
   * Lazy: the MCP SDK refuses tool registration after the transport connects,
   * so the inner process only spawns once {@link ensureTools} has registered
   * the host tools (the adapter does that immediately before each stream).
   */
  private q: Query | null = null
  /**
   * Tool-call pairing state. qodercli asks `canUseTool` (with the qodercli
   * tool-use id) once per call in execution order, then sends the MCP message;
   * the host sees tool calls as content blocks and delivers all results up
   * front on the next request. Tool-use ids therefore arrive in the handler in
   * canUseTool order, and host callIds map back to them via the content-block
   * ids — so handlers park under the exact tool-use id, never a shifted FIFO
   * slot. Results buffer by tool-use id until their handler fires.
   */
  private readonly parked = new Map<string, ParkedResolver>()
  private readonly pendingResults = new Map<string, ToolResultPayload>()
  /** qodercli tool-use ids in canUseTool (execution) order, claimed by MCP handlers. */
  private readonly toolUseQueue: string[] = []
  /** Host callId (qoder-N) → qodercli tool-use id, from the content-block ids. */
  private readonly hostCallByToolUse = new Map<string, string>()
  private readonly mcp = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: [] })
  private readonly registered = new Map<string, string>()
  private queue: TurnQueue | null = null
  private model: string
  private reasoningEffort: string | undefined
  private callCounter = 0
  /**
   * Per-instance suffix for emitted host call ids. Ids must stay unique across
   * the whole host session log: a history divergence rebuilds this class, LRU
   * eviction recreates it, and the harness keys tool-call blocks by id, so a
   * fresh `qoder-1` would collide with the one its predecessor already stored.
   */
  private readonly callNonce = randomUUID().slice(0, 8)
  private abortPending = false
  private disposed = false
  /** Previous request's messages for delta feeding. */
  fedMessages: readonly RequestMessage[] | undefined
  fedSystem: string | undefined
  /** This turn's fed characters, reset per turn for per-call token accounting. */
  turnInputChars = 0
  /** Host system prompt captured before spawn for the boot-time systemPrompt. */
  private hostSystem: string | undefined
  /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
  private sessionCwd: string | undefined

  // Active-turn assembly state, touched only by the consumer fiber.
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private openTool: ToolUnderAssembly | undefined
  private toolCalls: ToolUnderAssembly[] = []
  private outputChars = 0
  private reasoningChars = 0
  /** Last real usage reported by the inner model for the active turn. */
  private lastUsage: SdkUsage | undefined
  /**
   * Session-level input token estimate for the CURRENT request, priced the
   * same way the harness token meter prices the surface (4 chars per token
   * on the rendered conversation the inner session actually receives). The
   * qoder CLI zeroes its per-stream usage frames, so without this the harness
   * context meter would read ~0% and auto-compaction would never trigger.
   */
  private estimatedInputTokens: number | undefined

  constructor(readonly sessionId: string, initialModel: string) {
    this.model = initialModel
  }

  /** Spawn the inner process (first stream only) and attach the consumer. */
  private ensureStarted(): Query {
    if (this.q !== null) return this.q
    const q = query({
      prompt: this.channel,
      options: {
        auth: qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: this.canUseTool as CanUseTool,
        settingSources: [],
        includePartialMessages: true,
        resolveModel: () => ({
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { parameters: { reasoningEffort: this.reasoningEffort } },
        }),
        mcpServers: { [MCP_SERVER_NAME]: this.mcp },
        allowedMcpServerNames: [MCP_SERVER_NAME],
        // Host prompt passes through verbatim: no qodercli preset, so its
        // injected workspace/environment fields never reach the model.
        ...this.hostSystem === undefined ? {} : { systemPrompt: this.hostSystem },
        ...this.sessionCwd === undefined ? {} : { cwd: this.sessionCwd },
      },
    })
    this.q = q
    void this.consume(q)
    return q
  }

  /** Point the session at a model and its per-request policy. */
  setModel(model: string, policy?: { reasoningEffort?: string }): void {
    this.model = model
    this.reasoningEffort = policy?.reasoningEffort
  }

  /** Record the host system prompt; effective only before the process spawns. */
  setSystem(system: string | undefined): void { this.hostSystem = system }

  /**
   * Record the host session workspace; effective only before the process
   * spawns. qodercli inherits the host process cwd otherwise, which would
   * make its preset report the server's launch directory instead of the
   * session's workspace.
   */
  setCwd(cwd: string | undefined): void { this.sessionCwd = cwd }

  /**
   * Permission gate for the inner process. Native tools are denied; MCP host
   * tools are allowed, and each allowed call's qodercli tool-use id is queued
   * so the matching MCP handler can park under the exact id (qodercli asks
   * once per call, in execution order, before sending the MCP message).
   */
  private canUseTool: SessionCanUseTool = (toolName, _input, options) => {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (options.toolUseID !== undefined) this.toolUseQueue.push(options.toolUseID)
      return Promise.resolve({ behavior: 'allow', ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID } })
    }
    return Promise.resolve({
      behavior: 'deny',
      message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
      ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID },
    })
  }

  /** Register any host tools whose schema this session's MCP server lacks. */
  ensureTools(tools: readonly ToolSchema[]): void {
    for (const schema of tools) {
      const hash = JSON.stringify(schema.parameters ?? {})
      if (this.registered.get(schema.name) === hash) continue
      const shape = jsonSchemaToShape(schema.parameters ?? {})
      try {
        this.mcp.instance.registerTool(schema.name, {
          description: schema.description.length > 0 ? schema.description : schema.name,
          inputSchema: shape,
        }, async (args: unknown): Promise<{ content: McpContent[], isError?: boolean }> => {
          void args
          const toolUseId = this.toolUseQueue.shift()
          let result: ToolResultPayload
          if (toolUseId !== undefined && this.pendingResults.has(toolUseId)) {
            result = this.pendingResults.get(toolUseId) as ToolResultPayload
            this.pendingResults.delete(toolUseId)
          } else {
            const key = toolUseId ?? `anon-${this.callCounter}-${this.parked.size}`
            // Bounded park: a tool-use id the host never delivers must not
            // leave the inner process waiting forever. On timeout the call
            // fails with an error so qodercli's loop recovers instead of
            // deadlocking.
            result = await new Promise<ToolResultPayload>(resolve => {
              const timer = setTimeout(() => {
                this.parked.delete(key)
                resolve({
                  content: [{
                    type: 'text',
                    text: `宿主在 ${TOOL_RESULT_TIMEOUT_MS / 1000}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`,
                  }],
                  isError: true,
                })
              }, TOOL_RESULT_TIMEOUT_MS)
              this.parked.set(key, payload => {
                clearTimeout(timer)
                resolve(payload)
              })
            })
          }
          return {
            content: result.content,
            ...result.isError ? { isError: true } : {},
          }
        })
      } catch {
        // Re-registration of a changed schema failed: keep the old tool rather
        // than dropping it; nothing else can recover here.
        continue
      }
      this.registered.set(schema.name, hash)
    }
  }

  /**
   * Deliver host tool results to parked or buffered handlers, keyed by call id.
   * @param tail - the host messages appended since the previous request.
   * @param images - adapter-resolved request images keyed by attachment id; an
   *   id missing from the map degrades to handle text.
   */
  deliverToolResults(tail: readonly RequestMessage[], images?: ResolvedImages): void {
    let freshUserTurn = false
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      const callId = String(message.toolCallId)
      const payload: ToolResultPayload = {
        content: renderResultContent(message.content, images),
        isError: message.isError === true,
      }
      // Key by the qodercli tool-use id the host callId maps to; without a
      // mapping (a call the host never surfaced) fall back to the callId so
      // the entry still buffers for any handler that parked under it.
      const key = this.hostCallByToolUse.get(callId) ?? callId
      const resolve = this.parked.get(key)
      if (resolve !== undefined) {
        this.parked.delete(key)
        resolve(payload)
      } else {
        this.pendingResults.set(key, payload)
      }
    }
    // The host started a new user turn while calls were still parked: unstick
    // the inner process with an explicit cancellation result.
    if (freshUserTurn && this.parked.size > 0) {
      const stale = [...this.parked.entries()]
      this.parked.clear()
      for (const [, resolve] of stale) {
        resolve({ content: [{ type: 'text', text: '[宿主取消了这次工具执行]' }], isError: true })
      }
    }
  }

  /**
   * Run one inner turn: feed (if any) then pump consumer chunks until finish.
   * @param options - the host request (signal; tools already registered).
   * @param feed - literal text, resolved content blocks (a vision turn), or
   *   null for a pure tool-result continuation.
   */
  async *stream(options: GenerateOptions, feed: string | readonly ChannelContent[] | null): AsyncGenerator<StreamChunk> {
    if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, 'CONFLICT')
    if (this.disposed) throw new LlmError(`qoder session ${this.sessionId} was disposed`, 'TRANSPORT')
    const q = this.ensureStarted()
    this.queue = new TurnQueue()
    this.resetTurnState()
    if (feed !== null) {
      const content: ChannelContent[] = typeof feed === 'string' ? [{ type: 'text', text: feed }] : [...feed]
      this.turnInputChars += contentChars(content)
      this.channel.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
    }
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      // interrupt() rides the same transport a teardown may already have killed
      // (a host abort racing process shutdown); its rejection must not surface
      // as an unhandled promise rejection.
      void q.interrupt().catch(() => undefined)
      // Fallback: end the turn if the inner process does not settle promptly.
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'qoder session aborted by host', code: 'ABORTED' } }), 5_000)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        if (item.usage !== undefined) {
          yield { type: 'usage', usage: this.usage() }
        }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      this.queue = null
      this.abortPending = false
    }
  }

  /** Tear the inner process down; parked calls die with it. */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.q !== null) void this.q.close().catch(() => undefined)
  }

  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.openTool = undefined
    this.toolCalls = []
    this.turnInputChars = 0
    this.outputChars = 0
    this.reasoningChars = 0
    // Pairing state is per turn: canUseTool ids are claimed by handlers within
    // the turn, and host callId mappings were consumed by deliverToolResults
    // before this stream started.
    this.toolUseQueue.length = 0
    this.hostCallByToolUse.clear()
    this.lastUsage = undefined
  }

  private emit(chunk: StreamChunk): void { this.queue?.push({ kind: 'chunk', chunk }) }

  private usage(): TokenUsage {
    // The qoder CLI's per-stream usage frames are zeroed by default (no
    // metering data). Prefer our session-level estimate of the actual request
    // input — priced like the harness token meter (4 chars/token over the
    // rendered conversation) — so the harness context meter and compaction
    // thresholds reflect the real occupancy instead of ~0.
    if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
      return {
        inputTokens: this.estimatedInputTokens,
        outputTokens: Math.max(1, Math.ceil((this.outputChars + this.reasoningChars) / 4)),
        ...this.reasoningChars > 0 ? { reasoningTokens: Math.ceil(this.reasoningChars / 4) } : {},
      }
    }
    const real = this.lastUsage
    // The SDK's input_tokens includes cache reads/writes, so subtract them
    // into disjoint buckets, matching the harness TokenUsage convention.
    if (real !== undefined
      && typeof real.input_tokens === 'number'
      && typeof real.output_tokens === 'number'
      && (real.input_tokens > 0 || real.output_tokens > 0)) {
      const cacheRead = typeof real.cache_read_input_tokens === 'number' ? real.cache_read_input_tokens : 0
      const cacheWrite = typeof real.cache_creation_input_tokens === 'number' ? real.cache_creation_input_tokens : 0
      return {
        inputTokens: Math.max(0, real.input_tokens - cacheRead - cacheWrite),
        outputTokens: real.output_tokens,
        ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
        ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
        ...this.reasoningChars > 0 ? { reasoningTokens: Math.ceil(this.reasoningChars / 4) } : {},
      }
    }
    return {
      inputTokens: Math.max(1, Math.ceil(this.turnInputChars / 4)),
      outputTokens: Math.max(1, Math.ceil((this.outputChars + this.reasoningChars) / 4)),
      ...this.reasoningChars > 0 ? { reasoningTokens: Math.ceil(this.reasoningChars / 4) } : {},
    }
  }

  /**
   * Record the input-token estimate for the CURRENT request, priced the same
   * way the harness token meter prices the surface: 4 chars per token over
   * the rendered conversation (system + messages) the inner session receives.
   * @param system - the host system prompt included in this request.
   * @param messages - the full host message list included in this request.
   */
  recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void {
    const rendered = renderInitialFeed(system, messages)
    const imageTokens = feedImageRefs(rendered)
      .reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0)
    this.estimatedInputTokens = Math.max(1, Math.ceil(feedTextLength(rendered) / 4) + imageTokens)
  }

  private endTurn(reason: FinishReason, usage?: TokenUsage): void {
    if (this.queue === null) return
    if (this.textBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.textBlock.index, block: { type: 'text', text: this.textBlock.text } })
    }
    if (this.reasoningBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.reasoningBlock.index, block: { type: 'reasoning', text: this.reasoningBlock.text } })
    }
    this.queue.push({ kind: 'turn-end', reason, usage: usage ?? this.usage() })
    this.queue.close()
  }

  private async consume(q: Query): Promise<void> {
    try {
      const iterator = q[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        try {
          this.handle(next.value as SdkMessage)
        } catch (error) {
          this.endTurn({ kind: 'error', failure: { message: `qoder session consumer failed: ${String(error)}`, code: 'BACKEND_ERROR' } })
        }
      }
      this.endTurn({ kind: 'error', failure: { message: 'qoder session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
    } catch (error) {
      this.endTurn({ kind: 'error', failure: { message: `qoder session died: ${String(error)}`, code: 'TRANSPORT' } })
    }
  }

  private handle(message: SdkMessage): void {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event === undefined) return
      // message_start / message_delta carry the running usage for the step.
      if (event.usage !== undefined) this.lastUsage = event.usage
      else if (event.message?.usage !== undefined) this.lastUsage = event.message.usage
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'tool_use') {
            // Only host-visible tool calls may be emitted: blocks that arrive
            // while no host stream is active can never be delivered, and their
            // canUseTool/handler sequence is paired by tool-use id anyway, so
            // skipping them keeps the host transcript consistent.
            if (this.queue === null || this.queue.isClosed) break
            const callId = `qoder-${this.callNonce}-${++this.callCounter}`
            if (typeof block.id === 'string' && block.id.length > 0) {
              this.hostCallByToolUse.set(callId, block.id)
            }
            const chunkIndex = this.blockIndex++
            this.openTool = {
              chunkIndex,
              callId,
              name: hostToolName(block.name ?? ''),
              arguments: block.input !== undefined && block.input !== null && Object.keys(block.input as object).length > 0
                ? JSON.stringify(block.input)
                : '',
            }
            this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
            this.emit({
              type: 'tool-call-delta',
              index: chunkIndex,
              id: ToolCallId(callId),
              name: this.openTool.name,
              argumentsDelta: '',
            })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta === undefined) return
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            if (this.textBlock === undefined) {
              this.textBlock = { index: this.blockIndex++, text: '' }
              this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
            }
            this.textBlock.text += delta.text
            this.outputChars += delta.text.length
            this.emit({ type: 'text-delta', index: this.textBlock.index, text: delta.text })
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            if (this.reasoningBlock === undefined) {
              this.reasoningBlock = { index: this.blockIndex++, text: '' }
              this.emit({ type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' })
            }
            this.reasoningBlock.text += delta.thinking
            this.reasoningChars += delta.thinking.length
            this.emit({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: delta.thinking })
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && this.openTool !== undefined) {
            this.openTool.arguments += delta.partial_json
            this.emit({
              type: 'tool-call-delta',
              index: this.openTool.chunkIndex,
              id: ToolCallId(this.openTool.callId),
              argumentsDelta: delta.partial_json,
            })
          }
          break
        }
        case 'content_block_stop': {
          if (this.openTool !== undefined) {
            this.emit({
              type: 'block-end',
              index: this.openTool.chunkIndex,
              block: {
                type: 'tool-call',
                id: ToolCallId(this.openTool.callId),
                name: this.openTool.name,
                arguments: this.openTool.arguments,
              },
            })
            this.toolCalls.push(this.openTool)
            this.openTool = undefined
          }
          break
        }
        case 'message_stop': {
          if (this.toolCalls.length > 0) this.endTurn({ kind: 'tool-calls' })
          break
        }
        default: break
      }
      return
    }
    if (message.type === 'assistant') {
      // Fallback turns (no partial events) still carry the real usage.
      if (message.message?.usage !== undefined) this.lastUsage = message.message.usage
      // Fallback for turns that streamed no partial events.
      if (this.textBlock === undefined && this.toolCalls.length === 0) {
        const text = (message.message?.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join('')
        if (text.length > 0) {
          this.textBlock = { index: this.blockIndex++, text }
          this.outputChars += text.length
          this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          this.emit({ type: 'text-delta', index: this.textBlock.index, text })
        }
      }
      return
    }
    if (message.type === 'result') {
      // The result frame carries the authoritative final usage (the stream
      // events' usage is cumulative and often zeroed until the last delta).
      if (message.usage !== undefined) this.lastUsage = message.usage
      if (this.abortPending) {
        this.endTurn({ kind: 'aborted', failure: { message: 'qoder turn aborted by host', code: 'ABORTED' } })
        return
      }
      if (this.toolCalls.length > 0) {
        this.endTurn({ kind: 'tool-calls' })
        return
      }
      if (message.subtype === 'success' || message.subtype === undefined) {
        if (this.textBlock === undefined && this.reasoningBlock === undefined) {
          this.endTurn({
            kind: 'error',
            failure: { message: 'qoder model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          })
        } else {
          this.endTurn({ kind: 'stop' })
        }
        return
      }
      const detail = `${message.subtype} ${safeErrors(message.errors)}`
      this.endTurn({
        kind: 'error',
        failure: { message: `qoder turn failed: ${detail}`, code: classifyTurnError(detail) },
      })
    }
  }
}

/**
 * Render tool-result content blocks into the MCP content the inner model
 * reads: text passes through, an image resolves from {@link images} into the
 * MCP image shape or degrades to the harness's own handle text, and anything
 * else is serialized.
 */
export function renderResultContent(blocks: readonly ContentBlock[], images?: ResolvedImages): McpContent[] {
  const content: McpContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const resolved = images?.get(String(block.attachment.attachmentId))
      if (resolved !== undefined) content.push({ type: 'image', data: resolved.data, mimeType: resolved.mediaType })
      else content.push({ type: 'text', text: textOnlyImageText(block.attachment) })
    } else {
      content.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  return content
}

/**
 * Vision tokens for one image, estimated with the tile formula the
 * Claude-compatible wire shape this backend follows uses (width x height / 750).
 * The inner CLI reports no usage for the pixels it consumed, so this estimate is
 * the only image occupancy the harness context meter and compaction threshold
 * can see. It is an estimate, not a provider metering figure.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.max(1, Math.ceil((width * height) / 750))
}

/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars(content: readonly ChannelContent[]): number {
  return content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
}

/** Safely stringify the SDK error payload for turn diagnostics. */
export function safeErrors(errors: unknown): string {
  if (errors === undefined) return ''
  if (typeof errors === 'string') return errors
  try { return JSON.stringify(errors) } catch { return String(errors) }
}

/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}

/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export class QoderSessionManager {
  private readonly sessions = new Map<string, QoderSession>()

  constructor(readonly maxSessions = 8) {}

  /** Existing or fresh warm session for one host session id. */
  forSession(sessionId: string, model: string): QoderSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const session = new QoderSession(sessionId, model)
    this.sessions.set(sessionId, session)
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      const victim = this.sessions.get(oldest.value)
      this.sessions.delete(oldest.value)
      victim?.close()
    }
    return session
  }

  /** Drop one session (history diverged); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    session.close()
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  /** One-shot turn with no warm state: side channels and cold rebuilds. */
  async *coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk> {
    const q = query({
      prompt,
      options: {
        auth: qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: gateTools as CanUseTool,
        settingSources: [],
        maxTurns: 4,
        ...model === undefined ? {} : { model },
      },
    })
    const signal = options.signal
    const onAbort = (): void => { void q.interrupt().catch(() => undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let text = ''
      let failure: { message: string, code: string } | undefined
      try {
        for await (const message of q) {
          const msg = message as SdkMessage
          if (msg.type === 'assistant') {
            const chunk = (msg.message?.content ?? [])
              .filter(block => block.type === 'text')
              .map(block => block.text ?? '')
              .join('')
            if (chunk.length > 0) text += chunk
          } else if (msg.type === 'result' && msg.subtype !== 'success' && msg.subtype !== undefined) {
            const detail = `${msg.subtype} ${safeErrors(msg.errors)}`
            failure = { message: `qoder side-channel turn failed: ${detail}`, code: classifyTurnError(detail) }
          }
        }
      } catch (error) {
        // Abandoning this loop on a host abort runs the iterator's return(),
        // whose close chain rejects once the child process is already gone;
        // that is the abort, not a transport failure.
        if (signal?.aborted !== true) throw error
      }
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } }
        return
      }
      // A turn that failed after producing partial text is still a failure:
      // reporting it as a stop would hand the harness a truncated summary and
      // swallow the very overflow the caller needs to recover from.
      if (failure !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      if (text.length === 0) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'qoder side-channel returned no content', code: EMPTY_RESPONSE_CODE } },
        }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let i = 0; i < text.length; i += 192) {
        yield { type: 'text-delta', index: 0, text: text.slice(i, i + 192) }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
          outputTokens: Math.max(1, Math.ceil(text.length / 4)),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await q.close().catch(() => undefined)
    }
  }
}
