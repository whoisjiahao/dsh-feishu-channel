import { describe, expect, it, vi } from 'vitest'
import type { HostSessionEvent } from '../src/host.ts'
import {
  createReplyPresenter,
  type ReplyPresenterPort,
} from '../src/presentation/reply-presenter.ts'
import type { CardRenderOptions } from '../src/presentation/feishu-card.ts'

const cardOptions: CardRenderOptions = {
  showProcess: true,
  maxTimelineItems: 12,
  tableOverflowMode: 'compact',
  footerFields: ['duration'],
}

function event(type: string, data: object): HostSessionEvent {
  return { type, data }
}

describe('ReplyPresenter', () => {
  it('binds each presenter to one immutable reply target', async () => {
    const targets: string[] = []
    const port: ReplyPresenterPort = {
      async send(_chatId, _input, options) {
        targets.push(options?.replyTo ?? '')
        return { messageId: 'm' + targets.length }
      },
      async updateCard() {},
    }
    const first = createReplyPresenter(port, {
      chatId: 'oc_1',
      replyToMessageId: 'om_first',
      replyInThread: false,
    }, { ...cardOptions, onFailure: vi.fn() })
    const second = createReplyPresenter(port, {
      chatId: 'oc_1',
      replyToMessageId: 'om_second',
      replyInThread: true,
    }, { ...cardOptions, onFailure: vi.fn() })

    first.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    second.observe(event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await Promise.all([first.close(), second.close()])

    expect(targets).toEqual(['om_first', 'om_second'])
  })

  it('sends one native answer when card delivery fails, even across repeated close', async () => {
    const native: string[] = []
    const failures: unknown[] = []
    const port: ReplyPresenterPort = {
      async send(_chatId, input) {
        if ('card' in input) throw new Error('card denied')
        if ('markdown' in input && typeof input.markdown === 'string') native.push(input.markdown)
        return { messageId: 'native' }
      },
      async updateCard() {},
    }
    const presenter = createReplyPresenter(port, {
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
      replyInThread: false,
    }, { ...cardOptions, onFailure: error => failures.push(error) })

    presenter.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'final answer' }] },
    }))
    presenter.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await Promise.all([presenter.close(), presenter.close()])

    expect(native).toEqual(['final answer'])
    expect(failures).toHaveLength(1)
  })

  it('clears its pending timer and closes idempotently', async () => {
    vi.useFakeTimers()
    const port: ReplyPresenterPort = {
      async send() { return { messageId: 'm1' } },
      async updateCard() {},
    }
    const presenter = createReplyPresenter(port, {
      chatId: 'oc_1',
      replyToMessageId: 'om_1',
      replyInThread: false,
    }, { ...cardOptions, onFailure: vi.fn() })

    try {
      presenter.observe(event('step/start', { turn: 1, step: 0 }))
      expect(vi.getTimerCount()).toBe(1)
      const firstClose = presenter.close()
      const secondClose = presenter.close()
      expect(firstClose).toBe(secondClose)
      await firstClose
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
