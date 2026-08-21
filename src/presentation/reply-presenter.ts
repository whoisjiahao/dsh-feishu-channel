/** Owns card publication for one immutable Feishu reply target. */

import type { SendInput, SendOptions, SendResult } from '@larksuite/channel'
import type { HostSessionEvent, RequestContextData } from '../host.ts'
import { isRequestContextEvent, isTurnEndEvent } from '../host.ts'
import {
  renderCard,
  renderHandoffCard,
  type CardRenderOptions,
} from './feishu-card.ts'
import { TurnView, type InitialTurnContext } from './turn-view.ts'

const UPDATE_INTERVAL_MS = 350
const TOOL_CALL_BLOCK = /<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/g
const TOOL_CALL_NOTICE = '\n\n⚠️ 模型输出了未被识别的工具调用标记，已省略——通常意味着本次请求没有可用工具。'

/** Transport operations required to publish one reply. */
export interface ReplyPresenterPort {
  send(to: string, input: SendInput, options?: SendOptions): Promise<SendResult>
  updateCard(messageId: string, card: object): Promise<void>
}

/** Immutable destination captured when a turn is coordinated. */
export interface ReplyDestination {
  readonly chatId: string
  readonly replyToMessageId: string
  readonly replyInThread: boolean
}

/** Publication controls in addition to the card's visual options. */
export interface ReplyPresenterOptions extends CardRenderOptions {
  readonly onFailure: (error: unknown) => void
  readonly initialContext?: RequestContextData | undefined
  readonly reuseCardMessageId?: string | undefined
  readonly onCardPublished?: ((messageId: string) => void) | undefined
}

/** One turn-bound presenter. */
export interface ReplyPresenter {
  observe(event: HostSessionEvent): void
  close(): Promise<void>
}

/** Create a presenter whose destination cannot be retargeted later. */
export function createReplyPresenter(
  port: ReplyPresenterPort,
  destination: ReplyDestination,
  options: ReplyPresenterOptions,
): ReplyPresenter {
  return new TurnReplyPresenter(port, destination, options)
}

class TurnReplyPresenter implements ReplyPresenter {
  private readonly chatId: string
  private readonly sendOptions: SendOptions
  private readonly cardOptions: CardRenderOptions
  private context: InitialTurnContext
  private view: TurnView | undefined
  private messageId: string | undefined
  private writes = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private cardUnavailable = false
  private nativeAnswerSent = false
  private closed = false
  private finalization: Promise<void> | undefined
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly port: ReplyPresenterPort,
    destination: ReplyDestination,
    private readonly options: ReplyPresenterOptions,
  ) {
    this.chatId = destination.chatId
    this.sendOptions = {
      replyTo: destination.replyToMessageId,
      ...(destination.replyInThread ? { replyInThread: true } : {}),
    }
    this.cardOptions = options
    this.messageId = options.reuseCardMessageId
    this.context = contextSnapshot(options.initialContext)
  }

  observe(event: HostSessionEvent): void {
    if (this.closed) return
    if (isRequestContextEvent(event)) {
      this.context = contextSnapshot(event.data)
      if (this.view !== undefined) {
        this.view.observe(event)
        this.schedule()
      }
      return
    }

    const turn = eventTurn(event)
    if (turn === undefined) return
    this.view ??= new TurnView(turn, this.context)
    if (this.view.turn !== turn) return
    this.view.observe(event)

    if (isTurnEndEvent(event)) {
      void this.finalize()
    } else {
      this.schedule()
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce()
    return this.closePromise
  }

  private async closeOnce(): Promise<void> {
    this.closed = true
    this.clearTimer()
    if (this.view?.status === 'completed' || this.view?.status === 'failed') {
      await this.finalize()
    } else {
      await this.writes
    }
  }

  private schedule(): void {
    if (this.closed || this.cardUnavailable) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { void this.flush() }, UPDATE_INTERVAL_MS)
  }

  private async flush(): Promise<void> {
    this.timer = undefined
    const view = this.view
    if (this.closed || !this.dirty || view === undefined || this.cardUnavailable) return
    this.dirty = false
    const result = renderCard(view, this.cardOptions)
    if (result.disposition === 'native') {
      this.cardUnavailable = true
      return
    }
    await this.publishCard(result.card)
  }

  private finalize(): Promise<void> {
    this.finalization ??= this.finalizeOnce()
    return this.finalization
  }

  private async finalizeOnce(): Promise<void> {
    this.clearTimer()
    this.dirty = false
    const view = this.view
    if (view === undefined) return
    const result = renderCard(view, this.cardOptions)

    if (result.disposition === 'card' && !this.cardUnavailable) {
      await this.publishCard(result.card)
      if (!this.cardUnavailable) return
    } else {
      await this.writes
    }

    await this.publishHandoffIfNeeded()
    await this.publishNativeAnswer(view.answerText)
  }

  private publishCard(card: object): Promise<void> {
    this.writes = this.writes.then(async () => {
      if (this.cardUnavailable) return
      try {
        if (this.messageId === undefined) {
          const sent = await this.port.send(this.chatId, { card }, this.sendOptions)
          this.messageId = sent.messageId
        } else {
          await this.port.updateCard(this.messageId, card)
        }
        this.options.onCardPublished?.(this.messageId)
      } catch (error) {
        this.cardUnavailable = true
        this.options.onFailure(error)
      }
    })
    return this.writes
  }

  private async publishHandoffIfNeeded(): Promise<void> {
    await this.writes
    if (this.messageId === undefined) return
    try {
      await this.port.updateCard(this.messageId, renderHandoffCard(true))
      this.options.onCardPublished?.(this.messageId)
    } catch (error) {
      this.options.onFailure(error)
    }
  }

  private async publishNativeAnswer(answer: string): Promise<void> {
    if (this.nativeAnswerSent) return
    this.nativeAnswerSent = true
    const text = stripToolCallMarkup(answer).trim()
    if (text === '') return
    await this.port.send(this.chatId, { markdown: text }, this.sendOptions).catch(this.options.onFailure)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** Remove model-emitted pseudo tool calls before a native fallback is sent. */
export function stripToolCallMarkup(text: string): string {
  const stripped = text.replace(TOOL_CALL_BLOCK, '')
  if (stripped === text) return text
  return stripped.trimEnd() + TOOL_CALL_NOTICE
}

function eventTurn(event: HostSessionEvent): number | undefined {
  if (typeof event.data !== 'object' || event.data === null) return undefined
  const turn = (event.data as { readonly turn?: unknown }).turn
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : undefined
}

function contextSnapshot(context: RequestContextData | undefined): InitialTurnContext {
  if (context === undefined) return {}
  const model = context.model.trim()
  const capacity = context.contextWindow
  return {
    ...(model === '' ? {} : { model }),
    ...(typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
      ? { contextWindow: Math.floor(capacity) }
      : {}),
  }
}
