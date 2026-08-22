import { describe, expect, it, vi } from 'vitest'
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
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 })
    expect(view.usageAtMs).toEqual(expect.any(Number))
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
      { kind: 'reasoning', status: 'completed', startedAtMs: expect.any(Number), endedAtMs: expect.any(Number) },
      {
        kind: 'tool',
        name: 'bash',
        status: 'completed',
        argumentsJson: '{"command":"pwd"}',
        startedAtMs: expect.any(Number),
        endedAtMs: expect.any(Number),
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
    const startedAt = view.steps[1]?.startedAtMs
    const endedAt = view.steps[1]?.endedAtMs
    view.observe(result)

    expect(view.answerText).toBe('answer')
    expect(view.steps).toHaveLength(2)
    // Duplicate result is idempotent AND the start instant survives completion.
    expect(view.steps[1]).toMatchObject({
      kind: 'tool',
      status: 'completed',
      startedAtMs: startedAt,
      endedAtMs: endedAt,
    })
  })

  it('keeps the tool start instant and records the real duration', () => {
    vi.useFakeTimers()
    try {
      const view = new TurnView(1)
      vi.setSystemTime(new Date(2024, 0, 2, 10, 0, 0))
      view.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
      vi.setSystemTime(new Date(2024, 0, 2, 10, 0, 2, 300))
      view.observe(event('tool/result', {
        turn: 1,
        message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      }))

      expect(view.steps[0]).toEqual({
        kind: 'tool',
        name: 'bash',
        status: 'completed',
        argumentsJson: '{}',
        startedAtMs: new Date(2024, 0, 2, 10, 0, 0).getTime(),
        endedAtMs: new Date(2024, 0, 2, 10, 0, 2, 300).getTime(),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens 思考中 on the first reasoning delta and merges it on completion', () => {
    vi.useFakeTimers()
    try {
      const view = new TurnView(1)
      vi.setSystemTime(new Date(2024, 0, 2, 10, 0, 0))
      view.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta' } }))
      vi.setSystemTime(new Date(2024, 0, 2, 10, 0, 1))
      view.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta' } }))
      expect(view.steps).toEqual([
        { kind: 'reasoning', status: 'thinking', startedAtMs: new Date(2024, 0, 2, 10, 0, 0).getTime() },
      ])

      vi.setSystemTime(new Date(2024, 0, 2, 10, 0, 3))
      // Two reasoning blocks in one message still merge into the same row.
      view.observe(event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'block one' },
            { type: 'reasoning', text: 'block two' },
          ],
        },
      }))

      expect(view.steps).toEqual([
        {
          kind: 'reasoning',
          status: 'completed',
          startedAtMs: new Date(2024, 0, 2, 10, 0, 0).getTime(),
          endedAtMs: new Date(2024, 0, 2, 10, 0, 3).getTime(),
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles in-flight steps as stopped when the turn ends early', () => {
    vi.useFakeTimers()
    try {
      const view = new TurnView(1)
      view.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta' } }))
      view.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
      view.observe(event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } }))

      expect(view.status).toBe('failed')
      expect(view.steps.map(step => step.status)).toEqual(['stopped', 'stopped'])
      for (const step of view.steps) {
        expect(step.endedAtMs).toEqual(expect.any(Number))
      }
    } finally {
      vi.useRealTimers()
    }
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
