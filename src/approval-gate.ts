/** Owned-turn approval questions rendered and settled through Feishu cards. */

import { randomUUID } from 'node:crypto'
import type { CardActionEvent, CardActionResponse, SendInput, SendResult } from '@larksuite/channel'
import type { ConversationKey } from './conversation.ts'
import type { HostApprovalOutcome, HostApprovalRequest } from './host.ts'
import {
  interactiveCard,
  interactiveDivider,
  interactiveFieldRow,
  interactivePlainSection,
  interactiveStatusLine,
} from './card-design.ts'
import type { CardTone } from './card-tokens.ts'
import { redactSensitiveText } from './presentation/sensitive-text.ts'

/** Marker distinguishing this plugin's approval actions. */
export const APPROVAL_ACTION = 'dsh-feishu-channel/approval'

/** Exact owned turn allowed to surface one host approval in Feishu. */
export interface ApprovalTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly conversationKey: ConversationKey
  readonly chatId: string
  readonly chatType: string
}

/** One visible approval awaiting a decision. */
export interface PendingApproval {
  readonly conversationKey: ConversationKey
  readonly chatId: string
  readonly chatType: string
  readonly messageId: string
  readonly toolName: string
}

interface ApprovalActionValue {
  readonly kind: typeof APPROVAL_ACTION
  readonly id: string
  readonly decision: 'allow' | 'reject'
}

interface PendingQuestion extends PendingApproval {
  readonly removeAbortListener: () => void
  readonly resolve: (outcome: HostApprovalOutcome) => void
}

interface RecordedCall {
  readonly owner: ApprovalTurn
  readonly argumentsText: string
}

interface SendingQuestion {
  readonly owner: ApprovalTurn
  readonly done: Promise<void>
  cancel(): void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function actionValue(value: unknown): ApprovalActionValue | undefined {
  const payload = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
  if (payload?.kind !== APPROVAL_ACTION || typeof payload.id !== 'string') return undefined
  switch (payload.decision) {
    case 'allow':
    case 'reject':
      return { kind: APPROVAL_ACTION, id: payload.id, decision: payload.decision }
    default:
      return undefined
  }
}

/** Frozen pending approval card. Dynamic values are literal plain text. */
export function approvalCard(
  toolName: string,
  reason: string | undefined,
  command: string | undefined,
  id: string,
): object {
  const safeTool = redactSensitiveText(toolName, 120)
  const safeReason = reason === undefined ? undefined : redactSensitiveText(reason)
  const safeCommand = command === undefined ? undefined : redactSensitiveText(command)
  const content: object[] = [
    interactiveStatusLine('操作审批', '待确认', 'warning'),
    interactiveDivider(),
    interactiveFieldRow('工具', safeTool),
    ...(safeCommand === undefined ? [] : interactivePlainSection('将执行', safeCommand)),
    ...(safeReason === undefined || safeReason === '' ? [] : interactivePlainSection('模型说明', safeReason)),
  ]
  content.push(
    approvalNotice('批准前请确认上面的内容确实是你要执行的。'),
    {
      tag: 'action',
      actions: [
        approvalButton('允许一次', 'primary', id, 'allow'),
        approvalButton('拒绝', 'danger', id, 'reject'),
      ],
    },
  )
  return interactiveCard(content)
}

function approvalNotice(content: string): object {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}

function approvalButton(
  label: string,
  type: 'primary' | 'danger',
  id: string,
  decision: ApprovalActionValue['decision'],
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { kind: APPROVAL_ACTION, id, decision },
  }
}

const SETTLED_LOOK: Record<HostApprovalOutcome, { readonly status: string; readonly tone: CardTone }> = {
  'allowed-once': { status: '已允许', tone: 'success' },
  'rejected': { status: '已拒绝', tone: 'failure' },
  'cancelled': { status: '已撤回', tone: 'neutral' },
  'unavailable': { status: '不可用', tone: 'neutral' },
}

/** Frozen terminal approval card. */
export function settledCard(toolName: string, outcome: HostApprovalOutcome, decidedBy?: string): object {
  const look = SETTLED_LOOK[outcome]
  return interactiveCard([
    interactiveStatusLine('操作审批', look.status, look.tone),
    interactiveDivider(),
    interactiveFieldRow('工具', redactSensitiveText(toolName, 120)),
    ...(decidedBy === undefined
      ? []
      : [{
          tag: 'note',
          elements: [{ tag: 'plain_text', content: '操作人：' + redactSensitiveText(decidedBy, 120) }],
        }]),
  ])
}

/** Dependencies and policy callback owned by one approval gate. */
export interface ApprovalGateOptions {
  readonly port: {
    send(to: string, input: SendInput): Promise<SendResult>
    updateCard(messageId: string, card: object): Promise<void>
  }
  readonly notify: (line: string) => void
  readonly refuseCardAction: (
    subject: { readonly operatorId: string; readonly chatId: string },
    pending: PendingApproval,
  ) => string | undefined
  readonly createId?: (() => string) | undefined
}

/** Approval lifecycle scoped to Feishu-submitted owned turns. */
export interface ApprovalGate {
  recordToolCall(owner: ApprovalTurn, callId: string, argumentsText: string): void
  finishTurn(owner: ApprovalTurn): void
  ask(
    owner: ApprovalTurn,
    request: HostApprovalRequest,
    next: () => Promise<HostApprovalOutcome>,
  ): Promise<HostApprovalOutcome>
  handleCardAction(event: CardActionEvent): CardActionResponse | undefined
  cancelConversation(key: ConversationKey): Promise<void>
  close(): Promise<void>
}

/** Create a gate with exact owner, call, card, and cancellation correlation. */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const callsBySession = new Map<string, Map<string, RecordedCall>>()
  const pending = new Map<string, PendingQuestion>()
  const sending = new Map<string, SendingQuestion>()
  let closed = false
  let closing: Promise<void> | undefined

  const reportUpdateFailure = (error: unknown): void => {
    options.notify('feishu-channel: outbound send failed: ' + (error instanceof Error ? error.message : String(error)))
  }

  const updateTerminalCard = async (
    question: Pick<PendingApproval, 'messageId' | 'toolName'>,
    outcome: HostApprovalOutcome,
    decidedBy?: string,
  ): Promise<void> => {
    await options.port.updateCard(
      question.messageId,
      settledCard(question.toolName, outcome, decidedBy),
    ).catch(reportUpdateFailure)
  }

  const settle = (
    id: string,
    outcome: HostApprovalOutcome,
    decidedBy?: string,
  ): Promise<void> | undefined => {
    const question = pending.get(id)
    if (question === undefined) return undefined
    pending.delete(id)
    question.removeAbortListener()
    question.resolve(outcome)
    return updateTerminalCard(question, outcome, decidedBy)
  }

  const ask = async (
    owner: ApprovalTurn,
    request: HostApprovalRequest,
    next: () => Promise<HostApprovalOutcome>,
  ): Promise<HostApprovalOutcome> => {
    if (request.agent.session.id !== owner.sessionId) return next()
    if (closed) return 'cancelled'
    if (request.signal?.aborted === true) return 'cancelled'

    const id = options.createId?.() ?? randomUUID()
    const cancellation = deferred<void>()
    const finished = deferred<void>()
    let cancelled = false
    let abortListenerInstalled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      cancellation.resolve(undefined)
      void settle(id, 'cancelled')
    }
    const removeAbortListener = (): void => {
      if (!abortListenerInstalled) return
      request.signal?.removeEventListener('abort', cancel)
      abortListenerInstalled = false
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', cancel, { once: true })
      abortListenerInstalled = true
      if (request.signal.aborted) cancel()
    }

    const sendingQuestion: SendingQuestion = { owner, done: finished.promise, cancel }
    sending.set(id, sendingQuestion)
    const call = request.callId === undefined ? undefined : callsBySession.get(owner.sessionId)?.get(request.callId)
    const command = call?.owner.turnId === owner.turnId ? call.argumentsText : undefined
    const sendAttempt = options.port.send(owner.chatId, {
      card: approvalCard(request.toolName, request.reason, command, id),
    })
    const result = await Promise.race([
      sendAttempt.then(
        sent => ({ kind: 'sent' as const, sent }),
        error => ({ kind: 'failed' as const, error }),
      ),
      cancellation.promise.then(() => ({ kind: 'cancelled' as const })),
    ])

    if (result.kind === 'cancelled') {
      void sendAttempt.then(
        sent => updateTerminalCard({ messageId: sent.messageId, toolName: request.toolName }, 'cancelled'),
        () => undefined,
      ).finally(() => {
        removeAbortListener()
        sending.delete(id)
        finished.resolve(undefined)
      })
      return 'cancelled'
    }

    sending.delete(id)
    finished.resolve(undefined)
    if (result.kind === 'failed') {
      removeAbortListener()
      options.notify('feishu-channel: outbound send failed: ' + (result.error instanceof Error
        ? result.error.message
        : String(result.error)))
      return cancelled ? 'cancelled' : next()
    }
    if (cancelled || closed) {
      removeAbortListener()
      await updateTerminalCard({ messageId: result.sent.messageId, toolName: request.toolName }, 'cancelled')
      return 'cancelled'
    }

    return new Promise<HostApprovalOutcome>((resolve) => {
      pending.set(id, {
        conversationKey: owner.conversationKey,
        chatId: owner.chatId,
        chatType: owner.chatType,
        messageId: result.sent.messageId,
        toolName: request.toolName,
        removeAbortListener,
        resolve,
      })
    })
  }

  const cancelConversation = async (key: ConversationKey): Promise<void> => {
    const work: Promise<void>[] = []
    for (const question of sending.values()) {
      if (question.owner.conversationKey !== key) continue
      question.cancel()
      work.push(question.done)
    }
    for (const [id, question] of [...pending]) {
      if (question.conversationKey !== key) continue
      const update = settle(id, 'cancelled')
      if (update !== undefined) work.push(update)
    }
    for (const [sessionId, calls] of callsBySession) {
      for (const [callId, call] of calls) {
        if (call.owner.conversationKey === key) calls.delete(callId)
      }
      if (calls.size === 0) callsBySession.delete(sessionId)
    }
    await Promise.allSettled(work)
  }

  return {
    recordToolCall(owner, callId, argumentsText) {
      const calls = callsBySession.get(owner.sessionId) ?? new Map<string, RecordedCall>()
      calls.set(callId, { owner, argumentsText })
      callsBySession.set(owner.sessionId, calls)
    },
    finishTurn(owner) {
      const calls = callsBySession.get(owner.sessionId)
      if (calls === undefined) return
      for (const [callId, call] of calls) {
        if (call.owner.turnId === owner.turnId) calls.delete(callId)
      }
      if (calls.size === 0) callsBySession.delete(owner.sessionId)
    },
    ask,
    handleCardAction(event) {
      const action = actionValue(event.action.value)
      if (action === undefined) return undefined
      const question = pending.get(action.id)
      if (question === undefined || question.messageId !== event.messageId) {
        return { toast: { type: 'info', content: '该审批已失效' } }
      }
      const refusal = options.refuseCardAction(
        { operatorId: event.operator.openId, chatId: event.chatId },
        question,
      )
      if (refusal !== undefined) {
        options.notify('feishu-channel: rejected an approval click: ' + refusal)
        return { toast: { type: 'error', content: '你无权批准此操作' } }
      }
      const outcome: HostApprovalOutcome = action.decision === 'allow' ? 'allowed-once' : 'rejected'
      void settle(action.id, outcome, event.operator.name ?? event.operator.openId)
      return {
        toast: {
          type: action.decision === 'allow' ? 'success' : 'info',
          content: action.decision === 'allow' ? '已允许执行一次' : '已拒绝',
        },
      }
    },
    cancelConversation,
    close() {
      if (closing !== undefined) return closing
      closed = true
      closing = (async () => {
        const work: Promise<void>[] = []
        for (const question of sending.values()) {
          question.cancel()
          work.push(question.done)
        }
        for (const id of [...pending.keys()]) {
          const update = settle(id, 'cancelled')
          if (update !== undefined) work.push(update)
        }
        callsBySession.clear()
        await Promise.allSettled(work)
      })()
      return closing
    },
  }
}
