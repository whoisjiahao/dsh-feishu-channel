/** Feishu channel composition: inbound messages, owned agents, turns, and transport lifecycle. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  NormalizedMessage,
  RejectEvent,
} from '@larksuite/channel'
import { AgentRegistry, type OwnedAgent } from './agent-registry.ts'
import { createApprovalGate, type ApprovalTurn } from './approval-gate.ts'
import { refuseApprovalClick, refuseMessage, type Authorization } from './authorization.ts'
import { commandHelpCard, commandResultCard } from './command-card.ts'
import {
  CHANNEL_COMMANDS,
  commandCatalog,
  EFFORT_COMMAND,
  executeCommand,
  HELP_COMMAND,
  MODEL_COMMAND,
  NEW_COMMAND,
  parseCommandLine,
  RESET_COMMAND,
  type ParsedCommand,
} from './commands.ts'
import type { ResolvedConfig } from './config.ts'
import { createTurnTarget, type ConversationKey } from './conversation.ts'
import type {
  HostAgent,
  HostAgentOptions,
  HostAgentPresets,
  HostAttachments,
  HostCommands,
  HostContentBlock,
  HostDefaultModel,
  HostLoader,
  HostApiResult,
  HostModelApiProxy,
  HostModelController,
  HostModelSelection,
  HostSessionEvent,
  HostSessionPersistence,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './host.ts'
import { isToolCallEvent, isTurnEndEvent } from './host.ts'
import { collectImages, type CollectedImages, type ImagePort } from './images.ts'
import { isCopyErrorAction, isRetryAction, type ToolPresenter } from './presentation/feishu-card.ts'
import {
  createReplyPresenter,
  type ReplyPresenter,
  type ReplyPresenterPort,
} from './presentation/reply-presenter.ts'
import {
  failedModelSettingCard,
  modelSettingActionValue,
  modelSettingCard,
  modelSettingChoices,
  settledModelSettingCard,
  type ModelSettingKind,
} from './model-card.ts'
import { syncSlashPanel, type SlashPanelPort } from './slash-panel.ts'
import { TurnCoordinator, type CoordinatedTurn } from './turn-coordinator.ts'

/** Transport operations consumed by one running channel. */
export interface ChannelPort extends ReplyPresenterPort, ImagePort, SlashPanelPort {
  connect(): Promise<void>
  disconnect(): Promise<void>
  on(name: 'message', handler: (message: NormalizedMessage) => void | Promise<void>): () => void
  on(name: 'cardAction', handler: (event: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>): () => void
  on(name: 'reject', handler: (event: RejectEvent) => void): () => void
  on(name: 'error', handler: (error: LarkChannelError) => void): () => void
  on(name: 'reconnecting', handler: () => void): () => void
  on(name: 'reconnected', handler: () => void): () => void
  updateCard(messageId: string, card: object): Promise<void>
}

interface ConversationBinding {
  readonly key: ConversationKey
  readonly chatId: string
  readonly chatType: string
  readonly owner: OwnedAgent
}

interface PreparedChannel {
  readonly agents: AgentRegistry
  readonly presentCall: ToolPresenter
}

interface PendingModelSetting {
  readonly target: {
    readonly conversationKey: ConversationKey
    readonly chatId: string
    readonly chatType: string
    readonly cardMessageId: string
    readonly sessionId: string
  }
  readonly kind: ModelSettingKind
  readonly choices: ReadonlyMap<string, HostModelSelection>
  readonly controller: HostModelController
}

/** Model-facing layout contract for the frozen reply-card experience. */
export const REPLY_CARD_PROMPT = 'Your final reply is rendered in a compact Feishu card. '
  + 'Use one `##` heading for the outcome. If 2–4 facts materially support it, place a two-column Markdown table '
  + 'headed `关键事实` and `值` immediately below. Put the outcome and next action before an optional '
  + '`### 详细说明`; supporting evidence belongs after that heading. The card already shows tool activity, so omit '
  + 'that transcript from the answer. For every ordered collection, give each item its own physical Markdown line '
  + 'and a strictly increasing `N.` marker, including when the list crosses headings. Do not join items with `·`, '
  + '`、`, or commas, and do not place an ordered list in a fenced block or multi-column text. Before submitting, '
  + 'check: is every ordered item visibly numbered on its own line, and is the outcome understandable without '
  + 'opening `详细说明`?'

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function valueOf<T>(result: HostApiResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.code + ': ' + result.error.message)
}

function createModelController(api: HostModelApiProxy | undefined): HostModelController | undefined {
  if (api === undefined) return undefined
  return {
    async inspect(sessionId) {
      const response = await api.sessions.models({ rpcId: randomUUID(), payload: { sessionId } })
      return valueOf(response.result)
    },
    async select(sessionId, selection) {
      const response = await api.sessions.selectModel({
        rpcId: randomUUID(),
        payload: { sessionId, ...selection },
      })
      return valueOf(response.result).selected
    },
  }
}

function activityLabel(value: string): string {
  const singleLine = value.replace(/[\s`]+/g, ' ').trim()
  return singleLine.length <= 90 ? singleLine : singleLine.slice(0, 89) + '…'
}

function createToolPresentation(tools: HostTools | undefined, scope: unknown): ToolPresenter {
  return (name, argumentsJson) => {
    let argumentsValue: unknown
    try {
      argumentsValue = JSON.parse(argumentsJson)
    } catch {
      return { title: name }
    }
    try {
      const presented = tools?.get(name, scope)?.presentCall?.(argumentsValue)
      if (typeof presented?.title === 'string' && presented.title.trim() !== '') {
        return {
          title: activityLabel(presented.title),
        }
      }
    } catch {
      return { title: name }
    }
    const description = (argumentsValue as { description?: unknown } | null)?.description
    return typeof description === 'string' && description.trim() !== ''
      ? { title: name + ' · ' + activityLabel(description) }
      : { title: name }
  }
}

function composeAgent(agentCtx: Context, config: ResolvedConfig): void {
  const prompt = agentCtx.get('systemPrompt') as HostSystemPrompt | undefined
  const addPrompt = (name: string, order: number, text: string): void => {
    prompt?.section({ name: 'feishu-channel:' + name, order, text })
  }
  addPrompt('reply-card', 149, REPLY_CARD_PROMPT)

  const denied = new Set(config.denyTools)
  if (denied.size === 0) return

  const tools = agentCtx.get('tools') as HostTools | undefined
  tools?.guard(({ name }) => {
    if (!denied.has(name)) return undefined
    return name + ' is unavailable from this chat because its response belongs to another interface. '
      + 'Ask the user in the normal reply and continue after their next message.'
  })
  addPrompt(
    'interaction',
    150,
    'This conversation happens in chat. Put questions and plan-approval requests in the reply; '
      + 'the next user message supplies the answer. Unavailable tools: ' + [...denied].join(', ') + '.',
  )
}

/** Convert one normalized Feishu message into an immutable host user message. */
export function chatUserMessage(message: NormalizedMessage, images: CollectedImages): HostUserMessage {
  const speaker = message.chatType === 'group' ? message.senderName ?? message.senderId : undefined
  const messageText = speaker === undefined ? message.content : speaker + ': ' + message.content
  const transcript = joinTextLines(messageText, images.notes)
  const content: HostContentBlock[] = [...images.blocks]
  if (transcript !== '') content.unshift({ type: 'text', text: transcript })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' as const }),
  })
}

function joinTextLines(first: string, remaining: readonly string[]): string {
  return [first, ...remaining].filter(line => line !== '').join('\n')
}

/** Install one channel and bind every registration to the current plugin fiber. */
export function installChannel(
  ctx: Context,
  config: ResolvedConfig,
  port: ChannelPort,
  notify: (line: string) => void,
  authorization: Authorization,
): void {
  let active = true
  const coordinator = new TurnCoordinator()
  const bindingsBySession = new Map<string, ConversationBinding>()
  const bindingsByKey = new Map<ConversationKey, ConversationBinding>()
  const presentations = new Map<string, { readonly key: ConversationKey; readonly presenter: ReplyPresenter }>()
  const retryCards = new Map<string, { readonly turn: CoordinatedTurn; readonly chatType: string }>()
  const reuseCardForTurn = new Map<string, string>()
  const pendingModelSettings = new Map<string, PendingModelSetting>()
  const commandController = new AbortController()
  const imageController = new AbortController()
  const panelController = new AbortController()
  const imageCollections = new Set<Promise<CollectedImages>>()
  const cwd = resolve(config.cwd)

  const reportSendFailure = (error: unknown): void => {
    const message = detail(error)
    notify('feishu-channel: outbound send failed: ' + message)
    ctx.logger.warn('outbound send failed: %s', message)
  }

  const collectMessageImages = (message: NormalizedMessage): Promise<CollectedImages> => {
    const collection = collectImages(
      message,
      port,
      ctx.get('attachments') as HostAttachments | undefined,
      config.attachImages,
      imageController.signal,
    )
    imageCollections.add(collection)
    collection.then(
      () => { imageCollections.delete(collection) },
      () => { imageCollections.delete(collection) },
    )
    return collection
  }

  const approvals = createApprovalGate({
    port,
    notify,
    refuseCardAction: (subject, pending) => refuseApprovalClick(authorization, subject, pending),
  })

  let prepared: PreparedChannel | undefined
  let preparing: Promise<PreparedChannel> | undefined

  const resolveWorkspace = async (): Promise<HostWorkspace | undefined> => {
    const workspaces = ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
    if (workspaces === undefined) return undefined
    try {
      await mkdir(cwd, { recursive: true })
      return (await workspaces.resolveByPath(cwd)) ?? await workspaces.create(cwd)
    } catch (error) {
      notify('feishu-channel: workspace lookup failed for ' + cwd + ': ' + detail(error))
      return undefined
    }
  }

  const resolveModelSelection = (): HostAgentOptions => {
    if (config.provider !== undefined || config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    const defaults = ctx.get('agentDefaultModel') as HostDefaultModel | undefined
    if (defaults === undefined) {
      throw new Error('feishu-channel: no model configured — set config.provider/model or compose the agentDefaultModel service')
    }
    return defaults.currentSelection()
  }

  const prepare = (): Promise<PreparedChannel> => {
    if (prepared !== undefined) return Promise.resolve(prepared)
    preparing ??= (async () => {
      await (ctx.get('loader') as HostLoader | undefined)?.await()
      if (!active) throw new Error('feishu-channel is closed')
      const presets = ctx.get('agentPresets') as HostAgentPresets | undefined
      const presetId = presets === undefined ? undefined : (await presets.resolve(config.preset)).id
      const toolScope = presets === undefined || presetId === undefined
        ? undefined
        : await presets.standingKeyFor(presetId)
      const workspace = await resolveWorkspace()
      const setup = async (agentCtx: Context): Promise<void> => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        composeAgent(agentCtx, config)
      }
      const agents = new AgentRegistry({
        agents: ctx.agents,
        workspace,
        persistence: ctx.get('sessionPersistence') as HostSessionPersistence | undefined,
        agentOptions: resolveModelSelection(),
        meta: {
          cwd: workspace?.path ?? cwd,
          ...(presetId === undefined ? {} : { agentPreset: presetId }),
        },
        setup,
        report: line => { ctx.logger.info(line) },
      })
      prepared = { agents, presentCall: createToolPresentation(ctx.get('tools') as HostTools | undefined, toolScope) }
      return prepared
    })()
    preparing.catch(() => { preparing = undefined })
    return preparing
  }

  let panelAgent: HostAgent | undefined
  let panelQueue = Promise.resolve()
  const queuePanelSync = (
    desired: readonly { readonly name: string; readonly description: string }[],
    removeUnknown: boolean,
  ): void => {
    if (!config.syncSlashCommands || !active) return
    panelQueue = panelQueue.then(async () => {
      if (!active) return
      const changes = await syncSlashPanel(port, desired, notify, {
        removeUnknown,
        signal: panelController.signal,
      })
      if (changes.added.length > 0) notify('feishu-channel: registered /' + changes.added.join(', /') + ' on the bot slash panel')
      if (changes.removed.length > 0) notify('feishu-channel: removed /' + changes.removed.join(', /') + ' from the bot slash panel')
    }).catch(error => { notify('feishu-channel: slash-command panel sync failed: ' + detail(error)) })
  }

  const publishPanel = (agent: HostAgent): void => {
    panelAgent = agent
    const hosted = (ctx.get('commands') as HostCommands | undefined)?.list(agent) ?? []
    queuePanelSync([...hosted, ...CHANNEL_COMMANDS], true)
  }

  const rememberBinding = (
    owner: OwnedAgent,
    target: ReturnType<typeof createTurnTarget>,
    chatType: string,
  ): ConversationBinding => {
    const previous = bindingsByKey.get(owner.conversationKey)
    if (previous !== undefined && previous.owner.handle.agent.session.id !== owner.handle.agent.session.id) {
      bindingsBySession.delete(previous.owner.handle.agent.session.id)
    }
    const binding = Object.freeze({
      key: owner.conversationKey,
      chatId: target.chatId,
      chatType,
      owner,
    })
    bindingsByKey.set(owner.conversationKey, binding)
    bindingsBySession.set(owner.handle.agent.session.id, binding)
    publishPanel(owner.handle.agent)
    return binding
  }

  const closePresentations = async (key?: ConversationKey): Promise<void> => {
    const closing: Promise<void>[] = []
    for (const [turnId, presentation] of presentations) {
      if (key !== undefined && presentation.key !== key) continue
      presentations.delete(turnId)
      closing.push(presentation.presenter.close().catch(reportSendFailure))
    }
    await Promise.all(closing)
  }

  const approvalTurn = (turn: CoordinatedTurn): ApprovalTurn | undefined => {
    const binding = bindingsByKey.get(turn.target.conversationKey)
    if (binding === undefined) return undefined
    return {
      sessionId: turn.owner.handle.agent.session.id,
      turnId: turn.id,
      conversationKey: turn.target.conversationKey,
      chatId: turn.target.chatId,
      chatType: binding.chatType,
    }
  }

  const forgetConversationCards = (key: ConversationKey): void => {
    const turnIds = new Set<string>()
    for (const [messageId, card] of retryCards) {
      if (card.turn.target.conversationKey !== key) continue
      turnIds.add(card.turn.id)
      retryCards.delete(messageId)
    }
    for (const turnId of turnIds) {
      reuseCardForTurn.delete(turnId)
    }
  }

  const presentationFor = (turn: CoordinatedTurn, presentCall: ToolPresenter): ReplyPresenter => {
    const existing = presentations.get(turn.id)
    if (existing !== undefined) return existing.presenter
    const chatType = bindingsByKey.get(turn.target.conversationKey)?.chatType ?? 'p2p'
    const reusedMessageId = reuseCardForTurn.get(turn.id)
    if (reusedMessageId !== undefined) reuseCardForTurn.delete(turn.id)
    const presenter = createReplyPresenter(port, {
      chatId: turn.target.chatId,
      replyToMessageId: turn.target.replyToMessageId,
      replyInThread: turn.target.replyInThread,
    }, {
      showProcess: config.showProcess,
      maxTimelineItems: config.maxTimelineItems,
      tableOverflowMode: config.tableOverflowMode,
      footerFields: config.footerFields,
      presentCall,
      onFailure: reportSendFailure,
      initialContext: turn.owner.handle.agent.session.requestContext(),
      reuseCardMessageId: reusedMessageId,
      onCardPublished(messageId) {
        retryCards.set(messageId, { turn, chatType })
      },
    })
    presentations.set(turn.id, { key: turn.target.conversationKey, presenter })
    return presenter
  }

  const sendModelSetting = async (
    binding: ConversationBinding,
    kind: ModelSettingKind,
    controller: HostModelController,
  ): Promise<boolean> => {
    const directory = await controller.inspect(binding.owner.handle.agent.session.id)
    const choices = modelSettingChoices(directory, kind)
    if (choices.length === 0) return false
    const id = randomUUID()
    const sent = await port.send(binding.chatId, { card: modelSettingCard(directory, kind, id, choices) })
    for (const [pendingId, pending] of pendingModelSettings) {
      if (pending.target.conversationKey === binding.key && pending.kind === kind) {
        pendingModelSettings.delete(pendingId)
      }
    }
    pendingModelSettings.set(id, {
      target: {
        conversationKey: binding.key,
        chatId: binding.chatId,
        chatType: binding.chatType,
        cardMessageId: sent.messageId,
        sessionId: binding.owner.handle.agent.session.id,
      },
      kind,
      choices: new Map(choices.map(choice => [choice.value, choice.selection])),
      controller,
    })
    return true
  }

  const handleSessionCommand = async (
    message: NormalizedMessage,
    command: ParsedCommand,
    key: ConversationKey,
    target: ReturnType<typeof createTurnTarget>,
    state: PreparedChannel,
  ): Promise<void> => {
    const replacement = await state.agents.reset(key)
    coordinator.clear(key)
    await closePresentations(key)
    forgetConversationCards(key)
    await approvals.cancelConversation(key)
    for (const [id, pending] of pendingModelSettings) {
      if (pending.target.conversationKey === key) pendingModelSettings.delete(id)
    }
    rememberBinding(replacement, target, message.chatType)
    await port.send(message.chatId, {
      card: commandResultCard(command.name, {
        reply: '已新建空白会话，下一条消息将不带入之前的上下文。',
        status: 'success',
      }),
    })
  }

  const handleCommand = async (
    command: ParsedCommand,
    binding: ConversationBinding,
  ): Promise<void> => {
    const controller = createModelController(ctx.get('apiProxy') as HostModelApiProxy | undefined)
    if (
      (command.name === MODEL_COMMAND || command.name === EFFORT_COMMAND)
      && command.input === ''
      && controller !== undefined
    ) {
      if (await sendModelSetting(binding, command.name === MODEL_COMMAND ? 'model' : 'effort', controller)) return
    }
    const commands = ctx.get('commands') as HostCommands | undefined
    const outcome = await executeCommand(command, {
      agent: binding.owner.handle.agent,
      commands,
      signal: commandController.signal,
      models: controller,
    })
    const card = command.name === HELP_COMMAND
      ? commandHelpCard(commandCatalog(commands, binding.owner.handle.agent))
      : commandResultCard(command.name, outcome)
    await port.send(binding.chatId, { card })
  }

  const handleMessage = async (message: NormalizedMessage): Promise<void> => {
    const refusal = refuseMessage(authorization, message)
    if (refusal !== undefined) {
      notify('feishu-channel: ignored a message in ' + message.chatId + ': ' + refusal)
      return
    }
    if (message.senderIsBot === true || message.content.trim() === '') return

    const target = createTurnTarget(config.sessionScope, message)
    const command = parseCommandLine(message.content)
    try {
      const state = await prepare()
      if (command?.name === NEW_COMMAND || command?.name === RESET_COMMAND) {
        await handleSessionCommand(message, command, target.conversationKey, target, state)
        return
      }

      let owner = await state.agents.acquire(target.conversationKey)
      let binding = rememberBinding(owner, target, message.chatType)
      if (command !== undefined) {
        await handleCommand(command, binding)
        return
      }

      const images = await collectMessageImages(message)
      if (!active) return
      if (!state.agents.isCurrent(owner)) {
        owner = await state.agents.acquire(target.conversationKey)
        binding = rememberBinding(owner, target, message.chatType)
      }
      coordinator.submit(owner, target, chatUserMessage(message, images))
    } catch (error) {
      const messageDetail = detail(error)
      notify('feishu-channel: agent creation failed for chat ' + message.chatId + ': ' + messageDetail)
      ctx.logger.warn('agent creation failed for chat %s: %s', message.chatId, messageDetail)
      await port.send(message.chatId, command === undefined
        ? { text: '⚠️ 无法启动会话：' + messageDetail }
        : {
            card: commandResultCard(command.name, {
              reply: '无法启动会话：' + messageDetail,
              status: 'failure',
            }),
          }).catch(reportSendFailure)
    }
  }

  const applyModelSetting = async (
    pending: PendingModelSetting,
    selection: HostModelSelection,
  ): Promise<void> => {
    const target = pending.target
    try {
      if (pending.kind === 'effort') {
        const directory = await pending.controller.inspect(target.sessionId)
        if (directory.current.provider !== selection.provider || directory.current.model !== selection.model) {
          throw new Error('当前模型已变化')
        }
      }
      const selected = await pending.controller.select(target.sessionId, selection)
      await port.updateCard(target.cardMessageId, settledModelSettingCard(pending.kind, selected))
    } catch (error) {
      const message = detail(error)
      notify('feishu-channel: model-setting selection failed: ' + message)
      await port.updateCard(target.cardMessageId, failedModelSettingCard(pending.kind, message))
        .catch(reportSendFailure)
    }
  }

  const handleCardAction = async (event: CardActionEvent): Promise<CardActionResponse | undefined> => {
    if (isCopyErrorAction(event.action.value)) {
      return { toast: { type: 'info', content: event.action.value.text.slice(0, 200) } }
    }
    if (isRetryAction(event.action.value)) {
      const card = retryCards.get(event.messageId)
      if (card === undefined) return { toast: { type: 'info', content: '会话已失效，无法重试' } }
      const refusal = refuseApprovalClick(
        authorization,
        { operatorId: event.operator.openId, chatId: event.chatId },
        { chatId: card.turn.target.chatId, chatType: card.chatType },
      )
      if (refusal !== undefined) {
        notify('feishu-channel: rejected a retry click: ' + refusal)
        return { toast: { type: 'error', content: '你无权操作此会话' } }
      }
      const retried = coordinator.retry(card.turn.target.conversationKey, card.turn.id)
      if (retried === undefined) return { toast: { type: 'info', content: '会话已失效，无法重试' } }
      retryCards.set(event.messageId, { turn: retried, chatType: card.chatType })
      reuseCardForTurn.set(retried.id, event.messageId)
      return { toast: { type: 'success', content: '已重新发起请求' } }
    }

    const action = modelSettingActionValue(event.action.value)
    if (action !== undefined) {
      const pending = pendingModelSettings.get(action.id)
      if (pending === undefined || pending.target.cardMessageId !== event.messageId) {
        return { toast: { type: 'info', content: '该选择卡已失效' } }
      }
      const refusal = refuseApprovalClick(
        authorization,
        { operatorId: event.operator.openId, chatId: event.chatId },
        { chatId: pending.target.chatId, chatType: pending.target.chatType },
      )
      if (refusal !== undefined) {
        notify('feishu-channel: rejected a model-setting click: ' + refusal)
        return { toast: { type: 'error', content: '你无权操作此会话' } }
      }
      const selection = event.action.option === undefined ? undefined : pending.choices.get(event.action.option)
      if (selection === undefined) return { toast: { type: 'error', content: '选项无效，请重新输入命令' } }
      pendingModelSettings.delete(action.id)
      void applyModelSetting(pending, selection)
      const content = pending.kind === 'model' ? '正在切换模型' : '正在调整推理强度'
      return { toast: { type: 'info', content } }
    }
    return approvals.handleCardAction(event)
  }

  const reportRejectedEvent = (event: RejectEvent): void => {
    if (event.reason === 'no_mention') {
      ctx.logger.debug('rejected %s in %s: %s', event.messageId, event.chatId, event.reason)
      return
    }
    ctx.logger.info('rejected %s in %s from %s: %s', event.messageId, event.chatId, event.senderId, event.reason)
    if (event.reason === 'bot_loop') {
      notify('feishu-channel: bot loop guard tripped in chat ' + event.chatId + ' — traffic from bots is being refused')
    }
  }
  const reportTransportError = (error: LarkChannelError): void => {
    notify('feishu-channel: transport error [' + error.code + ']: ' + error.message)
    ctx.logger.warn('transport error [%s]: %s', error.code, error.message)
  }
  const reportReconnecting = (): void => {
    notify('feishu-channel: connection lost, reconnecting — events arriving now are not replayed')
    ctx.logger.warn('connection lost, reconnecting')
  }
  const reportReconnected = (): void => {
    notify('feishu-channel: connection restored')
    ctx.logger.info('connection restored')
  }

  ctx.effect(() => port.on('message', handleMessage), 'feishu:on(message)')
  ctx.effect(() => port.on('cardAction', handleCardAction), 'feishu:on(cardAction)')
  ctx.effect(() => port.on('reject', reportRejectedEvent), 'feishu:on(reject)')
  ctx.effect(() => port.on('error', reportTransportError), 'feishu:on(error)')
  ctx.effect(() => port.on('reconnecting', reportReconnecting), 'feishu:on(reconnecting)')
  ctx.effect(() => port.on('reconnected', reportReconnected), 'feishu:on(reconnected)')

  ctx.on('commands/change', () => {
    if (panelAgent !== undefined) publishPanel(panelAgent)
  })

  ctx.on('session/event', (session, event: HostSessionEvent) => {
    const turn = coordinator.route(session.id, event)
    if (turn === undefined || prepared === undefined || !prepared.agents.ownsSession(session.id)) return
    const approvalOwner = approvalTurn(turn)
    if (isToolCallEvent(event) && approvalOwner !== undefined) {
      approvals.recordToolCall(approvalOwner, event.data.callId, event.data.arguments)
    }
    const presenter = presentationFor(turn, prepared.presentCall)
    presenter.observe(event)
    if (isTurnEndEvent(event)) {
      if (approvalOwner !== undefined) approvals.finishTurn(approvalOwner)
      void presenter.close().finally(() => { presentations.delete(turn.id) })
    }
  })

  ctx.on('approval/request', (request, next) => {
    if (prepared?.agents.ownsSession(request.agent.session.id) !== true) return next()
    const turn = coordinator.current(request.agent.session.id)
    if (turn === undefined) return next()
    const owner = approvalTurn(turn)
    return owner === undefined ? next() : approvals.ask(owner, request, next)
  }, { prepend: true })

  ctx.effect(() => () => {
    active = false
    commandController.abort()
    imageController.abort()
    panelController.abort()
    coordinator.close()
    bindingsBySession.clear()
    bindingsByKey.clear()
    pendingModelSettings.clear()
    retryCards.clear()
    reuseCardForTurn.clear()
    const closeAgents = prepared !== undefined
      ? prepared.agents.close()
      : preparing?.then(state => state.agents.close(), () => undefined)
    return Promise.allSettled([
      closePresentations(),
      approvals.close(),
      Promise.allSettled([...imageCollections]),
      panelQueue,
      ...(closeAgents === undefined ? [] : [closeAgents]),
    ]).then(() => undefined)
  }, 'feishu:channel')

  ctx.effect(() => {
    let connected = false
    const connection = port.connect().then(() => {
      connected = true
      if (active) queuePanelSync(CHANNEL_COMMANDS, false)
    }).catch(error => {
      notify('feishu-channel: connect failed: ' + detail(error))
      ctx.logger.error('feishu channel connect failed: %s', error)
    })
    return async () => {
      active = false
      await connection
      if (connected) await port.disconnect().catch(reportSendFailure)
    }
  }, 'feishu:connect')
}
