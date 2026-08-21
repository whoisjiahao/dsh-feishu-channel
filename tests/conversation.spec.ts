import { describe, expect, it } from 'vitest'
import {
  conversationKey,
  createSessionId,
  createTurnTarget,
  sessionBelongsTo,
  type ConversationAddress,
} from '../src/conversation.ts'

const address = (overrides: Partial<ConversationAddress> = {}): ConversationAddress => ({
  chatId: 'oc_chat',
  senderId: 'ou_sender',
  messageId: 'om_message',
  ...overrides,
})

describe('conversation identity', () => {
  it('partitions chat, thread, and sender scopes without key collisions', () => {
    expect(conversationKey('chat', address({ threadId: 'omt_1', senderId: 'ou_1' })))
      .toBe('chat:oc_chat')
    expect(conversationKey('chat-thread', address({ threadId: 'omt_1' })))
      .toBe('thread:oc_chat:omt_1')
    expect(conversationKey('chat-thread', address({ threadId: 'omt_2' })))
      .toBe('thread:oc_chat:omt_2')
    expect(conversationKey('chat-thread', address()))
      .toBe('chat:oc_chat')
    expect(conversationKey('chat-sender', address({ senderId: 'ou_1' })))
      .toBe('sender:oc_chat:ou_1')
    expect(conversationKey('chat-sender', address({ senderId: 'ou_2' })))
      .toBe('sender:oc_chat:ou_2')
  })

  it('escapes identity components before joining them', () => {
    const first = conversationKey('chat-thread', address({ chatId: 'a:b', threadId: 'c' }))
    const second = conversationKey('chat-thread', address({ chatId: 'a', threadId: 'b:c' }))
    expect(first).toBe('thread:a%3Ab:c')
    expect(second).toBe('thread:a:b%3Ac')
    expect(first).not.toBe(second)
  })

  it('creates only the current generated session format', () => {
    const key = conversationKey('chat', address())
    const id = createSessionId(key, '123e4567-e89b-42d3-a456-426614174000')
    expect(id).toBe('feishu-chat:oc_chat~123e4567-e89b-42d3-a456-426614174000')
    expect(sessionBelongsTo(key, id)).toBe(true)
    expect(sessionBelongsTo(key, 'feishu-chat:oc_chat')).toBe(false)
    expect(sessionBelongsTo(key, 'feishu-chat:other~123e4567-e89b-42d3-a456-426614174000')).toBe(false)
    expect(() => createSessionId(key, 'legacy-generation')).toThrow('invalid session generation')
  })

  it('captures one immutable reply target at message intake', () => {
    const target = createTurnTarget('chat-thread', address({ threadId: 'omt_1' }))
    expect(target).toEqual({
      conversationKey: 'thread:oc_chat:omt_1',
      chatId: 'oc_chat',
      replyToMessageId: 'om_message',
      replyInThread: true,
    })
    expect(Object.isFrozen(target)).toBe(true)
    expect(createTurnTarget('chat', address()).replyInThread).toBe(false)
  })
})
