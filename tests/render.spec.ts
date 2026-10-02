/**
 * Feed rendering: block, message, and feed composition pure functions.
 */
import { describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  blockParts, currentTurnStart, feedImageRefs, feedLength, feedToText, imageRefs,
  joinFeeds, renderBlocks, renderIdentityAppend, renderInitialFeed, renderMessage, renderRefreshed,
  renderSystemUpdate, renderUserTurn,
} from '../src/render.ts'

function text(content: string): ContentBlock {
  return { type: 'text', text: content }
}

function image(id: string): ImageAttachmentRef {
  return { attachmentId: id as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 3, width: 40, height: 30 }
}

function imageBlock(id: string): ContentBlock {
  return { type: 'image', attachment: image(id) }
}

function userMessage(content: ContentBlock[], extra: Partial<Message> = {}): Message {
  return {
    id: MessageId('m1'),
    role: 'user',
    content,
    source: { kind: 'user' },
    ...extra,
  } as Message
}

describe('renderBlocks', () => {
  it('joins text blocks with newlines', () => {
    expect(renderBlocks([text('a'), text('b')])).toBe('a\nb')
  })

  it('skips reasoning blocks', () => {
    expect(renderBlocks([text('a'), { type: 'reasoning', text: 'think' }])).toBe('a')
  })

  it('renders image blocks with the harness handle text', () => {
    expect(renderBlocks([imageBlock('att-1')])).toBe(textOnlyImageText(image('att-1')))
  })

  it('renders tool calls as placeholders', () => {
    expect(renderBlocks([{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"path":"a"}' }]))
      .toBe('[调用了工具 read({"path":"a"})]')
  })

  it('renders tool declaration changes', () => {
    expect(renderBlocks([{ type: 'tool-addition', toolName: 'read' }])).toBe('[工具启用 read]')
    expect(renderBlocks([{ type: 'tool-removal', toolName: 'read' }])).toBe('[工具停用 read]')
  })

  it('serializes unknown blocks as JSON', () => {
    expect(renderBlocks([{ type: 'bogus' } as unknown as ContentBlock])).toBe('{"type":"bogus"}')
  })
})

describe('renderMessage', () => {
  it('tags every role of the closed role map', () => {
    const system: RequestMessage = {
      id: MessageId('s'), role: 'system', content: [text('s')], source: { kind: 'system-prompt' },
    }
    const assistant = userMessage([text('a')], {
      role: 'assistant',
      source: { kind: 'model', provider: 'qoder', model: 'dmodel' },
    })
    const tool: RequestMessage = {
      id: MessageId('t'), role: 'tool', content: [text('out')],
      source: { kind: 'tool', callId: ToolCallId('c1') }, toolCallId: ToolCallId('c1'),
    }
    const developer: RequestMessage = {
      id: MessageId('d'), role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }],
      source: { kind: 'user' },
    }
    expect(renderMessage(system)).toBe('[系统提示] s')
    expect(renderMessage(userMessage([text('u')]))).toBe('[用户] u')
    expect(renderMessage(assistant)).toBe('[助手] a')
    expect(renderMessage(developer)).toBe('[开发者] [工具启用 read]')
    expect(renderMessage(tool)).toBe('[工具结果] out')
  })

  it('reads a request-only user input like a user message', () => {
    expect(renderMessage({ role: 'user', content: [text('now')] })).toBe('[用户] now')
  })
})

describe('currentTurnStart', () => {
  it('is the whole list while no assistant reply exists', () => {
    expect(currentTurnStart([userMessage([text('hi')])])).toBe(0)
    expect(currentTurnStart([])).toBe(0)
  })

  it('starts after the last assistant reply', () => {
    const assistant = userMessage([text('a')], { role: 'assistant', source: { kind: 'model', provider: 'qoder', model: 'm' } })
    const messages = [userMessage([text('u1')]), assistant, userMessage([text('u2')])]
    expect(currentTurnStart(messages)).toBe(2)
  })
})

describe('renderInitialFeed', () => {
  it('includes the backend role even without system or history', () => {
    const feed = renderInitialFeed(undefined, [])
    expect(feed).toContain('你在为一个编码 agent（宿主）充当 LLM API 后端')
    expect(feed).toContain('输出下一条助手回复')
  })

  it('embeds the host system prompt when present', () => {
    const feed = renderInitialFeed('你是 Qoder', [])
    expect(feed).toContain('---- 宿主系统提示（作为你的行为准则） ----\n你是 Qoder')
  })

  it('renders prior history as compact context', () => {
    const feed = renderInitialFeed(undefined, [userMessage([text('hi')])])
    expect(feed).toContain('---- 宿主对话记录 ----\n[用户] hi')
  })

  it('keeps a current-turn image as a part and its history as handle text', () => {
    const assistant = userMessage([text('a')], {
      role: 'assistant', source: { kind: 'model', provider: 'qoder', model: 'm' },
    })
    const feed = renderInitialFeed(undefined, [
      userMessage([imageBlock('old')]),
      assistant,
      userMessage([text('look'), imageBlock('new')]),
    ])
    expect(Array.isArray(feed)).toBe(true)
    expect(feedToText(feed)).toContain(textOnlyImageText(image('old')))
    expect(feedImageRefs(feed).map(ref => String(ref.attachmentId))).toEqual(['new'])
  })

  it('stays a plain string when the image is only history', () => {
    const assistant = userMessage([text('a')], {
      role: 'assistant', source: { kind: 'model', provider: 'qoder', model: 'm' },
    })
    const feed = renderInitialFeed(undefined, [userMessage([imageBlock('old')]), assistant, userMessage([text('next')])])
    expect(typeof feed).toBe('string')
    expect(feed).toContain(textOnlyImageText(image('old')))
  })
})

describe('turn rendering', () => {
  it('renders a brand-new user turn', () => {
    expect(renderUserTurn([text('hi')])).toBe('[用户] hi')
  })

  it('keeps image occurrences as parts', () => {
    expect(renderUserTurn([text('look'), imageBlock('a1')])).toEqual([
      { type: 'text', text: '[用户] look' },
      { type: 'image', attachment: image('a1') },
    ])
  })

  it('marks an in-place refresh', () => {
    expect(renderRefreshed(userMessage([text('x')]))).toBe('[用户] x\n（宿主原位刷新了这条消息）')
  })

  it('marks a mid-session system update', () => {
    expect(renderSystemUpdate('new rules')).toBe('[系统提示(更新)] new rules')
  })
})

describe('feed composition', () => {
  it('joins text sections with a blank line', () => {
    expect(joinFeeds(['a', '', 'b'])).toBe('a\n\nb')
  })

  it('turns the whole feed into parts once one section carries an image', () => {
    expect(joinFeeds(['a', [{ type: 'text', text: 'b' }, { type: 'image', attachment: image('i1') }], 'c'])).toEqual([
      { type: 'text', text: 'a\n\nb' },
      { type: 'image', attachment: image('i1') },
      { type: 'text', text: 'c' },
    ])
  })

  it('splits blocks into parts in block order', () => {
    expect(blockParts([text('look'), imageBlock('i1'), text('here')])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: image('i1') },
      { type: 'text', text: 'here' },
    ])
    expect(imageRefs([text('t'), imageBlock('i2')])).toHaveLength(1)
  })

  it('charges images a fixed character budget when estimating', () => {
    const feed: ReturnType<typeof blockParts> = [
      { type: 'text', text: 'abc' },
      { type: 'image', attachment: image('i1') },
    ]
    expect(feedLength('abc', 100)).toBe(3)
    expect(feedLength(feed, 100)).toBe(103)
  })
})

describe('renderIdentityAppend', () => {
  it('forbids Qoder self-identification without a host system', () => {
    const append = renderIdentityAppend(undefined)
    expect(append).toContain('不要自称 Qoder')
    expect(append).not.toContain('---- 宿主系统提示（作为你的行为准则与对外身份） ----')
  })

  it('embeds the host system when present', () => {
    const append = renderIdentityAppend('你是宿主')
    expect(append).toContain('---- 宿主系统提示（作为你的行为准则与对外身份） ----\n你是宿主')
  })
})
