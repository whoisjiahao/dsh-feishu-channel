/**
 * Test harness: the production plugin mounted over a fake transport and fake
 * host services. Mounting through `apply` (rather than calling
 * `installChannel` directly) exercises the runtime bootstrap too: settings
 * layering, credential onboarding, transport policy, and panel sync.
 * @module tests/harness
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannelError,
  NormalizedMessage,
  RejectEvent,
  SendInput,
  SendOptions,
  SendResult,
} from '@larksuite/channel'
import * as plugin from '../src/index.ts'
import { parseCommandLine } from '../src/commands.ts'
import { internals } from '../src/runtime.ts'
import type { ChannelPort } from '../src/channel.ts'
import type {
  HostAgentOptions,
  HostAttachments,
  HostCommandDescriptor,
  HostCommands,
  HostDefaultModel,
  HostImageLimits,
  HostLlm,
  HostPermissionSelect,
  HostModelSelection,
  HostSessionController,
  HostSessionPersistence,
  HostUserMessage,
} from '../src/host.ts'
import type { RegisterAppPort } from '../src/onboarding.ts'

/**
 * How many inbound subscriptions `installChannel` opens: `message`,
 * `cardAction`, `reject`, `error`, `reconnecting`, `reconnected`. Tests use the
 * count as the "bridge is installed" signal, so it lives here rather than being
 * pinned at each call site.
 */
export const INBOUND_SUBSCRIPTIONS = 6

/** One outbound message captured by the fake port. */
export interface SentMessage {
  to: string
  input: SendInput
  opts?: SendOptions | undefined
}

type MessageHandler = (msg: NormalizedMessage) => void | Promise<void>
type CardActionHandler = (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>
type RejectHandler = (evt: RejectEvent) => void
type ErrorHandler = (err: LarkChannelError) => void
type ConnectionStateHandler = () => void
/** Any inbound subscription the fake port accepts, whatever the event name. */
type PortHandler = MessageHandler | CardActionHandler | RejectHandler | ErrorHandler | ConnectionStateHandler

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

/** An in-memory {@link ChannelPort} recording traffic and replaying inbound events. */
export function createFakePort() {
  const messageHandlers: MessageHandler[] = []
  const cardHandlers: CardActionHandler[] = []
  /** Every other subscription, by event name, so a test can replay any inbound event. */
  const byName = new Map<string, PortHandler[]>()
  const sent: SentMessage[] = []
  const updated: { messageId: string; card: object }[] = []
  /** Commands already on the app's panel, and the ones this run registered/removed. */
  const panelCommands: string[] = []
  const panelCreated: string[] = []
  const panelDeleted: string[] = []
  /** Downloadable resources, by file key, as the transport would serve them. */
  const resourceBytes = new Map<string, { buffer: Uint8Array; contentType?: string }>()
  const state = {
    connects: 0,
    disconnects: 0,
    subscriptions: 0,
    connected: false,
    connecting: false,
    pendingSends: 0,
    inFlightMessages: 0,
    /** Reject the next send call, as a deployment without card permissions would. */
    failNextSend: false,
    /** Reject the next card update. */
    failNextUpdate: false,
    /** Reject panel reads, as an app without the scope would. */
    failPanelList: false,
    /** Reject panel writes, as a duplicate name does. */
    failPanelCreate: false,
    /** Reject panel removals. */
    failPanelDelete: false,
  }
  let counter = 0
  let connectGate: Deferred<void> | undefined
  let sendGate: Deferred<void> | undefined

  const controls = {
    delayNextConnect(): void {
      if (connectGate !== undefined) throw new Error('connect is already delayed')
      connectGate = deferred<void>()
    },
    releaseConnect(): void {
      connectGate?.resolve(undefined)
    },
    rejectConnect(error: unknown): void {
      connectGate?.reject(error)
    },
    delayNextSend(): void {
      if (sendGate !== undefined) throw new Error('send is already delayed')
      sendGate = deferred<void>()
    },
    releaseSend(): void {
      sendGate?.resolve(undefined)
    },
    rejectSend(error: unknown): void {
      sendGate?.reject(error)
    },
  }

  /** The subscription list for one event name; `on` is an overload set. */
  const listFor = (name: string): PortHandler[] => {
    if (name === 'message') return messageHandlers as PortHandler[]
    if (name === 'cardAction') return cardHandlers as PortHandler[]
    const existing = byName.get(name)
    if (existing !== undefined) return existing
    const fresh: PortHandler[] = []
    byName.set(name, fresh)
    return fresh
  }

  const subscribe = (name: string, handler: PortHandler): (() => void) => {
    const list = listFor(name)
    list.push(handler)
    state.subscriptions += 1
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) {
        list.splice(index, 1)
        state.subscriptions -= 1
      }
    }
  }

  const port = {
    async connect() {
      state.connects += 1
      state.connecting = true
      const gate = connectGate
      try {
        if (gate !== undefined) await gate.promise
        state.connected = true
      } finally {
        if (connectGate === gate) connectGate = undefined
        state.connecting = false
      }
    },
    async disconnect() {
      state.disconnects += 1
      // Match the real SDK: disconnect during its initial handshake is a no-op.
      if (!state.connected) return
      state.connected = false
    },
    on: subscribe as ChannelPort['on'],
    async send(to, input, opts): Promise<SendResult> {
      if (state.failNextSend) {
        state.failNextSend = false
        throw new Error('send failed (fake)')
      }
      state.pendingSends += 1
      const gate = sendGate
      try {
        if (gate !== undefined) await gate.promise
        sent.push({ to, input, opts })
        counter += 1
        return { messageId: 'om_sent_' + counter }
      } finally {
        if (sendGate === gate) sendGate = undefined
        state.pendingSends -= 1
      }
    },
    async updateCard(messageId, card) {
      if (state.failNextUpdate) {
        state.failNextUpdate = false
        throw new Error('update failed (fake)')
      }
      updated.push({ messageId, card })
    },
    async downloadResourceToFile(messageId, fileKey, _type, destPath) {
      const stored = resourceBytes.get(fileKey)
      if (stored === undefined) throw new Error('no such resource ' + fileKey + ' on ' + messageId + ' (fake)')
      await writeFile(destPath, stored.buffer)
      return {
        bytesWritten: stored.buffer.byteLength,
        ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }),
      }
    },
    async listSlashCommands() {
      if (state.failPanelList) throw new Error('no permission to list commands (fake)')
      return {
        commands: panelCommands.map((command, index) => ({ command, commandId: 'cmd_' + index })),
      }
    },
    async deleteSlashCommand(commandId) {
      if (state.failPanelDelete) throw new Error('cannot remove command (fake)')
      const index = panelCommands.findIndex((_, i) => 'cmd_' + i === commandId)
      if (index >= 0) {
        panelDeleted.push(panelCommands[index]!)
        panelCommands.splice(index, 1)
      }
    },
    async createSlashCommand(command, _description) {
      if (state.failPanelCreate) throw new Error('command already exists (fake)')
      panelCommands.push(command)
      panelCreated.push(command)
    },
  } as ChannelPort

  return {
    port,
    sent,
    updated,
    panelCommands,
    panelCreated,
    panelDeleted,
    resourceBytes,
    state,
    controls,
    /** Deliver one inbound chat message to every subscribed handler. */
    async emitMessage(msg: NormalizedMessage): Promise<void> {
      state.inFlightMessages += 1
      try {
        for (const handler of [...messageHandlers]) await handler(msg)
      } finally {
        state.inFlightMessages -= 1
      }
    },
    /** Deliver one policy rejection to every subscribed handler. */
    emitReject(evt: RejectEvent): void {
      for (const handler of [...(byName.get('reject') ?? [])]) (handler as RejectHandler)(evt)
    },
    /** Deliver one transport failure to every subscribed handler. */
    emitError(err: LarkChannelError): void {
      for (const handler of [...(byName.get('error') ?? [])]) (handler as ErrorHandler)(err)
    },
    /** Deliver one connection-state change to every subscribed handler. */
    emitConnectionState(name: 'reconnecting' | 'reconnected'): void {
      for (const handler of [...(byName.get(name) ?? [])]) (handler as ConnectionStateHandler)()
    },
    /** Deliver one card action; returns the last handler's response. */
    async emitCardAction(evt: CardActionEvent): Promise<CardActionResponse | undefined> {
      // A platform callback cannot arrive until the preceding send response
      // has published the card and its handler continuation has completed.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      let response: CardActionResponse | undefined
      for (const handler of [...cardHandlers]) {
        const result = await handler(evt)
        if (result !== undefined) response = result
      }
      return response
    },
  }
}

/** The sender `fakeMessage()` speaks as, and the default clicker in tests. */
export const SENDER_ID = 'ou_sender_1'

/** A complete inbound message with overridable fields. */
export function fakeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_in_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    senderId: SENDER_ID,
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
    ...overrides,
  }
}

/** One card action click, as the platform would deliver it. */
export function clickAction(
  value: unknown,
  by: {
    openId?: string
    chatId?: string
    name?: string
    messageId?: string
    option?: string
    tag?: string
    actionName?: string
    formValue?: Record<string, unknown>
  } = {},
): CardActionEvent {
  return {
    messageId: by.messageId ?? 'om_sent_1',
    chatId: by.chatId ?? 'oc_chat_1',
    operator: {
      openId: by.openId ?? SENDER_ID,
      ...(by.name === undefined ? {} : { name: by.name }),
    },
    action: {
      tag: by.tag ?? 'button',
      value,
      ...(by.option === undefined ? {} : { option: by.option }),
      ...(by.actionName === undefined ? {} : { name: by.actionName }),
      ...(by.formValue === undefined ? {} : { formValue: by.formValue }),
    },
  }
}

/** One agent creation or resume recorded by the fake registry. */
export interface RecordedAgent {
  sessionId: string
  meta: { cwd?: string; agentPreset?: string } | undefined
  agentOptions: HostAgentOptions | undefined
  /** Whether creation ran a composition `setup` callback, and with a scoped context. */
  setupRan: boolean
  /** Deny reason this agent's composed guards give one tool name, if any. */
  denyReason: (name: string) => string | undefined
  /** Prompt sections setup registered on this agent's scope. */
  promptSections: { name: string; order: number; text: string }[]
  agent: {
    id: string
    session: { id: string; requestContext: () => { provider: string; model: string } | undefined }
    followup: ReturnType<typeof vi.fn<(m: HostUserMessage) => void>>
    cancel: ReturnType<typeof vi.fn<(cause: string) => void>>
  }
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

/** An in-memory `agents` registry capturing every agent it produced. */
export function createFakeAgents() {
  const created: RecordedAgent[] = []
  /** Session ids a test declared stored, so `resume` loads them instead of rejecting. */
  const resumable = new Set<string>()
  /** Agents a test declared already live under another owner, so `get` adopts one. */
  const live = new Map<string, RecordedAgent['agent']>()
  const resumed: string[] = []
  const looked: string[] = []
  const state = { pendingCreates: 0 }
  let createGate: Deferred<void> | undefined

  const controls = {
    /** Session model context fake agents report; tests set it per scenario. */
    requestContext: undefined as { provider: string; model: string } | undefined,
    delayNextCreate(): void {
      if (createGate !== undefined) throw new Error('agent creation is already delayed')
      createGate = deferred<void>()
    },
    releaseCreate(): void {
      createGate?.resolve(undefined)
    },
    rejectCreate(error: unknown): void {
      createGate?.reject(error)
    },
  }

  const makeAgent = (sessionId: string): RecordedAgent['agent'] => ({
    id: sessionId,
    session: {
      id: sessionId,
      requestContext: () => controls.requestContext === undefined
        ? undefined
        : { ...controls.requestContext },
    },
    followup: vi.fn<(m: HostUserMessage) => void>(),
    cancel: vi.fn<(cause: string) => void>(),
  })

  /**
   * Run one composition the way the real factory does: on a scoped context
   * carrying the per-agent tools and prompt services, awaited BEFORE the agent
   * is published, so a rejection surfaces to the caller and yields no agent.
   */
  const compose = async (setup?: (agentCtx: Context) => Promise<void>) => {
    const guards: ((execution: { name: string }) => string | undefined)[] = []
    const sections: { name: string; order: number; text: string }[] = []
    if (setup !== undefined) {
      const agentCtx = new Context()
      agentCtx.provide('tools', { guard: (g: (e: { name: string }) => string | undefined) => {
        guards.push(g)
        return () => { guards.splice(guards.indexOf(g), 1) }
      } })
      agentCtx.provide('systemPrompt', { section: (s: { name: string; order: number; text: string }) => {
        sections.push(s)
        return () => undefined
      } })
      await setup(agentCtx)
    }
    return {
      setupRan: setup !== undefined,
      /** Deny reason the composed guards give a tool, or undefined when allowed. */
      denyReason: (name: string) => guards.map(g => g({ name })).find(r => r !== undefined),
      promptSections: sections,
    }
  }

  const service = {
    /** The live agent already published on this id, as the real registry reports it. */
    get(sessionId: string) {
      looked.push(sessionId)
      return live.get(sessionId)
    },
    /**
     * The real registry rejects when nothing is stored under the id — that
     * rejection is this channel's only existence probe.
     */
    async resume(options: {
      readonly resumeSessionId: string
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      resumed.push(options.resumeSessionId)
      if (!resumable.has(options.resumeSessionId)) {
        throw new Error('no stored session for ' + options.resumeSessionId + ' (fake)')
      }
      const agent = makeAgent(options.resumeSessionId)
      const record: RecordedAgent = {
        sessionId: options.resumeSessionId,
        meta: undefined,
        agentOptions: options.agentOptions,
        ...await compose(options.setup),
        agent,
        dispose: vi.fn<() => Promise<void>>(async () => {}),
      }
      created.push(record)
      return { agent, dispose: record.dispose }
    },
    async create(options: {
      readonly sessionId: string
      readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
      readonly agentOptions?: HostAgentOptions
      readonly setup?: (agentCtx: Context) => Promise<void>
    }) {
      state.pendingCreates += 1
      const gate = createGate
      try {
        if (gate !== undefined) await gate.promise
        const agent = makeAgent(options.sessionId)
        const record: RecordedAgent = {
          sessionId: options.sessionId,
          meta: options.meta === undefined ? undefined : { ...options.meta },
          agentOptions: options.agentOptions,
          ...await compose(options.setup),
          agent,
          dispose: vi.fn<() => Promise<void>>(async () => {}),
        }
        created.push(record)
        return { agent, dispose: record.dispose }
      } finally {
        if (createGate === gate) createGate = undefined
        state.pendingCreates -= 1
      }
    },
  }
  return {
    created,
    service,
    state,
    controls,
    /** Ids `resume` loads, and agents `get` adopts. */
    resumable,
    live,
    /** Ids handed to `resume` and to `get`, in call order. */
    resumed,
    looked,
    /** Declare one id already live under another owner. */
    declareLive(sessionId: string): RecordedAgent['agent'] {
      const agent = makeAgent(sessionId)
      live.set(sessionId, agent)
      return agent
    },
  }
}

/** One line the plugin logged, at the level it chose. */
export interface LoggedLine {
  type: 'error' | 'info' | 'warn' | 'debug'
  /** The format string and its parameters, joined; assert with `toContain`. */
  text: string
}

/** Plugin config overrides; an explicit `undefined` removes a harness default. */
export type ConfigOverrides = { [K in keyof plugin.Config]?: plugin.Config[K] | undefined }

/** Services a mounted channel may compose, mirroring a real DSH profile. */
export interface HarnessServices {
  defaultModel?: HostDefaultModel
  presets?: object
  workspaces?: object
  commands?: HostCommands
  sessionController?: object
  tools?: object
  attachments?: HostAttachments
  llm?: HostLlm
  sessionPersistence?: HostSessionPersistence
  settings?: object
  loader?: { await(): Promise<unknown> }
  registerApp?: RegisterAppPort
  /** Configure delayed transport behavior before the plugin starts connecting. */
  configurePort?: (fake: ReturnType<typeof createFakePort>) => void
  /**
   * An answerer registered BEFORE the plugin, as a host row that mounts during
   * tree load is. Records whether it was ever consulted; delegates onward.
   */
  competingAnswerer?: { claims: { toolName: string }[] }
}

/** What one mounted channel exposes to its tests. */
export type Harness = Awaited<ReturnType<typeof mountChannel>>

/**
 * Mount the production plugin over the fake port and fake `agents` registry.
 * The full `apply` path runs: loader await, settings layering, credential
 * onboarding, transport policy, bridge installation.
 * @param overrides - plugin config overrides.
 * @param services - host services to compose.
 * @param credentials - app credentials; pass `undefined` to run the QR flow.
 * @returns the mounted channel, ready to emit inbound events.
 */
export async function mountChannel(
  overrides: ConfigOverrides = {},
  services: HarnessServices = {},
  credentials: { appId: string; appSecret: string } | undefined,
) {
  const ctx = new Context()
  const logs: LoggedLine[] = []
  // Cordis buffers log messages and prints nothing without an exporter, and its
  // default exporter level drops `debug`; this one keeps every level so a test
  // can tell an operator-console line from one deliberately kept off it.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      logs.push({ type: message.type, text: (message.args as unknown[]).map(part => String(part)).join(' ') })
    },
  })
  const agents = createFakeAgents()
  const competing = services.competingAnswerer
  if (competing !== undefined) {
    ctx.on('approval/request', (request, next) => {
      competing.claims.push({ toolName: request.toolName })
      // Delegates onward, like a host row that answers only what it owns.
      return next()
    })
  }
  ctx.provide('agents', agents.service)
  if (services.defaultModel !== undefined) ctx.provide('agentDefaultModel', services.defaultModel)
  if (services.settings !== undefined) ctx.provide('settings', services.settings)
  if (services.presets !== undefined) ctx.provide('agentPresets', services.presets)
  if (services.tools !== undefined) ctx.provide('tools', services.tools)
  if (services.workspaces !== undefined) ctx.provide('workspaceRegistry', services.workspaces)
  if (services.commands !== undefined) ctx.provide('commands', services.commands)
  if (services.sessionController !== undefined) ctx.provide('sessionController', services.sessionController)
  if (services.attachments !== undefined) ctx.provide('attachments', services.attachments)
  if (services.llm !== undefined) ctx.provide('llm', services.llm)
  if (services.sessionPersistence !== undefined) ctx.provide('sessionPersistence', services.sessionPersistence)
  if (services.loader !== undefined) ctx.provide('loader', services.loader)
  const fake = createFakePort()
  services.configurePort?.(fake)
  const notices: string[] = []
  const portAuthorizations: {
    directSenders: string[]
    groups: string[]
    approvers: string[]
  }[] = []
  const originalCreatePort = internals.createPort
  const originalRegisterApp = internals.registerApp
  const originalNotify = internals.notify
  internals.createPort = (_portConfig, authorization) => {
    portAuthorizations.push({
      directSenders: [...authorization.directSenders],
      groups: [...authorization.groups],
      approvers: [...authorization.approvers],
    })
    return fake.port
  }
  internals.registerApp = services.registerApp
    ?? (() => Promise.reject(new Error('registerApp not faked for this test')))
  internals.notify = (line) => { notices.push(line) }
  // A re-issued QR code waits out the production floor, which a test must not.
  internals.reissueFloorMs = 0
  const cwd = await mkdtemp(join(tmpdir(), 'feishu-channel-test-'))
  const merged = {
    appId: credentials?.appId,
    appSecret: credentials?.appSecret,
    provider: 'test-provider',
    model: 'test-model',
    cwd,
    ...overrides,
  } as plugin.Config
  const fiber = await ctx.plugin(plugin, merged)
  // Activation bootstraps asynchronously; hold until the bridge subscribed when
  // the mount alone is expected to reach a connected channel.
  if (credentials !== undefined && services.settings === undefined) {
    await vi.waitFor(() => {
      if (fake.state.subscriptions !== INBOUND_SUBSCRIPTIONS) throw new Error('bridge not subscribed yet')
    })
  }
  return {
    ctx,
    fiber,
    fake,
    agents,
    /** Per-test model context the fake agents report to image admission. */
    agentsControls: agents.controls,
    notices,
    logs,
    portAuthorizations,
    ...(services.settings === undefined ? {} : { settings: services.settings as { updates: object[]; registered: { ns: string }[] } }),
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        internals.createPort = originalCreatePort
        internals.registerApp = originalRegisterApp
        internals.notify = originalNotify
        delete internals.reissueFloorMs
        await rm(cwd, { recursive: true, force: true })
      }
    },
  }
}

/** An in-memory `agentPresets` roster recording every resolve and mount. */
export function createFakePresets(ids: string[] = ['default'], defaultId = ids[0]!) {
  const mounted: { id: string | undefined; scoped: boolean }[] = []
  const resolved: (string | undefined)[] = []
  const presets = {
    async resolve(id?: string) {
      resolved.push(id)
      const wanted = id ?? defaultId
      if (!ids.includes(wanted)) throw new Error('agent-presets: unknown preset "' + wanted + '"')
      return { id: wanted }
    },
    async mount(agentCtx: Context, id?: string) {
      mounted.push({ id, scoped: agentCtx !== undefined })
      return undefined
    },
    async standingKeyFor(id?: string) {
      return 'standing:' + (id ?? defaultId)
    },
  }
  return { presets, mounted, resolved }
}

/** An in-memory `workspaceRegistry` whose entity holds the seeded session ids. */
export function createFakeWorkspaces(sessionIds: string[] = []) {
  const created: string[] = []
  const attached: { workspaceId: string; sessionId: string }[] = []
  const detached: string[] = []
  const state = { failAttach: false, failDetach: false }
  let counter = 0
  const entity = (id: string) => ({
    id,
    path: 'ignored-in-fake',
    get sessionIds() { return [...sessionIds] },
    async attachSession(sessionId: string) {
      if (state.failAttach) throw new Error('cwd does not match the workspace path (fake)')
      attached.push({ workspaceId: id, sessionId })
      sessionIds.splice(0, sessionIds.length, sessionId, ...sessionIds.filter(existing => existing !== sessionId))
    },
    async detachSession(sessionId: string) {
      if (state.failDetach) throw new Error('cannot detach (fake)')
      detached.push(sessionId)
      const index = sessionIds.indexOf(sessionId)
      if (index >= 0) sessionIds.splice(index, 1)
    },
  })
  const service = {
    async resolveByPath(_path: string) {
      return counter === 0 ? undefined : entity('ws_' + counter)
    },
    async create(path: string) {
      created.push(path)
      counter += 1
      return entity('ws_' + counter)
    },
  }
  return { service, created, attached, detached, state, sessionIds }
}

/** An in-memory `attachments` store recording every committed image. */
export function createFakeAttachments(limits: Partial<HostImageLimits> = {}) {
  const saved: { mediaType: string; bytes: number; name?: string }[] = []
  const state = { failSave: false }
  const service: HostAttachments = {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 3,
      maxMessageImageBytes: 2_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...limits,
    },
    async saveImage(input) {
      if (state.failSave) throw new Error('store rejected the image (fake)')
      saved.push({
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      return {
        attachmentId: 'att_' + saved.length,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 100,
        height: 50,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
  }
  return { service, saved, state }
}

/** An in-memory `commands` runtime recording every dispatched line. */
export function createFakeCommands(
  available: HostCommandDescriptor[] = [{ name: 'status', description: '查看运行状态' }],
  outcomes: Record<string, { kind: 'success'; text?: string } | { kind: 'error'; text: string }> = {},
) {
  const executed: string[] = []
  const service: HostCommands = {
    list: () => available,
    async execute(_agent, line, _images, _signal) {
      executed.push(line)
      const name = parseCommandLine(line)?.name ?? ''
      if (!available.some(c => c.name === name)) return undefined
      return { result: outcomes[name] ?? { kind: 'success', text: 'ran ' + name } }
    },
  }
  return { service, executed }
}

/** An in-memory `tools` registry that can describe calls and record guards. */
export function createFakeTools(
  presenters: Record<string, (args: unknown) => { title?: string } | undefined> = {},
) {
  const views: { name: string; scope: unknown }[] = []
  const service = {
    guard: () => () => undefined,
    get(name: string, scope?: unknown) {
      views.push({ name, scope })
      const presentCall = presenters[name]
      return presentCall === undefined ? undefined : { presentCall }
    },
  }
  return { service, views }
}

/** An in-memory `settings` service: one namespace layering base under `stored`. */
export function createFakeSettings(stored: Record<string, unknown> = {}) {
  const updates: object[] = []
  const registered: { ns: string }[] = []
  const settings = {
    register(ns: string, _schema: unknown, options?: { base?: unknown }) {
      registered.push({ ns })
      return {
        get: () => ({ ...(options?.base as Record<string, unknown>), ...stored }),
        update: async (patch: object) => {
          updates.push(patch)
          Object.assign(stored, patch)
        },
      }
    },
  }
  return { settings, updates, registered }
}

/** An in-memory `sessionController` with a mutable model catalog and projections. */
export function createFakeModelApi(
  directory: {
    /** Deployment default served to sessions with no durable selection. */
    current: { provider: string; model: string; reasoningEffort?: string }
    groups: { id: string; name: string; models: {
      id: string
      name: string
      reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
    }[] }[]
  },
  permissions?: HostPermissionSelect,
) {
  const selected: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = []
  const state = { failModels: false, failSelect: false }
  // Durable model-selection projection: `selectModel` writes `next`, exactly
  // like the host's `model/selection` event; `inspect` falls back to the
  // catalog default while `next` stays null.
  const projection: { lastUsed: HostModelSelection | null; next: HostModelSelection | null } = {
    lastUsed: null,
    next: null,
  }
  const service: HostSessionController = {
    async modelCatalog() {
      if (state.failModels) throw new Error('models unavailable (fake)')
      return {
        default: { ...directory.current },
        routableProviders: directory.groups.map(group => group.id),
        groups: directory.groups,
        failures: [],
      }
    },
    async selectModel(request) {
      if (state.failSelect) throw new Error('select failed (fake)')
      const { sessionId, ...selection } = request
      selected.push({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
      projection.next = { ...selection }
      return { selected: { ...selection } }
    },
    async *follow(request) {
      void request
      yield {
        type: 'snapshot',
        projections: {
          asOfSeq: 0,
          values: {
            modelSelection: { ...projection },
            ...(permissions === undefined ? {} : { permissions }),
          },
        },
      }
    },
  }
  return { api: service, selected, state, directory }
}

/** An in-memory `sessionPersistence` listing the seeded headers. */
export function createFakeSessionPersistence(ids: string[]) {
  const headers = ids.map((id, index) => ({ id, createdAt: 1000 + index }))
  return { service: { async list() { return headers } } }
}

/** Extract the approval correlation payload from a sent card's buttons. */
export function approvalValueFromCard(card: object): { kind: string; id: string; decision: string }[] {
  const elements = (card as { elements: { tag: string; actions?: { value: { kind: string; id: string; decision: string } }[] }[] }).elements
  const action = elements.find((element) => element.tag === 'action')
  return (action?.actions ?? []).map((button) => button.value)
}
