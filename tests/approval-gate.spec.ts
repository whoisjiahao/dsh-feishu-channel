import { describe, expect, it, vi } from 'vitest'
import type { CardActionEvent, SendInput } from '@larksuite/channel'
import {
  createApprovalGate,
  type ApprovalTurn,
} from '../src/approval-gate.ts'
import { conversationKey } from '../src/conversation.ts'
import type { HostAgent, HostApprovalOutcome, HostApprovalRequest } from '../src/host.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function turn(sessionId: string, suffix: string): ApprovalTurn {
  return {
    sessionId,
    turnId: 'turn-' + suffix,
    conversationKey: conversationKey('chat-thread', {
      chatId: 'oc_chat',
      threadId: 'omt_' + suffix,
      senderId: 'ou_sender',
      messageId: 'om_' + suffix,
    }),
    chatId: 'oc_chat',
    chatType: 'group',
  }
}

function agent(sessionId: string): HostAgent {
  return {
    id: sessionId,
    session: { id: sessionId, requestContext: () => undefined },
    followup: vi.fn(),
    cancel: vi.fn(),
  }
}

function request(sessionId: string, overrides: Partial<HostApprovalRequest> = {}): HostApprovalRequest {
  return { agent: agent(sessionId), toolName: 'bash', ...overrides }
}

function click(value: unknown, messageId: string, chatId = 'oc_chat'): CardActionEvent {
  return {
    messageId,
    chatId,
    operator: { openId: 'ou_sender', name: 'Jiahao' },
    action: { tag: 'button', value },
  }
}

function actionValue(input: SendInput, decision: 'allow' | 'reject'): unknown {
  const card = (input as { card: { elements: { tag: string; actions?: { value: unknown }[] }[] } }).card
  return card.elements.find(element => element.tag === 'action')?.actions
    ?.map(action => action.value)
    .find(value => (value as { decision?: string }).decision === decision)
}

function cardText(input: SendInput): string {
  return JSON.stringify((input as { card: object }).card)
}

async function finishSendContinuation(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

function createFixture(options: { delayedSend?: boolean; failSend?: boolean } = {}) {
  const sent: { to: string; input: SendInput; messageId: string }[] = []
  const updates: { messageId: string; card: object }[] = []
  const notices: string[] = []
  const ids = ['approval-1', 'approval-2', 'approval-3', 'approval-4']
  const sendGate = options.delayedSend ? deferred<void>() : undefined
  let sendStarted = 0
  const gate = createApprovalGate({
    port: {
      async send(to, input) {
        sendStarted += 1
        if (sendGate !== undefined) await sendGate.promise
        if (options.failSend) throw new Error('send failed')
        const messageId = 'om_card_' + (sent.length + 1)
        sent.push({ to, input, messageId })
        return { messageId }
      },
      async updateCard(messageId, card) {
        updates.push({ messageId, card })
      },
    },
    notify: line => { notices.push(line) },
    refuseCardAction: (subject, pending) => subject.chatId === pending.chatId ? undefined : 'wrong chat',
    createId: () => ids.shift() ?? 'approval-extra',
  })
  return {
    gate,
    sent,
    updates,
    notices,
    sendGate,
    get sendStarted() { return sendStarted },
  }
}

describe('ApprovalGate', () => {
  it('keeps identical call ids isolated by owned session and turn', async () => {
    const fixture = createFixture()
    const first = turn('session-1', 'one')
    const second = turn('session-2', 'two')
    fixture.gate.recordToolCall(first, 'call-1', 'curl --api-key first-secret')
    fixture.gate.recordToolCall(second, 'call-1', 'echo second-command')

    const firstOutcome = fixture.gate.ask(first, request('session-1', { callId: 'call-1' }), async () => 'unavailable')
    const secondOutcome = fixture.gate.ask(second, request('session-2', { callId: 'call-1' }), async () => 'unavailable')
    await vi.waitFor(() => { expect(fixture.sent).toHaveLength(2) })
    await finishSendContinuation()
    expect(cardText(fixture.sent[0]!.input)).toContain('curl --api-key [REDACTED]')
    expect(cardText(fixture.sent[0]!.input)).not.toContain('first-secret')
    expect(cardText(fixture.sent[1]!.input)).toContain('echo second-command')

    fixture.gate.handleCardAction(click(actionValue(fixture.sent[0]!.input, 'allow'), 'om_card_1'))
    fixture.gate.handleCardAction(click(actionValue(fixture.sent[1]!.input, 'reject'), 'om_card_2'))
    expect(await firstOutcome).toBe('allowed-once')
    expect(await secondOutcome).toBe('rejected')
  })

  it('bounds and carries every untrusted card value as plain_text', async () => {
    const fixture = createFixture()
    const owner = turn('session-1', 'one')
    fixture.gate.recordToolCall(owner, 'call-1', 'curl --token command-secret <command>')
    const outcome = fixture.gate.ask(owner, request('session-1', {
      callId: 'call-1',
      toolName: '<script>bash</script>',
      reason: 'token=reason-secret <reason>',
    }), async () => 'unavailable')
    await vi.waitFor(() => { expect(fixture.sent).toHaveLength(1) })
    await finishSendContinuation()

    const card = (fixture.sent[0]!.input as { card: any }).card
    const dynamic = JSON.stringify(card)
    expect(dynamic).not.toContain('command-secret')
    expect(dynamic).not.toContain('reason-secret')
    expect(dynamic).toContain('[REDACTED]')
    const dynamicValues = card.elements
      .flatMap((element: any) => [
        ...(element.fields ?? []).map((field: any) => field.text),
        element.text,
      ])
      .filter((text: any) => /<(?:script|command|reason)>/.test(text?.content ?? ''))
    expect(dynamicValues.every((text: any) => text.tag === 'plain_text')).toBe(true)

    fixture.gate.handleCardAction(click(actionValue(fixture.sent[0]!.input, 'reject'), 'om_card_1'))
    expect(await outcome).toBe('rejected')
  })

  it('settles an already-aborted request without sending', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    controller.abort()
    const outcome = await fixture.gate.ask(
      turn('session-1', 'one'),
      request('session-1', { signal: controller.signal }),
      async () => 'unavailable',
    )
    expect(outcome).toBe('cancelled')
    expect(fixture.sent).toHaveLength(0)
  })

  it('settles during send and rewrites the late card as withdrawn', async () => {
    const fixture = createFixture({ delayedSend: true })
    const controller = new AbortController()
    const outcome = fixture.gate.ask(
      turn('session-1', 'one'),
      request('session-1', { signal: controller.signal }),
      async () => 'unavailable',
    )
    await vi.waitFor(() => { expect(fixture.sendStarted).toBe(1) })
    controller.abort()
    expect(await outcome).toBe('cancelled')

    fixture.sendGate!.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.updates).toHaveLength(1) })
    expect(JSON.stringify(fixture.updates[0]!.card)).toContain('已撤回')
  })

  it('settles after send and rewrites the visible card as withdrawn', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const outcome = fixture.gate.ask(
      turn('session-1', 'one'),
      request('session-1', { signal: controller.signal }),
      async () => 'unavailable',
    )
    await vi.waitFor(() => { expect(fixture.sent).toHaveLength(1) })
    controller.abort()
    expect(await outcome).toBe('cancelled')
    await vi.waitFor(() => { expect(fixture.updates).toHaveLength(1) })
    expect(JSON.stringify(fixture.updates[0]!.card)).toContain('已撤回')
  })

  it('delegates a send failure and a request for another session', async () => {
    const sendFailure = createFixture({ failSend: true })
    const next = vi.fn(async (): Promise<HostApprovalOutcome> => 'unavailable')
    expect(await sendFailure.gate.ask(turn('session-1', 'one'), request('session-1'), next)).toBe('unavailable')
    expect(next).toHaveBeenCalledTimes(1)

    const foreign = createFixture()
    expect(await foreign.gate.ask(turn('session-1', 'one'), request('session-2'), next)).toBe('unavailable')
    expect(foreign.sent).toHaveLength(0)
  })

  it('refuses a cross-chat click without settling the owner question', async () => {
    const fixture = createFixture()
    const owner = turn('session-1', 'one')
    const outcome = fixture.gate.ask(owner, request('session-1'), async () => 'unavailable')
    await vi.waitFor(() => { expect(fixture.sent).toHaveLength(1) })
    await finishSendContinuation()
    const allow = actionValue(fixture.sent[0]!.input, 'allow')
    expect(fixture.gate.handleCardAction(click(allow, 'om_card_1', 'oc_other'))).toEqual({
      toast: { type: 'error', content: '你无权批准此操作' },
    })
    expect(fixture.gate.handleCardAction(click(allow, 'om_card_1'))).toEqual({
      toast: { type: 'success', content: '已允许执行一次' },
    })
    expect(await outcome).toBe('allowed-once')
  })

  it('cancels only one conversation and closes all remaining cards idempotently', async () => {
    const fixture = createFixture()
    const first = turn('session-1', 'one')
    const second = turn('session-2', 'two')
    const firstOutcome = fixture.gate.ask(first, request('session-1'), async () => 'unavailable')
    const secondOutcome = fixture.gate.ask(second, request('session-2'), async () => 'unavailable')
    await vi.waitFor(() => { expect(fixture.sent).toHaveLength(2) })

    await fixture.gate.cancelConversation(first.conversationKey)
    expect(await firstOutcome).toBe('cancelled')
    expect(fixture.updates.map(update => update.messageId)).toEqual(['om_card_1'])

    await fixture.gate.close()
    await fixture.gate.close()
    expect(await secondOutcome).toBe('cancelled')
    expect(fixture.updates.map(update => update.messageId)).toEqual(['om_card_1', 'om_card_2'])
  })
})
