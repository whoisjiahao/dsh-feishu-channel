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
  ResourceDescriptor,
} from '@larksuite/channel'
import { AgentRegistry, type OwnedAgent } from './agent-registry.ts'
import { createApprovalGate, type ApprovalTurn } from './approval-gate.ts'
import { refuseApprovalClick, refuseMessage, type Authorization } from './authorization.ts'
import {
  cancelledCommandCard,
  COMMAND_INPUT_NAME,
  commandFormActionId,
  commandHelpCard,
  commandInteractionActionValue,
  commandPromptCard,
  commandResultCard,
} from './command-card.ts'
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
  HostCommandDescriptor,
  HostContentBlock,
  HostDefaultModel,
  HostLoader,
  HostSessionController,
  HostSessionProjectionValues,
  HostSessionSnapshotFrame,
  HostModelController,
  HostModelSelection,
  HostPermissionSelect,
  HostSessionEvent,
  HostSessionPersistence,
  HostSystemPrompt,
  HostTools,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
  HostLlm,
} from './host.ts'
import { isToolCallEvent, isTurnEndEvent } from './host.ts'
import { collectImages, emptyCollection, noteOnly, type CollectedImages, type ImagePort } from './images.ts'
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
import {
  failedPermissionSettingCard,
  FULL_ACCESS_PERMISSION,
  permissionConfirmationCard,
  permissionSettingActionValue,
  permissionSettingCard,
  permissionSettingChoices,
  settledPermissionSettingCard,
  type PermissionSettingChoice,
} from './permission-card.ts'
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
  readonly target: InteractionTarget
  readonly kind: ModelSettingKind
  readonly choices: ReadonlyMap<string, HostModelSelection>
  readonly controller: HostModelController
}

interface InteractionTarget {
  readonly conversationKey: ConversationKey
  readonly chatId: string
  readonly chatType: string
  readonly cardMessageId: string
  readonly sessionId: string
}

type PendingCommandInteraction =
  | {
    readonly kind: 'menu'
    readonly target: InteractionTarget
    readonly commands: ReadonlyMap<string, HostCommandDescriptor>
  }
  | {
    readonly kind: 'prompt'
    readonly target: InteractionTarget
    readonly command: HostCommandDescriptor
  }

interface PendingPermissionSetting {
  readonly target: InteractionTarget
  readonly select: HostPermissionSelect
  readonly choices: ReadonlyMap<string, PermissionSettingChoice>
  readonly confirmation?: PermissionSettingChoice | undefined
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

/**
 * Read one session's projection baseline from the follow stream's opening
 * snapshot and close the stream. The web client consumes the same baseline
 * through its live connection; a one-shot read keeps the channel's
 * interactive cards free of stream lifecycle.
 */
async function readProjection(
  controller: HostSessionController,
  sessionId: string,
): Promise<HostSessionProjectionValues> {
  const lifetime = new AbortController()
  const iterator = controller
    .follow({ address: { kind: 'session', sessionId } }, lifetime.signal)
    [Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done === true) throw new Error('当前会话没有可用的投影基线。')
    const frame = first.value as HostSessionSnapshotFrame
    if (frame.type !== 'snapshot' || frame.projections === undefined) {
      throw new Error('当前会话没有可用的投影基线。')
    }
    return frame.projections.values
  } finally {
    lifetime.abort()
    void iterator.return?.(undefined)
  }
}

function createModelController(controller: HostSessionController | undefined): HostModelController | undefined {
  if (controller === undefined) return undefined
  return {
    async inspect(sessionId) {
      const [catalog, values] = await Promise.all([
        controller.modelCatalog(),
        readProjection(controller, sessionId).catch(() => undefined),
      ])
      // Web parity: the pending selection wins, else the deployment default
      // serves unconfigured sessions.
      const current = values?.modelSelection?.next ?? catalog.default
      return { current, groups: catalog.groups }
    },
    async select(sessionId, selection) {
      const { selected } = await controller.selectModel({
        sessionId,
        ...selection,
      })
      return selected
    },
  }
}

async function inspectPermissions(
  controller: HostSessionController | undefined,
  sessionId: string,
): Promise<HostPermissionSelect> {
  if (controller === undefined) throw new Error('当前部署没有会话权限投影服务。')
  const values = await readProjection(controller, sessionId)
  const permissions = values.permissions
  if (permissions === undefined) throw new Error('当前会话没有可用的权限预设。')
  return permissions
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
  addPrompt('reply-card', -790, REPLY_CARD_PROMPT)

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
    -780,
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
  const pendingCommandInteractions = new Map<string, PendingCommandInteraction>()
  const pendingPermissionSettings = new Map<string, PendingPermissionSetting>()
  const commandOperations = new Set<Promise<void>>()
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

  const collectMessageImages = (message: NormalizedMessage, binding: ConversationBinding): Promise<CollectedImages> => {
    const collection = admitAndCollectImages(message, binding)
    imageCollections.add(collection)
    collection.then(
      () => { imageCollections.delete(collection) },
      () => { imageCollections.delete(collection) },
    )
    return collection
  }

  /**
   * Image admission mirrors the web send path: refuse only when the session's
   * current model is KNOWN to lack image input (resolved modalities present
   * without 'image'); an unknown model, unknown modalities, or a failed
   * lookup admit, leaving the provider as the final authority.
   */
  const admitAndCollectImages = async (
    message: NormalizedMessage,
    binding: ConversationBinding,
  ): Promise<CollectedImages> => {
    const hasImages = message.resources.some((resource: ResourceDescriptor) => resource.type === 'image')
    if (!hasImages) return emptyCollection()

    const context = binding.owner.handle.agent.session.requestContext()
    const llm = ctx.get('llm') as HostLlm | undefined
    if (context?.provider !== undefined && context.model !== undefined && llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(context.provider, context.model)
        if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
          return noteOnly(
            '（用户发送了 ' + message.resources.filter((resource: ResourceDescriptor) => resource.type === 'image').length
            + ' 张图片：当前模型 ' + context.model + ' 不支持图片输入，未传递图片；可用 /model 切换视觉模型后重发）',
          )
        }
      } catch {
        // Lookup failure admits, exactly like unknown modalities in the web path.
      }
    }
    return collectImages(
      message,
      port,
      ctx.get('attachments') as HostAttachments | undefined,
      true,
      imageController.signal,
    )
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
    target: { readonly conversationKey: ConversationKey; readonly chatId: string },
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

  const forgetCommandInteractions = (key: ConversationKey): void => {
    for (const [id, pending] of pendingCommandInteractions) {
      if (pending.target.conversationKey === key) pendingCommandInteractions.delete(id)
    }
    for (const [id, pending] of pendingPermissionSettings) {
      if (pending.target.conversationKey === key) pendingPermissionSettings.delete(id)
    }
  }

  const trackCommandOperation = (operation: Promise<void>): void => {
    commandOperations.add(operation)
    const retire = (): void => { commandOperations.delete(operation) }
    operation.then(retire, retire)
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
      pricing: config.pricing,
      offPeakWindows: config.offPeakWindows,
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
    cardMessageId?: string,
  ): Promise<boolean> => {
    const directory = await controller.inspect(binding.owner.handle.agent.session.id)
    const choices = modelSettingChoices(directory, kind)
    if (choices.length === 0) return false
    const id = randomUUID()
    const card = modelSettingCard(directory, kind, id, choices)
    const messageId = cardMessageId ?? (await port.send(binding.chatId, { card })).messageId
    if (cardMessageId !== undefined) await port.updateCard(cardMessageId, card)
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
        cardMessageId: messageId,
        sessionId: binding.owner.handle.agent.session.id,
      },
      kind,
      choices: new Map(choices.map(choice => [choice.value, choice.selection])),
      controller,
    })
    return true
  }

  const interactionTarget = (
    binding: ConversationBinding,
    cardMessageId: string,
  ): InteractionTarget => ({
    conversationKey: binding.key,
    chatId: binding.chatId,
    chatType: binding.chatType,
    cardMessageId,
    sessionId: binding.owner.handle.agent.session.id,
  })

  const publishInteractionCard = async (
    binding: ConversationBinding,
    card: object,
    cardMessageId?: string,
  ): Promise<InteractionTarget> => {
    const messageId = cardMessageId ?? (await port.send(binding.chatId, { card })).messageId
    if (cardMessageId !== undefined) await port.updateCard(cardMessageId, card)
    return interactionTarget(binding, messageId)
  }

  const sendCommandMenu = async (
    binding: ConversationBinding,
    cardMessageId?: string,
  ): Promise<void> => {
    const commands = ctx.get('commands') as HostCommands | undefined
    const catalog = commandCatalog(commands, binding.owner.handle.agent)
    const id = randomUUID()
    const target = await publishInteractionCard(binding, commandHelpCard(catalog, id), cardMessageId)
    for (const [pendingId, pending] of pendingCommandInteractions) {
      if (pending.target.conversationKey === binding.key) pendingCommandInteractions.delete(pendingId)
    }
    pendingCommandInteractions.set(id, {
      kind: 'menu',
      target,
      commands: new Map(catalog.map(command => [command.name, command])),
    })
  }

  const sendCommandPrompt = async (
    binding: ConversationBinding,
    command: HostCommandDescriptor,
    cardMessageId?: string,
  ): Promise<void> => {
    const id = randomUUID()
    const target = await publishInteractionCard(binding, commandPromptCard(command, id), cardMessageId)
    for (const [pendingId, pending] of pendingCommandInteractions) {
      if (pending.target.conversationKey === binding.key) pendingCommandInteractions.delete(pendingId)
    }
    pendingCommandInteractions.set(id, { kind: 'prompt', target, command })
  }

  const sendSessionCommandPrompt = async (
    target: ReturnType<typeof createTurnTarget>,
    chatType: string,
    command: HostCommandDescriptor,
  ): Promise<void> => {
    const id = randomUUID()
    const sent = await port.send(target.chatId, { card: commandPromptCard(command, id) })
    for (const [pendingId, pending] of pendingCommandInteractions) {
      if (pending.target.conversationKey === target.conversationKey) {
        pendingCommandInteractions.delete(pendingId)
      }
    }
    pendingCommandInteractions.set(id, {
      kind: 'prompt',
      target: {
        conversationKey: target.conversationKey,
        chatId: target.chatId,
        chatType,
        cardMessageId: sent.messageId,
        sessionId: bindingsByKey.get(target.conversationKey)?.owner.handle.agent.session.id ?? '',
      },
      command,
    })
  }

  const sendPermissionSetting = async (
    binding: ConversationBinding,
    cardMessageId?: string,
  ): Promise<void> => {
    const select = await inspectPermissions(
      ctx.get('sessionController') as HostSessionController | undefined,
      binding.owner.handle.agent.session.id,
    )
    const choices = permissionSettingChoices(select)
    if (choices.length === 0) throw new Error('当前会话没有可切换的权限预设。')
    const id = randomUUID()
    const target = await publishInteractionCard(
      binding,
      permissionSettingCard(select, id, choices),
      cardMessageId,
    )
    for (const [pendingId, pending] of pendingPermissionSettings) {
      if (pending.target.conversationKey === binding.key) pendingPermissionSettings.delete(pendingId)
    }
    pendingPermissionSettings.set(id, {
      target,
      select,
      choices: new Map(choices.map(choice => [choice.value, choice])),
    })
  }

  const openCommandInteraction = async (
    binding: ConversationBinding,
    command: HostCommandDescriptor,
    cardMessageId?: string,
  ): Promise<void> => {
    if (command.name === HELP_COMMAND) {
      await sendCommandMenu(binding, cardMessageId)
      return
    }
    if (command.name === MODEL_COMMAND || command.name === EFFORT_COMMAND) {
      const controller = createModelController(ctx.get('sessionController') as HostSessionController | undefined)
      if (controller === undefined) throw new Error('当前部署没有会话模型控制服务。')
      const sent = await sendModelSetting(
        binding,
        command.name === MODEL_COMMAND ? 'model' : 'effort',
        controller,
        cardMessageId,
      )
      if (!sent) throw new Error('当前会话没有可选项。')
      return
    }
    if (command.name === 'permission') {
      await sendPermissionSetting(binding, cardMessageId)
      return
    }
    await sendCommandPrompt(binding, command, cardMessageId)
  }

  const resetConversation = async (
    target: InteractionTarget,
    command: string,
  ) => {
    const state = prepared
    if (state === undefined) throw new Error('命令运行时尚未准备完成。')
    const replacement = await state.agents.reset(target.conversationKey)
    coordinator.clear(target.conversationKey)
    await closePresentations(target.conversationKey)
    forgetConversationCards(target.conversationKey)
    forgetCommandInteractions(target.conversationKey)
    await approvals.cancelConversation(target.conversationKey)
    for (const [id, pending] of pendingModelSettings) {
      if (pending.target.conversationKey === target.conversationKey) pendingModelSettings.delete(id)
    }
    rememberBinding(replacement, target, target.chatType)
    return {
      reply: command === RESET_COMMAND
        ? '已重置当前会话，下一条消息将不带入之前的上下文。'
        : '已新建空白会话，下一条消息将不带入之前的上下文。',
      status: 'success' as const,
    }
  }

  const handleCommand = async (
    command: ParsedCommand,
    binding: ConversationBinding,
  ): Promise<void> => {
    const commands = ctx.get('commands') as HostCommands | undefined
    const descriptor = commandCatalog(commands, binding.owner.handle.agent)
      .find(candidate => candidate.name === command.name)
    if (command.input === '' && descriptor !== undefined) {
      await openCommandInteraction(binding, descriptor)
      return
    }
    const controller = createModelController(ctx.get('sessionController') as HostSessionController | undefined)
    const outcome = await executeCommand(command, {
      agent: binding.owner.handle.agent,
      commands,
      signal: commandController.signal,
      models: controller,
    })
    await port.send(binding.chatId, { card: commandResultCard(command.name, outcome) })
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
      if (
        command?.input === ''
        && (command.name === NEW_COMMAND || command.name === RESET_COMMAND)
      ) {
        const descriptor = CHANNEL_COMMANDS.find(candidate => candidate.name === command.name)!
        await sendSessionCommandPrompt(target, message.chatType, descriptor)
        return
      }
      let owner = await state.agents.acquire(target.conversationKey)
      let binding = rememberBinding(owner, target, message.chatType)
      if (command !== undefined) {
        await handleCommand(command, binding)
        return
      }

      const images = await collectMessageImages(message, binding)
      if (!active) return
      if (!state.agents.isCurrent(owner)) {
        owner = await state.agents.acquire(target.conversationKey)
        binding = rememberBinding(owner, target, message.chatType)
      }
      coordinator.submit(owner, target, chatUserMessage(message, images))
    } catch (error) {
      const messageDetail = detail(error)
      const operation = command === undefined ? 'agent creation' : 'command handling'
      notify('feishu-channel: ' + operation + ' failed for chat ' + message.chatId + ': ' + messageDetail)
      ctx.logger.warn('%s failed for chat %s: %s', operation, message.chatId, messageDetail)
      await port.send(message.chatId, command === undefined
        ? { text: '⚠️ 无法启动会话：' + messageDetail }
        : {
            card: commandResultCard(command.name, {
              reply: '命令执行失败（/' + command.name + '）：' + messageDetail,
              status: 'failure',
            }),
          }).catch(reportSendFailure)
    }
  }

  const currentBinding = (target: InteractionTarget): ConversationBinding | undefined => {
    const binding = bindingsByKey.get(target.conversationKey)
    return binding?.owner.handle.agent.session.id === target.sessionId ? binding : undefined
  }

  const interactionRefusal = (
    target: InteractionTarget,
    event: CardActionEvent,
    label: string,
  ): CardActionResponse | undefined => {
    const refusal = refuseApprovalClick(
      authorization,
      { operatorId: event.operator.openId, chatId: event.chatId },
      { chatId: target.chatId, chatType: target.chatType },
    )
    if (refusal === undefined) return undefined
    notify('feishu-channel: rejected a ' + label + ' click: ' + refusal)
    return { toast: { type: 'error', content: '你无权操作此会话' } }
  }

  const executeCommandInteraction = async (
    pending: Extract<PendingCommandInteraction, { readonly kind: 'prompt' }>,
    input: string,
  ): Promise<void> => {
    const target = pending.target
    try {
      let outcome
      if (pending.command.name === NEW_COMMAND || pending.command.name === RESET_COMMAND) {
        outcome = await resetConversation(target, pending.command.name)
      } else {
        const binding = currentBinding(target)
        if (binding === undefined) throw new Error('该命令卡已失效。')
        const command = parseCommandLine('/' + pending.command.name + (input === '' ? '' : ' ' + input))
        if (command === undefined) throw new Error('命令参数无法解析。')
        outcome = await executeCommand(
          command,
          {
            agent: binding.owner.handle.agent,
            commands: ctx.get('commands') as HostCommands | undefined,
            signal: commandController.signal,
            models: createModelController(ctx.get('sessionController') as HostSessionController | undefined),
          },
        )
      }
      await port.updateCard(target.cardMessageId, commandResultCard(pending.command.name, outcome))
    } catch (error) {
      const message = detail(error)
      notify('feishu-channel: interactive /' + pending.command.name + ' failed: ' + message)
      await port.updateCard(target.cardMessageId, commandResultCard(pending.command.name, {
        reply: '命令执行失败（/' + pending.command.name + '）：' + message,
        status: 'failure',
      })).catch(reportSendFailure)
    }
  }

  const openSelectedCommand = async (
    pending: Extract<PendingCommandInteraction, { readonly kind: 'menu' }>,
    binding: ConversationBinding,
    command: HostCommandDescriptor,
  ): Promise<void> => {
    try {
      await openCommandInteraction(binding, command, pending.target.cardMessageId)
    } catch (error) {
      const message = detail(error)
      notify('feishu-channel: could not open /' + command.name + ' interaction: ' + message)
      const card = command.name === 'permission'
        ? failedPermissionSettingCard(message)
        : commandResultCard(command.name, { reply: message, status: 'failure' })
      await port.updateCard(pending.target.cardMessageId, card).catch(reportSendFailure)
    }
  }

  const applyPermissionSetting = async (
    pending: PendingPermissionSetting,
    choice: PermissionSettingChoice,
  ): Promise<void> => {
    const target = pending.target
    try {
      const binding = currentBinding(target)
      if (binding === undefined) throw new Error('该权限选择卡已失效。')
      const command = parseCommandLine('/permission ' + choice.value)
      if (command === undefined) throw new Error('权限预设无法解析。')
      const outcome = await executeCommand(command, {
        agent: binding.owner.handle.agent,
        commands: ctx.get('commands') as HostCommands | undefined,
        signal: commandController.signal,
        models: createModelController(ctx.get('sessionController') as HostSessionController | undefined),
      })
      if (outcome.status === 'failure') {
        await port.updateCard(target.cardMessageId, failedPermissionSettingCard(outcome.reply))
        return
      }
      await port.updateCard(target.cardMessageId, settledPermissionSettingCard(choice))
    } catch (error) {
      const message = detail(error)
      notify('feishu-channel: permission selection failed: ' + message)
      await port.updateCard(target.cardMessageId, failedPermissionSettingCard(message))
        .catch(reportSendFailure)
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

    const formId = commandFormActionId(event.action.name)
    if (formId !== undefined) {
      const pending = pendingCommandInteractions.get(formId)
      if (pending === undefined || pending.kind !== 'prompt' || pending.target.cardMessageId !== event.messageId) {
        return { toast: { type: 'info', content: '该命令卡已失效' } }
      }
      const refusal = interactionRefusal(pending.target, event, 'command-form')
      if (refusal !== undefined) return refusal
      if (currentBinding(pending.target) === undefined) {
        pendingCommandInteractions.delete(formId)
        return { toast: { type: 'info', content: '该命令卡已失效' } }
      }
      const rawInput = event.action.formValue?.[COMMAND_INPUT_NAME]
      if (rawInput !== undefined && typeof rawInput !== 'string') {
        return { toast: { type: 'error', content: '命令参数格式无效' } }
      }
      pendingCommandInteractions.delete(formId)
      trackCommandOperation(executeCommandInteraction(pending, rawInput?.trim() ?? ''))
      return { toast: { type: 'info', content: '正在执行 /' + pending.command.name } }
    }

    const commandAction = commandInteractionActionValue(event.action.value)
    if (commandAction !== undefined) {
      const pending = pendingCommandInteractions.get(commandAction.id)
      if (pending === undefined || pending.target.cardMessageId !== event.messageId) {
        return { toast: { type: 'info', content: '该命令卡已失效' } }
      }
      const refusal = interactionRefusal(pending.target, event, 'command')
      if (refusal !== undefined) return refusal
      const binding = currentBinding(pending.target)
      const isSessionReset = pending.kind === 'prompt'
        && (pending.command.name === NEW_COMMAND || pending.command.name === RESET_COMMAND)
      if (binding === undefined && !isSessionReset) {
        pendingCommandInteractions.delete(commandAction.id)
        return { toast: { type: 'info', content: '该命令卡已失效' } }
      }
      if (commandAction.action === 'open') {
        if (pending.kind !== 'menu') return { toast: { type: 'error', content: '命令卡状态无效' } }
        if (binding === undefined) return { toast: { type: 'info', content: '该命令卡已失效' } }
        const command = event.action.option === undefined ? undefined : pending.commands.get(event.action.option)
        if (command === undefined) return { toast: { type: 'error', content: '选项无效，请重新打开命令中心' } }
        pendingCommandInteractions.delete(commandAction.id)
        trackCommandOperation(openSelectedCommand(pending, binding, command))
        return { toast: { type: 'info', content: '正在打开 /' + command.name } }
      }
      if (pending.kind !== 'prompt') return { toast: { type: 'error', content: '命令卡状态无效' } }
      pendingCommandInteractions.delete(commandAction.id)
      if (commandAction.action === 'cancel') {
        trackCommandOperation(port.updateCard(
          pending.target.cardMessageId,
          cancelledCommandCard(pending.command.name),
        ).catch(reportSendFailure))
        return { toast: { type: 'success', content: '已取消 /' + pending.command.name } }
      }
      trackCommandOperation(executeCommandInteraction(pending, ''))
      return { toast: { type: 'info', content: '正在执行 /' + pending.command.name } }
    }

    const permissionAction = permissionSettingActionValue(event.action.value)
    if (permissionAction !== undefined) {
      const pending = pendingPermissionSettings.get(permissionAction.id)
      if (pending === undefined || pending.target.cardMessageId !== event.messageId) {
        return { toast: { type: 'info', content: '该权限选择卡已失效' } }
      }
      const refusal = interactionRefusal(pending.target, event, 'permission-setting')
      if (refusal !== undefined) return refusal
      if (currentBinding(pending.target) === undefined) {
        pendingPermissionSettings.delete(permissionAction.id)
        return { toast: { type: 'info', content: '该权限选择卡已失效' } }
      }
      if (permissionAction.action === 'cancel') {
        pendingPermissionSettings.set(permissionAction.id, {
          target: pending.target,
          select: pending.select,
          choices: pending.choices,
        })
        trackCommandOperation(port.updateCard(
          pending.target.cardMessageId,
          permissionSettingCard(pending.select, permissionAction.id, [...pending.choices.values()]),
        ).catch(reportSendFailure))
        return { toast: { type: 'info', content: '已返回权限选择' } }
      }
      const choice = permissionAction.action === 'confirm'
        ? pending.confirmation
        : event.action.option === undefined ? undefined : pending.choices.get(event.action.option)
      if (choice === undefined) return { toast: { type: 'error', content: '选项无效，请重新输入 /permission' } }
      if (
        permissionAction.action === 'select'
        && choice.value === FULL_ACCESS_PERMISSION
        && pending.select.currentValue !== FULL_ACCESS_PERMISSION
      ) {
        pendingPermissionSettings.set(permissionAction.id, { ...pending, confirmation: choice })
        trackCommandOperation(port.updateCard(
          pending.target.cardMessageId,
          permissionConfirmationCard(choice, permissionAction.id),
        ).catch(reportSendFailure))
        return { toast: { type: 'info', content: '请再次确认高风险权限' } }
      }
      pendingPermissionSettings.delete(permissionAction.id)
      trackCommandOperation(applyPermissionSetting(pending, choice))
      return { toast: { type: 'info', content: '正在切换权限' } }
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
      trackCommandOperation(applyModelSetting(pending, selection))
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
    pendingCommandInteractions.clear()
    pendingPermissionSettings.clear()
    retryCards.clear()
    reuseCardForTurn.clear()
    const closeAgents = prepared !== undefined
      ? prepared.agents.close()
      : preparing?.then(state => state.agents.close(), () => undefined)
    return Promise.allSettled([
      closePresentations(),
      approvals.close(),
      Promise.allSettled([...imageCollections]),
      Promise.allSettled([...commandOperations]),
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
