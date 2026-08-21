/** Stable identity for one Feishu conversation facet and one inbound turn. */

import { randomUUID } from 'node:crypto'

/** How Feishu traffic is partitioned into DSH sessions. */
export type SessionScope = 'chat' | 'chat-thread' | 'chat-sender'

/** Message identity fields used before any agent or transport work begins. */
export interface ConversationAddress {
  readonly chatId: string
  readonly senderId: string
  readonly messageId: string
  readonly threadId?: string | undefined
}

declare const conversationKeyBrand: unique symbol

/** Encoded key for one independently routed conversation facet. */
export type ConversationKey = string & { readonly [conversationKeyBrand]: true }

/** Immutable destination captured for one agent turn. */
export interface TurnTarget {
  readonly conversationKey: ConversationKey
  readonly chatId: string
  readonly replyToMessageId: string
  readonly replyInThread: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function component(value: string, label: string): string {
  if (value === '') throw new Error(label + ' must not be empty')
  return encodeURIComponent(value)
}

/** Derive the sole state-partition key for one configured session scope. */
export function conversationKey(scope: SessionScope, address: ConversationAddress): ConversationKey {
  const chat = component(address.chatId, 'chatId')
  if (scope === 'chat-thread' && address.threadId !== undefined && address.threadId !== '') {
    return ('thread:' + chat + ':' + component(address.threadId, 'threadId')) as ConversationKey
  }
  if (scope === 'chat-sender') {
    return ('sender:' + chat + ':' + component(address.senderId, 'senderId')) as ConversationKey
  }
  return ('chat:' + chat) as ConversationKey
}

/** Create a current-generation DSH session id for one conversation key. */
export function createSessionId(key: ConversationKey, generation: string = randomUUID()): string {
  if (!UUID.test(generation)) throw new Error('invalid session generation')
  return 'feishu-' + key + '~' + generation.toLowerCase()
}

/** Test whether a session id is a current-generation id for this key. */
export function sessionBelongsTo(key: ConversationKey, sessionId: string): boolean {
  const prefix = 'feishu-' + key + '~'
  return sessionId.startsWith(prefix) && UUID.test(sessionId.slice(prefix.length))
}

/** Capture a turn's reply destination before asynchronous work can interleave. */
export function createTurnTarget(scope: SessionScope, address: ConversationAddress): TurnTarget {
  return Object.freeze({
    conversationKey: conversationKey(scope, address),
    chatId: address.chatId,
    replyToMessageId: address.messageId,
    replyInThread: address.threadId !== undefined && address.threadId !== '',
  })
}
