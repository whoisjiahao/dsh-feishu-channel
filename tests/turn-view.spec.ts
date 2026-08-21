import { describe, expect, it } from 'vitest'
import type { HostSessionEvent } from '../src/host.ts'
import { TurnView } from '../src/presentation/turn-view.ts'

function event(type: string, data: object): HostSessionEvent {
  return { type, data }
}

describe('TurnView', () => {
  it('projects streamed text, context, usage, and terminal state', () => {
    const view = new TurnView(1)
    view.observe(event('request/context', {
      provider: 'deepseek',
      model: ' deepseek-v4-pro ',
      contextWindow: 1_000_000,
    }))
    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'text-delta', text: '你' },
    }))
    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'text-delta', text: '好' },
    }))
    view.observe(event('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        content: [{ type: 'text', text: '最终答案' }],
        source: { kind: 'model', model: 'deepseek-v4-flash' },
      },
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
    }))
    view.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    expect(view.status).toBe('completed')
    expect(view.answerText).toBe('最终答案')
    expect(view.model).toBe('deepseek-v4-flash')
    expect(view.contextWindow).toBe(1_000_000)
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(view.finishedAt).toEqual(expect.any(Number))
    expect(view.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps the first terminal state immutable', () => {
    const view = new TurnView(1)
    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'text-delta', text: '保留' },
    }))
    view.observe(event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'READ_TIMEOUT', message: 'boom' } },
    }))
    const terminalSnapshot = {
      status: view.status,
      answerText: view.answerText,
      errorCode: view.errorCode,
      errorMessage: view.errorMessage,
      finishedAt: view.finishedAt,
      durationMs: view.durationMs,
    }

    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'text-delta', text: '不应出现' },
    }))
    view.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    expect({
      status: view.status,
      answerText: view.answerText,
      errorCode: view.errorCode,
      errorMessage: view.errorMessage,
      finishedAt: view.finishedAt,
      durationMs: view.durationMs,
    }).toEqual(terminalSnapshot)
  })

  it('stores only renderable reasoning and tool metadata', () => {
    const view = new TurnView(1)
    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'reasoning-delta', text: 'private chain of thought' },
    }))
    view.observe(event('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: 'private committed reasoning' }] },
    }))
    view.observe(event('tool/call', {
      turn: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{"command":"pwd"}',
    }))
    view.observe(event('tool/result', {
      turn: 1,
      message: {
        content: [{
          type: 'text',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'private tool result' }],
        }],
      },
    }))

    expect(view.steps).toEqual([
      { kind: 'reasoning', status: 'completed', atMs: expect.any(Number) },
      {
        kind: 'tool',
        name: 'bash',
        status: 'completed',
        argumentsJson: '{"command":"pwd"}',
        atMs: expect.any(Number),
      },
    ])
    expect(JSON.stringify(view)).not.toContain('private chain of thought')
    expect(JSON.stringify(view)).not.toContain('private committed reasoning')
    expect(JSON.stringify(view)).not.toContain('private tool result')
  })

  it('makes replayed messages, tool calls, and results idempotent', () => {
    const view = new TurnView(1)
    const message = event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: 'reason' },
          { type: 'text', text: 'answer' },
        ],
      },
    })
    const call = event('tool/call', {
      turn: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{}',
    })
    const result = event('tool/result', {
      turn: 1,
      message: {
        content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
      },
    })

    view.observe(message)
    view.observe(message)
    view.observe(call)
    view.observe(call)
    view.observe(result)
    const settledAt = view.steps[1]?.atMs
    view.observe(result)

    expect(view.answerText).toBe('answer')
    expect(view.steps).toHaveLength(2)
    expect(view.steps[1]).toMatchObject({ kind: 'tool', status: 'completed', atMs: settledAt })
  })

  it('ignores events from other turns', () => {
    const view = new TurnView(2)
    view.observe(event('assistant/chunk', {
      turn: 1,
      chunk: { type: 'text-delta', text: 'no' },
    }))
    view.observe(event('tool/call', {
      turn: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{}',
    }))

    expect(view.answerText).toBe('')
    expect(view.steps).toEqual([])
  })

  it('deduplicates replayed messages without a host step number', () => {
    const view = new TurnView(1)
    const message = event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'reasoning', text: 'same reasoning' }] },
    })

    view.observe(message)
    view.observe(message)

    expect(view.steps).toHaveLength(1)
  })
})
