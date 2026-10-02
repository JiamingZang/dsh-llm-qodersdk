/**
 * Vision forwarding and dispatch-generation binding, with the inner session
 * and the CLI catalog mocked: what the adapter hands the session depends on the
 * route's declared modalities and on the attachment reader, never on a guess.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { QODER_PROVIDER, QoderAdapter } from '../src/adapter.ts'

const { catalog, sessions } = vi.hoisted(() => ({
  catalog: { models: [] as Array<Record<string, unknown>> },
  sessions: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/models.ts', () => ({
  DEFAULT_MODEL_CACHE_TTL_MS: 300_000,
  QoderModelCatalog: class {
    async liveModels() { return catalog.models }
    async models() { return catalog.models.map(entry => ({ id: entry['value'], name: entry['displayName'], ...entry })) }
  },
}))

vi.mock('../src/session.ts', () => {
  class FakeSession {
    readonly calls: Array<{ name: string, args: unknown[] }> = []
    fedMessages: readonly RequestMessage[] | undefined
    fedSystem: string | undefined
    sessionId: string
    constructor(sessionId: string, readonly model: string) {
      this.sessionId = sessionId
      sessions.push(this as unknown as Record<string, unknown>)
    }

    setModel(...args: unknown[]): void { this.record('setModel', args) }
    setSystem(...args: unknown[]): void { this.record('setSystem', args) }
    setCwd(...args: unknown[]): void { this.record('setCwd', args) }
    ensureTools(...args: unknown[]): void { this.record('ensureTools', args) }
    recordRequestInput(...args: unknown[]): void { this.record('recordRequestInput', args) }
    deliverToolResults(...args: unknown[]): void { this.record('deliverToolResults', args) }

    async *stream(options: GenerateOptions, feed: unknown): AsyncGenerator<never> {
      this.record('stream', [options, feed])
      return { done: true, value: undefined } as never
    }

    private record(name: string, args: unknown[]): void { this.calls.push({ name, args }) }

    /** The feed passed to the last stream() call. */
    get feed(): unknown {
      const call = [...this.calls].reverse().find(entry => entry.name === 'stream')
      return (call?.args as [GenerateOptions, unknown])?.[1]
    }
  }

  return {
    QoderSession: FakeSession,
    QoderSessionManager: class {
      private readonly map = new Map<string, FakeSession>()

      forSession(sessionId: string, model: string): FakeSession {
        const existing = this.map.get(sessionId)
        if (existing !== undefined) return existing
        const session = new FakeSession(sessionId, model)
        this.map.set(sessionId, session)
        return session
      }

      dispose(sessionId: string): void { this.map.delete(sessionId) }
      closeAll(): void { this.map.clear() }

      async *coldStream(): AsyncGenerator<never> {
        return { done: true, value: undefined } as never
      }
    },
  }
})

function ref(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png', bytes: 3, width: 40, height: 30,
  }
}

function imageBlock(id: string): ContentBlock {
  return { type: 'image', attachment: ref(id) }
}

function userTurn(content: ContentBlock[]): RequestMessage {
  return {
    id: MessageId('m1'), role: 'user', content, source: { kind: 'user' },
  }
}

function toolResult(callId: string, content: ContentBlock[]): RequestMessage {
  return {
    id: MessageId('t1'), role: 'tool', content,
    source: { kind: 'tool', callId: ToolCallId(callId) }, toolCallId: ToolCallId(callId),
  }
}

interface RequestInput {
        model?: string
        messages?: RequestMessage[]
        purpose?: 'compaction' | 'session-title'
        sessionId?: string
      }

function request(overrides: RequestInput = {}): GenerateOptions {
  const options: GenerateOptions = {
    provider: QODER_PROVIDER,
    model: overrides.model ?? 'vmodel',
    messages: overrides.messages ?? [userTurn([{ type: 'text', text: 'look' }, imageBlock('a1')])],
  }
  if (overrides.sessionId !== undefined) {
    options.sessionId = overrides.sessionId as NonNullable<GenerateOptions['sessionId']>
  } else if (overrides.purpose === undefined) {
    options.sessionId = 'host-session-1' as NonNullable<GenerateOptions['sessionId']>
  }
  if (overrides.purpose !== undefined) options.purpose = overrides.purpose
  return options
}

async function drain(adapter: QoderAdapter, options: GenerateOptions): Promise<void> {
  for await (const _ of adapter.stream(options)) void _
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

beforeEach(() => {
  catalog.models = []
  sessions.length = 0
})

describe('vision capability', () => {
  it('declares image input only on an affirmative CLI isVl flag', async () => {
    catalog.models = [
      { value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true },
      { value: 'tmodel', displayName: 'T', description: '', isEnabled: true, isVl: false },
      { value: 'umodel', displayName: 'U', description: '', isEnabled: true },
    ]
    const adapter = new QoderAdapter()
    expect((await adapter.resolveModel(QODER_PROVIDER, 'vmodel')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel(QODER_PROVIDER, 'tmodel')).inputModalities).toEqual(['text'])
    expect((await adapter.resolveModel(QODER_PROVIDER, 'umodel')).inputModalities).toEqual(['text'])
    const listed = await adapter.listModels(QODER_PROVIDER)
    expect(listed.find(entry => entry.id === 'vmodel')?.inputModalities).toEqual(['text', 'image'])
  })

  it('never claims image input from the static fallback catalog', async () => {
    const adapter = new QoderAdapter()
    expect((await adapter.resolveModel(QODER_PROVIDER, 'auto')).inputModalities).toEqual(['text'])
  })
})

describe('image forwarding', () => {
  it('sends base64 image blocks for a current-turn image on a vision route', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const readImage = vi.fn(async (input: ImageAttachmentRef) => {
      void input
      return { bytes: new Uint8Array([65, 66, 67]), mediaType: 'image/png' }
    })
    const adapter = new QoderAdapter({ readImage })
    await drain(adapter, request())
    const feed = (sessions[0] as { feed: unknown[] }).feed
    expect(feed).toContainEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    })
    expect(feed[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[用户] look') })
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(String(readImage.mock.calls[0]?.[0]?.attachmentId)).toBe('a1')
  })

  it('keeps history images as handle text and forwards only the current turn', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const readImage = vi.fn(async (input: ImageAttachmentRef) => {
      void input
      return { bytes: new Uint8Array([65]), mediaType: 'image/png' }
    })
    const adapter = new QoderAdapter({ readImage })
    const assistant: RequestMessage = {
      id: MessageId('a'), role: 'assistant', content: [{ type: 'text', text: 'seen' }],
      source: { kind: 'model', provider: QODER_PROVIDER, model: 'vmodel' },
    }
    await drain(adapter, request({
      messages: [userTurn([imageBlock('old')]), assistant, userTurn([imageBlock('new')])],
    }))
    const session = sessions[0] as { feed: Array<{ type: string, text?: string }> }
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(String(readImage.mock.calls[0]?.[0]?.attachmentId)).toBe('new')
    expect(session.feed.some(block => block.type === 'text' && block.text?.includes(textOnlyImageText(ref('old'))))).toBe(true)
  })

  it('degrades to handle text when the route is text-only, without reading bytes', async () => {
    catalog.models = [{ value: 'tmodel', displayName: 'T', description: '', isEnabled: true }]
    const readImage = vi.fn(async (input: ImageAttachmentRef) => {
      void input
      return { bytes: new Uint8Array([65]), mediaType: 'image/png' }
    })
    const adapter = new QoderAdapter({ readImage })
    await drain(adapter, request({ model: 'tmodel' }))
    const session = sessions[0] as { feed: unknown }
    expect(typeof session.feed).toBe('string')
    expect(session.feed as string).toContain(`[用户] look\n\n${textOnlyImageText(ref('a1'))}`)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('notes an attachment the host could not read instead of failing the turn', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const adapter = new QoderAdapter({ readImage: async () => undefined })
    await drain(adapter, request())
    const session = sessions[0] as { feed: unknown }
    expect(typeof session.feed).toBe('string')
    expect(session.feed as string).toContain('未能读取')
  })

  it('drops a rejecting attachment read the same way', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const adapter = new QoderAdapter({
      readImage: async () => { throw new Error('object deleted from disk') },
    })
    await drain(adapter, request())
    const session = sessions[0] as { feed: string }
    expect(session.feed).toContain('未能读取')
  })

  it('forwards resolved bytes for images inside tool results', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const adapter = new QoderAdapter({
      readImage: async () => ({ bytes: new Uint8Array([65, 66, 67]), mediaType: 'image/jpeg' }),
    })
    const previous = [userTurn([{ type: 'text', text: 'hi' }])]
    await drain(adapter, request({ messages: previous }))
    const options = request({ messages: [...previous, toolResult('c1', [{ type: 'text', text: 'shot' }, imageBlock('a1')])] })
    await drain(adapter, options)
    const session = sessions[0] as { calls: Array<{ name: string, args: unknown[] }> }
    const deliver = session.calls.find(call => call.name === 'deliverToolResults')
    const images = (deliver?.args as [RequestMessage[], Map<string, unknown>])[1]
    expect(images.get('a1')).toEqual({ data: 'QUJD', mediaType: 'image/jpeg' })
  })

  it('reads each duplicate attachment once', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const readImage = vi.fn(async (input: ImageAttachmentRef) => {
      void input
      return { bytes: new Uint8Array([65]), mediaType: 'image/png' }
    })
    const adapter = new QoderAdapter({ readImage })
    await drain(adapter, request({
      messages: [userTurn([imageBlock('a1'), imageBlock('a1'), imageBlock('a1')])],
    }))
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('keeps side-channel requests text-only', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const readImage = vi.fn(async (input: ImageAttachmentRef) => {
      void input
      return { bytes: new Uint8Array([65]), mediaType: 'image/png' }
    })
    const adapter = new QoderAdapter({ readImage })
    await drain(adapter, request({ purpose: 'compaction' }))
    expect(readImage).not.toHaveBeenCalled()
    expect(sessions).toHaveLength(0)
  })
})

describe('prepareCall binding', () => {
  it('dispatches on the generation it prepared, not on a later catalog state', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const adapter = new QoderAdapter({
      readImage: async () => ({ bytes: new Uint8Array([65]), mediaType: 'image/png' }),
    })
    const prepared = await adapter.prepareCall(QODER_PROVIDER, 'vmodel')
    expect(prepared.model.inputModalities).toEqual(['text', 'image'])
    // The catalog flips to text-only after preparation; the bound call must
    // still deliver pixels, because the harness priced the request against the
    // generation it was given.
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: false }]
    await collect(prepared.stream(request()))
    const session = sessions[0] as { feed: Array<{ type: string }> }
    expect(session.feed.some(block => block.type === 'image')).toBe(true)
  })

  it('resolves the model once per prepared call', async () => {
    catalog.models = [{ value: 'vmodel', displayName: 'V', description: '', isEnabled: true, isVl: true }]
    const adapter = new QoderAdapter()
    const spy = vi.spyOn(adapter, 'resolveModel')
    await adapter.prepareCall(QODER_PROVIDER, 'vmodel')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
