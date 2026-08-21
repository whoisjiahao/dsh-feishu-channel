import { describe, expect, it, vi } from 'vitest'
import { createReplyPresenter } from '../src/presentation/reply-presenter.ts'
import type {
  ReplyPresenterOptions,
  ReplyPresenterPort,
} from '../src/presentation/reply-presenter.ts'
import type { CardRenderOptions } from '../src/presentation/feishu-card.ts'
import type { HostSessionEvent, RequestContextData } from '../src/host.ts'

function event(type: string, data: object): HostSessionEvent {
  return { type, data }
}

const options: CardRenderOptions = {
  showProcess: true,
  maxTimelineItems: 12,
  tableOverflowMode: 'compact',
  footerFields: ['duration'],
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 450))
}

function fakePort(): ReplyPresenterPort & { sends: number; updates: number } {
  const state = { sends: 0, updates: 0 }
  const port: ReplyPresenterPort & { sends: number; updates: number } = {
    sends: 0,
    updates: 0,
    async send() {
      state.sends += 1
      return { messageId: 'm' + state.sends }
    },
    async updateCard() {
      state.updates += 1
    },
  }
  const handler = {
    get sends() { return state.sends },
    get updates() { return state.updates },
  }
  Object.defineProperties(port, {
    sends: { get: () => state.sends },
    updates: { get: () => state.updates },
  })
  void handler
  return port
}

function createReplyPresenterForTest(
  port: ReplyPresenterPort,
  chatId: string,
  presenterOptions: ReplyPresenterOptions,
  initialContext?: RequestContextData,
  replyToMessageId = 'om_source',
) {
  return createReplyPresenter(port, {
    chatId,
    replyToMessageId,
    replyInThread: false,
  }, { ...presenterOptions, initialContext })
}

describe('ReplyPresenter transport', () => {
  it('creates one card and updates it in place for a turn', async () => {
    const port = fakePort()
    const renderer = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    renderer.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '你' } }))
    renderer.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '好' } }))
    await settle()
    expect(port.sends).toBe(1)
    renderer.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(port.updates).toBeGreaterThanOrEqual(1)
    await renderer.close()
  })

  it('does not create a second card while the first send is still pending', async () => {
    vi.useFakeTimers()
    let sends = 0
    let releaseSend!: (result: { messageId: string }) => void
    const pendingSend = new Promise<{ messageId: string }>((resolve) => {
      releaseSend = resolve
    })
    const port: ReplyPresenterPort = {
      async send() {
        sends += 1
        return pendingSend
      },
      async updateCard() {},
    }
    const renderer = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })

    try {
      renderer.observe(event('step/start', { turn: 1, step: 0 }))
      await vi.advanceTimersByTimeAsync(350)
      expect(sends).toBe(1)

      renderer.observe(event('assistant/chunk', {
        turn: 1,
        chunk: { type: 'reasoning-delta', text: '继续分析' },
      }))
      await vi.advanceTimersByTimeAsync(350)

      expect(sends).toBe(1)
    } finally {
      releaseSend({ messageId: 'm1' })
      await Promise.resolve()
      await renderer.close()
      vi.useRealTimers()
    }
  })

  it('falls back to a markdown message when card sends fail', async () => {
    const sent: string[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const record = input as { markdown?: string; card?: object }
        if (record.card !== undefined) throw new Error('card permission denied')
        sent.push(record.markdown ?? '')
        return { messageId: 'fb' }
      },
      async updateCard() { throw new Error('never') },
    }
    const renderer = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    renderer.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'fallback text' } }))
    await settle()
    renderer.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    await renderer.close()
    expect(sent.join('')).toContain('fallback text')
  })

  it('settles the loading card to a handoff card when the terminal update is rejected', async () => {
    const native: string[] = []
    const updates: object[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const record = input as { card?: object; markdown?: string }
        if (record.markdown !== undefined) native.push(record.markdown)
        return { messageId: 'm1' }
      },
      async updateCard(_messageId, card) {
        updates.push(card)
        if (updates.length === 1) throw new Error('terminal card rejected')
      },
    }
    const renderer = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    renderer.observe(event('step/start', { turn: 1, step: 0 }))
    await settle()
    renderer.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '最终答案' }] },
    }))
    renderer.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    await renderer.close()

    expect(updates).toHaveLength(2)
    expect(JSON.stringify(updates[1])).toContain('完整内容已切换为原生消息发送')
    expect(native).toEqual(['最终答案'])
  })

  it('settles the loading card before handing oversized terminal content to a native message', async () => {
    const native: string[] = []
    const updates: object[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const record = input as { markdown?: string }
        if (record.markdown !== undefined) native.push(record.markdown)
        return { messageId: 'm1' }
      },
      async updateCard(_messageId, card) {
        updates.push(card)
      },
    }
    const renderer = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    renderer.observe(event('step/start', { turn: 1, step: 0 }))
    await settle()
    renderer.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'x'.repeat(50_000) }] },
    }))
    renderer.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    await renderer.close()

    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates[0])).toContain('完整内容已切换为原生消息发送')
    expect(native).toHaveLength(1)
  })

  it('aims replies at the triggering message', async () => {
    let seenReplyTo: string | undefined
    const port: ReplyPresenterPort = {
      async send(_to, _input, opts) {
        seenReplyTo = opts?.replyTo
        return { messageId: 'm1' }
      },
      async updateCard() {},
    }
    const renderer = createReplyPresenterForTest(
      port,
      'oc_1',
      { ...options, onFailure: vi.fn() },
      undefined,
      'msg-9',
    )
    renderer.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'x' } }))
    await settle()
    expect(seenReplyTo).toBe('msg-9')
    await renderer.close()
  })

  it('does not repeat the quoted request in the first card', async () => {
    const sentCards: string[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const record = input as { card?: object }
        if (record.card !== undefined) sentCards.push(JSON.stringify(record.card))
        return { messageId: 'mc' }
      },
      async updateCard() {},
    }
    const renderer = createReplyPresenterForTest(
      port,
      'oc_1',
      { ...options, onFailure: vi.fn() },
      undefined,
      'msg-9',
    )
    renderer.observe(event('step/start', { turn: 1, step: 0 }))
    await settle()
    expect(sentCards.length).toBe(1)
    expect(sentCards[0]).toContain('正在分析')
    expect(sentCards[0]).not.toContain('/api/orders')
    await renderer.close()
  })

  it('settles a new turn onto a fresh card', async () => {
    const port = fakePort()
    const first = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    first.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: 'a' } }))
    await settle()
    first.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    await first.close()

    const second = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    second.observe(event('assistant/chunk', { turn: 2, chunk: { type: 'text-delta', text: 'b' } }))
    await settle()
    expect(port.sends).toBe(2)
    await second.close()
  })

  it('uses the current session context for each turn-bound presenter', async () => {
    const cards: string[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const card = (input as { card?: object }).card
        if (card !== undefined) cards.push(JSON.stringify(card))
        return { messageId: 'm' + cards.length }
      },
      async updateCard() {},
    }
    const context = {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
    }
    const first = createReplyPresenterForTest(port, 'oc_1', {
      ...options,
      footerFields: ['model', 'context'],
      onFailure: vi.fn(),
    })
    first.observe(event('request/context', context))
    first.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'a' }] },
      usage: { inputTokens: 50_000, outputTokens: 1 },
    }))
    first.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    await first.close()

    const second = createReplyPresenterForTest(port, 'oc_1', {
      ...options,
      footerFields: ['model', 'context'],
      onFailure: vi.fn(),
    }, context)
    second.observe(event('assistant/message', {
      turn: 2,
      message: { content: [{ type: 'text', text: 'b' }] },
      usage: { inputTokens: 70_000, outputTokens: 1 },
    }))
    second.observe(event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await settle()

    expect(cards).toHaveLength(2)
    expect(cards[0]).toContain('deepseek-v4-pro')
    expect(cards[0]).toContain('50k/1m · 5%')
    expect(cards[1]).toContain('70k/1m · 7%')
    await second.close()
  })

  it('seeds ctx capacity from a resumed session before the next request event', async () => {
    const cards: string[] = []
    const port: ReplyPresenterPort = {
      async send(_to, input) {
        const card = (input as { card?: object }).card
        if (card !== undefined) cards.push(JSON.stringify(card))
        return { messageId: 'm1' }
      },
      async updateCard() {},
    }
    const renderer = createReplyPresenterForTest(port, 'oc_1', {
      ...options,
      footerFields: ['model', 'context'],
      onFailure: vi.fn(),
    }, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
    })

    renderer.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'answer' }] },
      usage: { inputTokens: 950, outputTokens: 1 },
    }))
    renderer.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await settle()

    expect(cards).toHaveLength(1)
    expect(cards[0]).toContain('deepseek-v4-flash')
    expect(cards[0]).toContain('950/1m · 0%')
    await renderer.close()
  })

  it('reuses the failed card for an explicit retry', async () => {
    const port = fakePort()
    const first = createReplyPresenterForTest(port, 'oc_1', { ...options, onFailure: vi.fn() })
    first.observe(event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'READ_TIMEOUT', message: 'boom' } },
    }))
    await settle()
    await first.close()
    expect(port.sends).toBe(1)

    const retry = createReplyPresenter(port, {
      chatId: 'oc_1',
      replyToMessageId: 'om_source',
      replyInThread: false,
    }, { ...options, onFailure: vi.fn(), reuseCardMessageId: 'm1' })
    retry.observe(event('step/start', { turn: 2, step: 0 }))
    await settle()
    expect(port.sends).toBe(1)
    expect(port.updates).toBeGreaterThanOrEqual(1)
    await retry.close()
  })
})
