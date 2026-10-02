/**
 * QoderSession / QoderSessionManager: warm-session registry eviction, the
 * tool-pairing loop, stream synthesis from SDK events, and turn failure
 * classification. The SDK is mocked with a push-style fake Query so the
 * inner consumer can be driven deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { renderInitialFeed } from '../src/render.ts'
import { textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  QoderSession, QoderSessionManager, classifyTurnError, gateTools, hostToolName,
  estimateImageTokens, renderResultContent, safeErrors,
} from '../src/session.ts'

const { mockQueryFactory, mockMcpServer } = vi.hoisted(() => {
  type ToolHandler = (args: unknown) => Promise<{ content: Array<{ type: 'text', text: string }>, isError?: boolean }>
  const toolHandlers = new Map<string, ToolHandler>()
  const registerTool = vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, handler)
  })
  return {
    mockQueryFactory: vi.fn(),
    mockMcpServer: { instance: { registerTool }, toolHandlers },
  }
})

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({}),
  query: (...args: unknown[]) => mockQueryFactory(...args),
  createSdkMcpServer: () => mockMcpServer,
}))

/** Structural view of one SDK message the consumer handles. */
interface SdkFrame {
  type: string
  subtype?: string
  event?: { type: string, [key: string]: unknown }
  message?: { content?: Array<{ type?: string, text?: string }>, usage?: unknown }
  usage?: unknown
  errors?: unknown
}

/** Push-style async iterable standing in for the SDK Query. */
class FakeQuery {
  private readonly queue: SdkFrame[] = []
  private resolveNext: ((result: IteratorResult<SdkFrame>) => void) | null = null
  private ended = false
  readonly interrupt = vi.fn(async () => undefined)
  readonly close = vi.fn(async () => undefined)
  options: Record<string, unknown> = {}

  push(message: SdkFrame): void {
    if (this.ended) return
    if (this.resolveNext !== null) {
      const settle = this.resolveNext
      this.resolveNext = null
      settle({ value: message, done: false })
    } else {
      this.queue.push(message)
    }
  }

  end(): void {
    this.ended = true
    if (this.resolveNext !== null) {
      const settle = this.resolveNext
      this.resolveNext = null
      settle({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkFrame> {
    return {
      next: (): Promise<IteratorResult<SdkFrame>> => {
        const message = this.queue.shift()
        if (message !== undefined) return Promise.resolve({ value: message, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => { this.resolveNext = resolve })
      },
    }
  }
}

function makeSession(initialModel = 'dmodel'): { session: QoderSession, q: FakeQuery } {
  const q = new FakeQuery()
  mockQueryFactory.mockImplementation((args: { options?: Record<string, unknown> }) => {
    q.options = args.options ?? {}
    return q
  })
  const session = new QoderSession('s1', initialModel)
  return { session, q }
}

function startStream(session: QoderSession, feed: string | null = null, signal?: AbortSignal) {
  const generator = session.stream(
    { ...(signal === undefined ? {} : { signal }) } as GenerateOptions,
    feed,
  )
  return {
    generator,
    all: async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    },
  }
}

function event(type: string, extra: Record<string, unknown> = {}): SdkFrame {
  return { type: 'stream_event', event: { type, ...extra } }
}

function textDelta(text: string): SdkFrame {
  return event('content_block_delta', { delta: { type: 'text_delta', text } })
}

function toolUseStart(id: string, name: string, input: unknown): SdkFrame {
  return event('content_block_start', { content_block: { type: 'tool_use', id, name, input } })
}

function toolUseDelta(partialJson: string): SdkFrame {
  return event('content_block_delta', { delta: { type: 'input_json_delta', partial_json: partialJson } })
}

function toolUseStop(): SdkFrame {
  return event('content_block_stop')
}

function resultFrame(subtype: string | undefined, extra: Record<string, unknown> = {}): SdkFrame {
  return { type: 'result', ...(subtype === undefined ? {} : { subtype }), ...extra }
}

function toolResultMessage(callId: string, text: string): Message {
  return {
    id: MessageId('m1'),
    role: 'tool',
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
  }
}

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png', bytes: 3, width: 40, height: 30,
  }
}


function userMessage(text: string): Message {
  return { id: MessageId('m1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

beforeEach(() => {
  mockQueryFactory.mockReset()
  mockMcpServer.instance.registerTool.mockClear()
  mockMcpServer.toolHandlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hostToolName', () => {
  it('strips the MCP prefix', () => {
    expect(hostToolName('mcp__dsh-host__read_file')).toBe('read_file')
  })

  it('keeps bare names unchanged', () => {
    expect(hostToolName('read_file')).toBe('read_file')
  })
})

describe('gateTools', () => {
  it('allows MCP-prefixed tools with the echo', async () => {
    const verdict = await gateTools('mcp__dsh-host__read_file', {}, { toolUseID: 'tu1' })
    expect(verdict).toEqual({ behavior: 'allow', toolUseID: 'tu1' })
  })

  it('denies native tools with a message', async () => {
    const verdict = await gateTools('bash', {}, {})
    expect(verdict).toMatchObject({ behavior: 'deny' })
    expect((verdict as { message: string }).message).toContain('不直接执行工具')
  })
})

describe('safeErrors', () => {
  it('renders undefined as empty', () => {
    expect(safeErrors(undefined)).toBe('')
  })

  it('passes strings through', () => {
    expect(safeErrors('boom')).toBe('boom')
  })

  it('stringifies structured payloads', () => {
    expect(safeErrors({ code: 'E1', at: 'x' })).toBe('{"code":"E1","at":"x"}')
  })

  it('survives circular payloads', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(safeErrors(circular)).toBe('[object Object]')
  })
})

describe('classifyTurnError', () => {
  it('maps context-overflow wording to the harness code', () => {
    expect(classifyTurnError('error maximum context length exceeded')).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(classifyTurnError('error input is too long for this model')).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })

  it('maps quota wording to the harness code', () => {
    expect(classifyTurnError('error insufficient quota')).toBe(QUOTA_EXCEEDED_CODE)
    expect(classifyTurnError('error quota exceeded')).toBe(QUOTA_EXCEEDED_CODE)
  })

  it('falls back to the generic turn error', () => {
    expect(classifyTurnError('error something unrelated')).toBe('BACKEND_TURN_ERROR')
  })
})

describe('estimateImageTokens', () => {
  it('prices a forwarded image by its tile area', () => {
    expect(estimateImageTokens(1500, 1000)).toBe(2000)
    expect(estimateImageTokens(40, 30)).toBe(2)
  })

  it('keeps a floor of one token for unknown dimensions', () => {
    expect(estimateImageTokens(0, 512)).toBe(1)
    expect(estimateImageTokens(Number.NaN, 512)).toBe(1)
  })
})

describe('renderResultContent', () => {
  it('keeps each text block as its own MCP content entry', () => {
    expect(renderResultContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))
      .toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })

  it('renders an unresolved image as the harness handle text', () => {
    expect(renderResultContent([{ type: 'image', attachment: imageRef('a1') } as ContentBlock]))
      .toEqual([{ type: 'text', text: textOnlyImageText(imageRef('a1') as never) }])
  })

  it('emits MCP image content for adapter-resolved bytes', () => {
    const images = new Map([['a1', { data: 'QUJD', mediaType: 'image/png' }]])
    expect(renderResultContent([{ type: 'image', attachment: imageRef('a1') } as ContentBlock], images))
      .toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }])
  })

  it('serializes other blocks as JSON text', () => {
    expect(renderResultContent([{ type: 'reasoning', text: 'think' }]))
      .toEqual([{ type: 'text', text: '{"type":"reasoning","text":"think"}' }])
  })
})

describe('QoderSessionManager', () => {
  it('reuses the warm session per host id', () => {
    const manager = new QoderSessionManager(8)
    const first = manager.forSession('a', 'dmodel')
    expect(manager.forSession('a', 'dmodel')).toBe(first)
  })

  it('refreshes LRU order on reuse', () => {
    const manager = new QoderSessionManager(2)
    const x = manager.forSession('x', 'dmodel')
    manager.forSession('y', 'dmodel')
    manager.forSession('x', 'dmodel')
    manager.forSession('z', 'dmodel')
    expect(manager.forSession('x', 'dmodel')).toBe(x)
  })

  it('evicts the oldest session past maxSessions', () => {
    const manager = new QoderSessionManager(1)
    const a = manager.forSession('a', 'dmodel')
    manager.forSession('b', 'dmodel')
    expect(manager.forSession('a', 'dmodel')).not.toBe(a)
  })

  it('dispose drops one session and is idempotent', () => {
    const manager = new QoderSessionManager(8)
    const a = manager.forSession('a', 'dmodel')
    manager.dispose('a')
    expect(manager.forSession('a', 'dmodel')).not.toBe(a)
    manager.dispose('missing')
    manager.dispose('a')
  })

  it('closeAll closes every warm session', () => {
    const manager = new QoderSessionManager(8)
    manager.forSession('a', 'dmodel')
    manager.forSession('b', 'dmodel')
    manager.closeAll()
    manager.dispose('a')
  })
})

describe('QoderSession.stream synthesis', () => {
  it('streams text deltas and a stop finish from partial events', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(textDelta('hel'))
    q.push(textDelta('lo'))
    q.push(resultFrame('success'))
    const chunks = await pending
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams tool calls with the host name and a tool-calls finish', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(toolUseStart('tu1', 'mcp__dsh-host__read_file', undefined))
    q.push(toolUseDelta('{"path":"/x"}'))
    q.push(toolUseStop())
    q.push(resultFrame('success'))
    const chunks = await pending
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    const callId = (chunks[1] as Extract<StreamChunk, { type: 'tool-call-delta' }>).id
    expect(String(callId)).toMatch(/^qoder-[0-9a-f]{8}-1$/)
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', id: callId, name: 'read_file', argumentsDelta: '' })
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', argumentsDelta: '{"path":"/x"}' })
    expect(chunks[3]).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"/x"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('seeds tool arguments from a complete start input', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(toolUseStart('tu1', 'mcp__dsh-host__read_file', { path: '/x' }))
    q.push(toolUseStop())
    q.push(resultFrame('success'))
    const chunks = await pending
    const ended = chunks.find(chunk => chunk.type === 'block-end')
    const callId = (chunks.find(chunk => chunk.type === 'tool-call-delta') as
      Extract<StreamChunk, { type: 'tool-call-delta' }>).id
    expect(String(callId)).toMatch(/^qoder-[0-9a-f]{8}-1$/)
    expect(ended).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"/x"}' },
    })
  })

  it('reports the empty-response error', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(resultFrame('success'))
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } } })
  })

  it('classifies context-window failures from the result frame', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(resultFrame('error', { errors: 'maximum context length exceeded' }))
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } } })
  })

  it('classifies quota failures from the result frame', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(resultFrame('error', { errors: 'insufficient quota' }))
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE } } })
  })

  it('aborts the inner process on the host signal', async () => {
    const { session, q } = makeSession()
    const controller = new AbortController()
    const generator = session.stream({ signal: controller.signal } as GenerateOptions, null)
    const p1 = generator.next()
    q.push(textDelta('partial'))
    await p1
    controller.abort()
    expect(q.interrupt).toHaveBeenCalledTimes(1)
    q.push(resultFrame('success'))
    const rest: StreamChunk[] = []
    for await (const chunk of generator) rest.push(chunk)
    expect(rest.at(-1)).toEqual({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'qoder turn aborted by host', code: 'ABORTED' } } })
  })

  it('rejects a second stream while one is in flight', async () => {
    const { session, q } = makeSession()
    const first = session.stream({} as GenerateOptions, null)
    const p1 = first.next()
    const second = session.stream({} as GenerateOptions, null)
    await expect(second.next()).rejects.toMatchObject({ code: 'CONFLICT' })
    q.push(resultFrame('success'))
    await p1
  })

  it('rejects a stream after close', async () => {
    const { session } = makeSession()
    session.close()
    const generator = session.stream({} as GenerateOptions, null)
    await expect(generator.next()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('feeds the channel and reports the estimated usage', async () => {
    const { session, q } = makeSession()
    session.recordRequestInput('sys', [])
    const expected = Math.max(1, Math.ceil(renderInitialFeed('sys', []).length / 4))
    const stream = startStream(session, 'hi')
    const pending = stream.all()
    q.push(textDelta('yo'))
    q.push(resultFrame('success'))
    const chunks = await pending
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toMatchObject({ usage: { inputTokens: expected, outputTokens: 1 } })
  })

  it('passes the host session cwd to qodercli when set before spawn', async () => {
    const { session, q } = makeSession()
    session.setCwd('/home/zzzjm/新建文件夹')
    const stream = startStream(session)
    const pending = stream.all()
    q.push(textDelta('hi'))
    q.push(resultFrame('success'))
    await pending
    expect(q.options.cwd).toBe('/home/zzzjm/新建文件夹')
  })

  it('omits cwd from the qodercli options when the host session has none', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pending = stream.all()
    q.push(textDelta('hi'))
    q.push(resultFrame('success'))
    await pending
    expect(q.options.cwd).toBeUndefined()
  })
})

describe('QoderSession tool pairing', () => {
  const schema = { name: 'read_file', description: '', parameters: { type: 'object' as const, properties: {} } }

  it('registers host tools once and re-registers only changed schemas', () => {
    const { session } = makeSession()
    session.ensureTools([schema])
    session.ensureTools([schema])
    expect(mockMcpServer.instance.registerTool).toHaveBeenCalledTimes(1)
    session.ensureTools([{ ...schema, parameters: { type: 'object' as const, properties: { p: { type: 'string' as const } } } }])
    expect(mockMcpServer.instance.registerTool).toHaveBeenCalledTimes(2)
  })

  it('keeps the old tool when re-registration fails', () => {
    const { session } = makeSession()
    mockMcpServer.instance.registerTool.mockImplementationOnce(() => { throw new Error('conflict') })
    session.ensureTools([schema])
    session.ensureTools([schema])
    expect(mockMcpServer.instance.registerTool).toHaveBeenCalledTimes(2)
  })

  it('delivers tool results to parked handlers by tool-use id', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pendingStream = stream.all()
    session.ensureTools([schema])
    const canUseTool = q.options.canUseTool as (name: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>
    const verdict = await canUseTool('mcp__dsh-host__read_file', {}, { toolUseID: 'tu1' })
    expect(verdict).toEqual({ behavior: 'allow', toolUseID: 'tu1' })
    const handler = mockMcpServer.toolHandlers.get('read_file')
    expect(handler).toBeDefined()
    const pending = handler!({})
    session.deliverToolResults([toolResultMessage('tu1', 'ok')])
    await expect(pending).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
    q.push(resultFrame('success'))
    await pendingStream
  })

  it('buffers results that arrive before the handler parks', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pendingStream = stream.all()
    session.ensureTools([schema])
    const canUseTool = q.options.canUseTool as (name: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>
    await canUseTool('mcp__dsh-host__read_file', {}, { toolUseID: 'tu1' })
    session.deliverToolResults([toolResultMessage('tu1', 'ok')])
    const handler = mockMcpServer.toolHandlers.get('read_file')
    await expect(handler!({})).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
    q.push(resultFrame('success'))
    await pendingStream
  })

  it('unsticks parked handlers on a fresh user turn', async () => {
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pendingStream = stream.all()
    session.ensureTools([schema])
    const canUseTool = q.options.canUseTool as (name: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>
    await canUseTool('mcp__dsh-host__read_file', {}, { toolUseID: 'tu1' })
    const handler = mockMcpServer.toolHandlers.get('read_file')
    const pending = handler!({})
    session.deliverToolResults([userMessage('next question')])
    await expect(pending).resolves.toMatchObject({ isError: true })
    q.push(resultFrame('success'))
    await pendingStream
  })

  it('fails parked handlers when the host result times out', async () => {
    vi.useFakeTimers()
    const { session, q } = makeSession()
    const stream = startStream(session)
    const pendingStream = stream.all()
    session.ensureTools([schema])
    const canUseTool = q.options.canUseTool as (name: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>
    await canUseTool('mcp__dsh-host__read_file', {}, { toolUseID: 'tu1' })
    const handler = mockMcpServer.toolHandlers.get('read_file')
    const pending = handler!({})
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(pending).resolves.toMatchObject({ isError: true })
    q.push(resultFrame('success'))
    await pendingStream
  })
})

describe('QoderSessionManager.coldStream', () => {
  function makeCold(): { manager: QoderSessionManager, q: FakeQuery } {
    const q = new FakeQuery()
    mockQueryFactory.mockImplementation((args: { options?: Record<string, unknown> }) => {
      q.options = args.options ?? {}
      return q
    })
    return { manager: new QoderSessionManager(), q }
  }

  it('aggregates assistant text into 192-char deltas with a stop finish', async () => {
    const { manager, q } = makeCold()
    const generator = manager.coldStream({} as GenerateOptions, 'prompt')
    const pending = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    })()
    q.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(400) }] } })
    q.push(resultFrame('success'))
    q.end()
    const chunks = await pending
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks.filter(chunk => chunk.type === 'text-delta').length).toBe(3)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(q.close).toHaveBeenCalledTimes(1)
  })

  it('reports side-channel failures without text', async () => {
    const { manager, q } = makeCold()
    const generator = manager.coldStream({} as GenerateOptions, 'prompt')
    const pending = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    })()
    q.push(resultFrame('error', { errors: 'insufficient quota' }))
    q.end()
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE } } })
  })

  it('reports a side-channel failure that followed partial text', async () => {
    const { manager, q } = makeCold()
    const generator = manager.coldStream({} as GenerateOptions, 'prompt')
    const pending = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    })()
    q.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'half a summary' }] } })
    q.push(resultFrame('error_max_turns', { errors: 'maximum context length exceeded' }))
    q.end()
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    })
  })

  it('reports empty side-channel responses', async () => {
    const { manager, q } = makeCold()
    const generator = manager.coldStream({} as GenerateOptions, 'prompt')
    const pending = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    })()
    q.push(resultFrame('success'))
    q.end()
    const chunks = await pending
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } } })
  })

  it('honors the abort signal', async () => {
    const { manager, q } = makeCold()
    const controller = new AbortController()
    const generator = manager.coldStream({ signal: controller.signal } as GenerateOptions, 'prompt')
    const pending = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of generator) chunks.push(chunk)
      return chunks
    })()
    q.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    controller.abort()
    expect(q.interrupt).toHaveBeenCalledTimes(1)
    q.end()
    const chunks = await pending
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } })
  })
})
