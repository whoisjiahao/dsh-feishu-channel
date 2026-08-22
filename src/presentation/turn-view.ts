/**
 * Minimal render projection for one host turn.
 * @module dsh-feishu-channel/presentation/turn-view
 */

import type {
  AssistantMessageData,
  HostSessionEvent,
  RequestContextData,
  ToolCallData,
  ToolResultData,
  TurnEndData,
} from '../host.ts'
import {
  assistantModel,
  assistantText,
  isAssistantChunkEvent,
  isAssistantMessageEvent,
  isRequestContextEvent,
  isToolCallEvent,
  isToolResultEvent,
  isTurnEndEvent,
  toolResultCallId,
} from '../host.ts'
import { MarkdownStreamFilter } from './markdown.ts'

/** State rendered by one reply card. */
export type TurnViewStatus = 'thinking' | 'in_progress' | 'completed' | 'failed'

/** Token counts used by the card metadata and cost rows. */
export interface TurnTokenUsage {
  /** Cache-miss input tokens; the host already subtracts cache reads. */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Disjoint cache-hit input portion, billed at the hit rate when priced. */
  readonly cacheReadTokens?: number
}

/** One renderable process row. Raw reasoning and tool-result bodies are excluded. */
export type TurnStep =
  | {
      readonly kind: 'reasoning'
      readonly status: 'completed'
      readonly atMs: number
    }
  | {
      readonly kind: 'tool'
      readonly name: string
      status: 'running' | 'completed' | 'failed'
      readonly argumentsJson: string
      atMs: number
    }

/** Context retained before a turn starts. */
export interface InitialTurnContext {
  readonly model?: string | undefined
  readonly contextWindow?: number | undefined
}

/**
 * Fold host events into exactly the state consumed by the Feishu card.
 * The first turn/end event seals the projection; later events are ignored.
 */
export class TurnView {
  status: TurnViewStatus = 'thinking'
  answerText = ''
  model = ''
  readonly startedAt = Date.now()
  finishedAt: number | undefined
  durationMs = 0
  usage: TurnTokenUsage | undefined
  /** When the usage-bearing message arrived: the billing-window anchor. */
  usageAtMs: number | undefined
  contextWindow: number | undefined
  errorCode = ''
  errorMessage = ''

  private readonly stepEntries: TurnStep[] = []
  private readonly toolStepByCallId = new Map<string, Extract<TurnStep, { kind: 'tool' }>>()
  private readonly seenMessages = new Set<string>()
  private readonly answerFilter = new MarkdownStreamFilter()

  constructor(readonly turn: number, initialContext: InitialTurnContext = {}) {
    this.applyContext(initialContext)
  }

  /** Process rows in observation order. */
  get steps(): readonly TurnStep[] {
    return this.stepEntries
  }

  /** Fold one event into the projection. */
  observe(event: HostSessionEvent): void {
    if (this.isTerminal()) return

    if (isRequestContextEvent(event)) {
      this.applyContext(event.data)
      return
    }
    if (isAssistantChunkEvent(event)) {
      if (event.data.turn !== this.turn) return
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && chunk.text !== undefined) {
        this.answerText += this.answerFilter.push(chunk.text)
        this.markInProgress()
      } else if (chunk.type === 'reasoning-delta') {
        this.markInProgress()
      }
      return
    }
    if (isAssistantMessageEvent(event)) {
      if (event.data.turn === this.turn) this.observeAssistantMessage(event.data)
      return
    }
    if (isToolCallEvent(event)) {
      if (event.data.turn === this.turn) this.observeToolCall(event.data)
      return
    }
    if (isToolResultEvent(event)) {
      if (event.data.turn === this.turn) this.observeToolResult(event.data)
      return
    }
    if (isTurnEndEvent(event) && event.data.turn === this.turn) {
      this.finish(event.data)
    }
  }

  private isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'failed'
  }

  private markInProgress(): void {
    if (this.status === 'thinking') this.status = 'in_progress'
  }

  private applyContext(context: InitialTurnContext | RequestContextData): void {
    if (typeof context.model === 'string' && context.model.trim() !== '') {
      this.model = context.model.trim()
    }
    const capacity = context.contextWindow
    if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0) {
      this.contextWindow = Math.floor(capacity)
    }
  }

  private observeAssistantMessage(data: AssistantMessageData): void {
    const identity = messageIdentity(data)
    if (this.seenMessages.has(identity)) return
    this.seenMessages.add(identity)

    const text = assistantText(data)
    if (text !== '') this.answerText = text
    for (const block of data.message.content) {
      if (block.type === 'reasoning' && block.text !== undefined && block.text !== '') {
        this.stepEntries.push({ kind: 'reasoning', status: 'completed', atMs: Date.now() })
      }
    }
    const model = assistantModel(data)
    if (model !== undefined) this.model = model
    if (data.usage !== undefined) {
      this.usage = {
        inputTokens: data.usage.inputTokens ?? 0,
        outputTokens: data.usage.outputTokens ?? 0,
        ...(data.usage.cacheReadTokens !== undefined ? { cacheReadTokens: data.usage.cacheReadTokens } : {}),
      }
      this.usageAtMs = Date.now()
    }
  }

  private observeToolCall(data: ToolCallData): void {
    if (this.toolStepByCallId.has(data.callId)) return
    const step: Extract<TurnStep, { kind: 'tool' }> = {
      kind: 'tool',
      name: data.name,
      status: 'running',
      argumentsJson: data.arguments,
      atMs: Date.now(),
    }
    this.toolStepByCallId.set(data.callId, step)
    this.stepEntries.push(step)
    this.markInProgress()
  }

  private observeToolResult(data: ToolResultData): void {
    const callId = toolResultCallId(data)
    if (callId === undefined) return
    const step = this.toolStepByCallId.get(callId)
    if (step === undefined || step.status !== 'running') return
    step.status = data.error === undefined ? 'completed' : 'failed'
    step.atMs = Date.now()
  }

  private finish(data: TurnEndData): void {
    const finishedAt = Date.now()
    const failed = data.reason.kind === 'error'
    this.finishedAt = finishedAt
    this.durationMs = finishedAt - this.startedAt
    if (!failed) {
      this.status = 'completed'
      return
    }

    this.status = 'failed'
    if (data.reason.error === undefined) return
    this.errorCode = data.reason.error.code ?? ''
    this.errorMessage = data.reason.error.message ?? ''
  }
}

/** Stable replay identity without retaining message text. */
function messageIdentity(data: AssistantMessageData): string {
  if (data.step !== undefined) return 'step:' + data.step
  let hash = 2_166_136_261
  let length = 0
  for (const block of data.message.content) {
    const value = block.type + '\u0000' + (block.text ?? '') + '\u0001'
    length += value.length
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16_777_619)
    }
  }
  return 'content:' + length + ':' + (hash >>> 0)
}
