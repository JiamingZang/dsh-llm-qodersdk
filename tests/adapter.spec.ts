/**
 * QoderAdapter: provider listing, model resolution, reasoning metadata, and
 * the continuation plan for warm sessions. The model catalog is mocked; the
 * pure decision helpers are tested directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import {
  QODER_BYOK_PROVIDER, QODER_PROVIDER, QoderAdapter, planContinuation, reasoningInfo,
} from '../src/adapter.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../src/catalog.ts'

const { catalogInstances } = vi.hoisted(() => ({
  catalogInstances: [] as Array<{ liveModels: ReturnType<typeof vi.fn>, models: ReturnType<typeof vi.fn> }>,
}))

vi.mock('../src/models.ts', () => ({
  DEFAULT_MODEL_CACHE_TTL_MS: 300_000,
  QoderModelCatalog: class {
    liveModels = vi.fn()
    models = vi.fn()
    constructor() {
      catalogInstances.push(this)
    }
  },
}))

function text(content: string): ContentBlock {
  return { type: 'text', text: content }
}

function message(role: Message['role'], content: ContentBlock[], overrides: Partial<Message> = {}): Message {
  return {
    id: MessageId('m1'),
    role,
    content,
    source: { kind: 'user' },
    ...overrides,
  } as Message
}

function liveEntry(overrides: Record<string, unknown> = {}) {
  return {
    value: 'dmodel',
    displayName: 'DeepSeek-V4-Pro',
    description: 'desc',
    isEnabled: true,
    source: 'system',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
    defaultContextWindow: 200_000,
    availableContextWindows: [200_000, 1_000_000],
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    isReasoning: true,
    ...overrides,
  }
}

beforeEach(() => {
  catalogInstances.length = 0
})

describe('reasoningInfo', () => {
  it('returns undefined for a non-reasoning model without efforts', () => {
    expect(reasoningInfo(undefined, undefined, false)).toBeUndefined()
  })

  it('falls back to the default efforts when the CLI reports none', () => {
    const info = reasoningInfo(undefined, undefined, true)
    expect(info?.efforts.map(e => e.id)).toEqual(['low', 'medium', 'high', 'max'])
    expect(info?.defaultEffort).toBeUndefined()
  })

  it('carries the CLI efforts and a known default effort', () => {
    const info = reasoningInfo(['low', 'max'], 'max', true)
    expect(info?.efforts.map(e => e.id)).toEqual(['low', 'max'])
    expect(info?.defaultEffort).toBe('max')
  })

  it('omits a default effort outside the reported ids', () => {
    const info = reasoningInfo(['low'], 'high', true)
    expect(info?.efforts.map(e => e.id)).toEqual(['low'])
    expect(info?.defaultEffort).toBeUndefined()
  })
})

describe('planContinuation', () => {
  it('rebuilds when the current list is not longer', () => {
    const previous = [message('user', [text('a')])]
    expect(planContinuation(previous, previous)).toEqual({ feed: null, rebuild: true })
    expect(planContinuation(previous, [])).toEqual({ feed: null, rebuild: true })
  })

  it('rebuilds when the head message mutated', () => {
    const previous = [message('user', [text('a')]), message('user', [text('b')])]
    const current = [message('user', [text('a!')]), message('user', [text('b')])]
    expect(planContinuation(previous, current)).toEqual({ feed: null, rebuild: true })
  })

  it('rebuilds when more than two messages mutated', () => {
    const previous = [message('user', [text('a')]), message('user', [text('b')]), message('user', [text('c')])]
    const current = [
      message('user', [text('a!')]),
      message('user', [text('b!')]),
      message('user', [text('c!')]),
      message('user', [text('d')]),
    ]
    expect(planContinuation(previous, current)).toEqual({ feed: null, rebuild: true })
  })

  it('continues silently when only tool results arrived', () => {
    const previous = [message('user', [text('a')])]
    const current = [
      ...previous,
      {
        id: MessageId('t1'), role: 'tool', content: [text('ok')],
        source: { kind: 'tool', callId: ToolCallId('c1') }, toolCallId: ToolCallId('c1'),
      } as RequestMessage,
    ]
    expect(planContinuation(previous, current)).toEqual({ feed: null, rebuild: false })
  })

  it('feeds fresh user turns', () => {
    const previous = [message('user', [text('a')])]
    const current = [...previous, message('user', [text('hi')])]
    const plan = planContinuation(previous, current)
    expect(plan.rebuild).toBe(false)
    expect(plan.feed).toContain('[用户] hi')
  })

  it('feeds in-place mutations with the refresh marker', () => {
    const previous = [message('user', [text('a')]), message('user', [text('b')])]
    const current = [message('user', [text('a')]), message('user', [text('b!')]), message('user', [text('c')])]
    const plan = planContinuation(previous, current)
    expect(plan.rebuild).toBe(false)
    expect(plan.feed).toContain('（宿主原位刷新了这条消息）')
  })
})

describe('QoderAdapter.listModels', () => {
  it('lists built-in models on the qoder route', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.models.mockResolvedValue([
      { id: 'dmodel', name: 'DeepSeek-V4-Pro', source: 'system' },
      { id: 'custom1', name: 'My Model', source: 'user' },
    ])
    const models = await adapter.listModels(QODER_PROVIDER)
    expect(models.map(m => m.id)).toEqual(['dmodel'])
    expect(models[0]?.provider).toBe(QODER_PROVIDER)
  })

  it('lists only custom models on the qoder-byok route', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.models.mockResolvedValue([
      { id: 'dmodel', name: 'DeepSeek-V4-Pro', source: 'system' },
      { id: 'custom1', name: 'My Model', source: 'user' },
    ])
    const models = await adapter.listModels(QODER_BYOK_PROVIDER)
    expect(models.map(m => m.id)).toEqual(['custom1'])
  })
})

describe('QoderAdapter.resolveModel', () => {
  it('prefers the default context window over the input ceiling', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([liveEntry()])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'dmodel')
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
    expect(resolved.defaultMaxTokens).toBe(64_000)
  })

  it('falls back to the input ceiling without a default window', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([
      liveEntry({ defaultContextWindow: undefined, availableContextWindows: undefined }),
    ])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'dmodel')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('resolves an alias address against the live catalog and echoes it back', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([liveEntry({ value: 'dfmodel', isVl: true })])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'deepseek-v4-flash')
    // The seam rejects an exact-model result whose id differs from the request,
    // so the alias rides back unchanged while the metadata comes from dfmodel.
    expect(resolved.id).toBe('deepseek-v4-flash')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
  })

  it('carries reasoning metadata from the live entry', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([liveEntry()])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'dmodel')
    expect(resolved.reasoning?.efforts.map(e => e.id)).toEqual(['low', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('low')
  })

  it('resolves unknown live entries against the static catalog', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.context?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolved.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('passes through unknown model ids with defaults', async () => {
    const adapter = new QoderAdapter()
    catalogInstances[0]?.liveModels.mockResolvedValue([])
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'totally-unknown')
    expect(resolved.id).toBe('totally-unknown')
    expect(resolved.name).toBe('totally-unknown')
    expect(resolved.context?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})
