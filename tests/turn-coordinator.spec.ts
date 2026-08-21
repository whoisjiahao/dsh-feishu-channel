import { describe, expect, it, vi } from 'vitest'
import type { OwnedAgent } from '../src/agent-registry.ts'
import { conversationKey, createTurnTarget } from '../src/conversation.ts'
import type { ConversationAddress, ConversationKey } from '../src/conversation.ts'
import type { HostAgent, HostSessionEvent, HostUserMessage } from '../src/host.ts'
import { TurnCoordinator } from '../src/turn-coordinator.ts'

function address(overrides: Partial<ConversationAddress> = {}): ConversationAddress {
  return {
    chatId: 'oc_chat',
    senderId: 'ou_sender',
    messageId: 'om_message',
    ...overrides,
  }
}

function owned(sessionId = 'session-1', key: ConversationKey = conversationKey('chat', address())): OwnedAgent {
  const agent: HostAgent = {
    id: sessionId,
    session: { id: sessionId, requestContext: () => undefined },
    followup: vi.fn(),
    cancel: vi.fn(),
  }
  return {
    conversationKey: key,
    handle: { agent, dispose: vi.fn(async () => {}) },
  }
}

function message(text: string): HostUserMessage {
  return {
    id: 'user-' + text,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function event(type: string, turn?: number): HostSessionEvent {
  return { type, data: turn === undefined ? {} : { turn } }
}

describe('TurnCoordinator', () => {
  it('binds queued messages to host turns in submission order', () => {
    const coordinator = new TurnCoordinator()
    const agent = owned()
    const firstTarget = createTurnTarget('chat', address({ messageId: 'om_first' }))
    const secondTarget = createTurnTarget('chat', address({ messageId: 'om_second' }))
    const first = coordinator.submit(agent, firstTarget, message('first'))
    const second = coordinator.submit(agent, secondTarget, message('second'))

    expect(coordinator.route(agent.handle.agent.session.id, event('step/start', 1))).toBe(first)
    expect(coordinator.route(agent.handle.agent.session.id, event('step/start', 2))).toBe(second)
    expect(first.target.replyToMessageId).toBe('om_first')
    expect(second.target.replyToMessageId).toBe('om_second')
    expect(agent.handle.agent.followup).toHaveBeenCalledTimes(2)
  })

  it('isolates reset and retry state by full conversation key', () => {
    const coordinator = new TurnCoordinator()
    const firstTarget = createTurnTarget('chat-thread', address({ threadId: 'omt_1', messageId: 'om_1' }))
    const secondTarget = createTurnTarget('chat-thread', address({ threadId: 'omt_2', messageId: 'om_2' }))
    const firstAgent = owned('session-thread-1', firstTarget.conversationKey)
    const secondAgent = owned('session-thread-2', secondTarget.conversationKey)
    const first = coordinator.submit(firstAgent, firstTarget, message('first'))
    const second = coordinator.submit(secondAgent, secondTarget, message('second'))

    coordinator.clear(firstTarget.conversationKey)
    expect(coordinator.retry(firstTarget.conversationKey, first.id)).toBeUndefined()
    const retried = coordinator.retry(secondTarget.conversationKey, second.id)
    expect(retried?.message.content).toEqual(message('second').content)
    expect(retried?.message.id).not.toBe(second.message.id)
    expect(secondAgent.handle.agent.followup).toHaveBeenCalledTimes(2)
  })

  it('refuses a stale card retry after a newer turn exists', () => {
    const coordinator = new TurnCoordinator()
    const agent = owned()
    const target = createTurnTarget('chat', address())
    const oldTurn = coordinator.submit(agent, target, message('old'))
    coordinator.route(agent.handle.agent.session.id, event('turn/end', 1))
    const latest = coordinator.submit(agent, target, message('latest'))

    expect(coordinator.retry(target.conversationKey, oldTurn.id)).toBeUndefined()
    const retried = coordinator.retry(target.conversationKey, latest.id)
    expect(retried?.message.content).toEqual(message('latest').content)
    expect(retried?.message.id).not.toBe(latest.message.id)
    expect(retried?.id).not.toBe(latest.id)
  })

  it('routes only events for turns submitted by this channel', () => {
    const coordinator = new TurnCoordinator()
    expect(coordinator.route('foreign-session', event('step/start', 1))).toBeUndefined()

    const agent = owned()
    const submitted = coordinator.submit(agent, createTurnTarget('chat', address()), message('hello'))
    expect(coordinator.route(agent.handle.agent.session.id, event('request/context'))).toBe(submitted)
    coordinator.clear(submitted.target.conversationKey)
    expect(coordinator.route(agent.handle.agent.session.id, event('step/start', 1))).toBeUndefined()
  })

  it('exposes only the current submitted turn for host interactions', () => {
    const coordinator = new TurnCoordinator()
    const agent = owned()
    const submitted = coordinator.submit(agent, createTurnTarget('chat', address()), message('hello'))
    expect(coordinator.current(agent.handle.agent.session.id)).toBe(submitted)
    coordinator.route(agent.handle.agent.session.id, event('step/start', 1))
    expect(coordinator.current(agent.handle.agent.session.id)).toBe(submitted)
    coordinator.route(agent.handle.agent.session.id, event('turn/end', 1))
    expect(coordinator.current(agent.handle.agent.session.id)).toBeUndefined()
  })
})
