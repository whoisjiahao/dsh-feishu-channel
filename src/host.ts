/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * @deepseek-ai/dsh-agent, @deepseek-ai/dsh-session and the approval seam as of
 * dsh 0.1.0-rc.8.
 * @module dsh-feishu-channel/host
 */

import type { Context } from '@deepseek-ai/cordis'

/** The live session a host agent drives. */
export interface HostSession {
  readonly id: string
  requestContext(): RequestContextData | undefined
}

/** Durable metadata for one stored image. */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: HostImageRef }

/** A user-role message accepted by agent.followup. */
export interface HostUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly HostContentBlock[]
  readonly source: { readonly kind: 'user' }
}

/** What one image must satisfy to be stored. */
export interface HostImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/** The attachments store subset used for image intake. */
export interface HostAttachments {
  readonly imageLimits: HostImageLimits
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/** Public live-agent handle subset. */
export interface HostAgent {
  readonly id: string
  readonly session: HostSession
  followup(message: HostUserMessage): void
  cancel(cause: string): void
}

/** An owned agent plus its teardown capability. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Per-agent provider/model routing. */
export interface HostAgentOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** One persisted session's header, as lookup reads it. */
export interface HostSessionHeader {
  readonly id: string
  readonly createdAt: number
}

/** The sessionPersistence store subset: enough to find a chat's previous session. */
export interface HostSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly HostSessionHeader[]>
}

/** The agents registry service subset. */
export interface HostAgentRegistry {
  get(sessionId: string): HostAgent | undefined
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
}

/** The tools registry, as per-agent composition uses it. */
export interface HostTools {
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
  get(name: string, scope?: unknown): HostToolDefinition | undefined
}

/** The presentation half of a tool definition. */
export interface HostToolDefinition {
  presentCall?(args: unknown): { readonly title?: string } | undefined
}

/** One command this deployment offers. */
export interface HostCommandInputDescriptor {
  readonly hint: string
  readonly images?: boolean | undefined
}

/** One command this deployment offers. */
export interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: HostCommandInputDescriptor | undefined
}

/** One settled command execution. */
export interface HostCommandExecution {
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

/** One encoded image accepted by the Host command runtime. */
export interface HostCommandImage {
  readonly mediaType: string
  readonly data: string
  readonly name?: string
}

/** The commands runtime: slash commands dispatched without a model turn. */
export interface HostCommands {
  list(agent: HostAgent): readonly HostCommandDescriptor[]
  execute(
    agent: HostAgent,
    line: string,
    images: readonly HostCommandImage[],
    signal: AbortSignal,
  ): Promise<HostCommandExecution | undefined>
}

/** Complete model selection for one live conversation. */
export interface HostModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/** One adapter-owned reasoning strength. */
export interface HostReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

/** Reasoning strengths advertised for one exact model. */
export interface HostModelReasoning {
  readonly efforts: readonly HostReasoningEffort[]
  readonly defaultEffort?: string | undefined
}

/** One selectable model inside a provider group. */
export interface HostCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly reasoning?: HostModelReasoning | undefined
}

/** One provider group in the model directory. */
export interface HostModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly HostCatalogModel[]
}

/** Current selection plus the models the deployment advertises. */
export interface HostModelDirectory {
  readonly current: HostModelSelection
  readonly groups: readonly HostModelProviderGroup[]
}

/** Narrow model-selection boundary consumed by the Feishu commands. */
export interface HostModelController {
  inspect(sessionId: string): Promise<HostModelDirectory>
  select(sessionId: string, selection: HostModelSelection): Promise<HostModelSelection>
}

/** One permission preset advertised by the session projection. */
export interface HostPermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string | undefined
}

/** Current permission preset plus every host-approved switch target. */
export interface HostPermissionSelect {
  readonly options: readonly HostPermissionOption[]
  readonly currentValue: string
}

/** Host API envelope returned by the model-selection RPC surface. */
export type HostApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface HostApiRequest<T> {
  readonly rpcId: string
  readonly payload: T
}

interface HostApiResponse<T> {
  readonly result: HostApiResult<T>
}

/** Narrow apiProxy surface used by interactive session controls. */
export interface HostSessionApiProxy {
  readonly sessions: {
    models(request: HostApiRequest<{ readonly sessionId: string }>): Promise<HostApiResponse<HostModelDirectory>>
    selectModel(
      request: HostApiRequest<HostModelSelection & { readonly sessionId: string }>,
    ): Promise<HostApiResponse<{ readonly selected: HostModelSelection }>>
    history?(
      request: HostApiRequest<{
        readonly sessionId: string
        readonly maxMessages?: number | undefined
      }>,
    ): Promise<HostApiResponse<{
      readonly projections?: {
        readonly values: { readonly permissions?: HostPermissionSelect | undefined }
      } | undefined
    }>>
  }
}

/** The systemPrompt assembler, as per-agent composition uses it. */
export interface HostSystemPrompt {
  section(section: { name: string; order: number; text: string }): () => void
}

/** The agentPresets roster subset. */
export interface HostAgentPresets {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
  standingKeyFor(id?: string): Promise<unknown>
}

/** One workspace record subset. */
export interface HostWorkspace {
  readonly id: string
  readonly path: string
  /** Newest attached session first. */
  readonly sessionIds: readonly string[]
  attachSession(id: string): Promise<unknown>
  detachSession(id: string): Promise<unknown>
}

/** The workspaceRegistry service subset. */
export interface HostWorkspaceRegistry {
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  create(path: string, title?: string): Promise<HostWorkspace>
}

/** The agentDefaultModel service subset. */
export interface HostDefaultModel {
  currentSelection(): HostAgentOptions
}

/** The Cordis loader service; awaited so agents never see a half-composed tree. */
export interface HostLoader {
  await(): Promise<unknown>
}

/** One registered settings namespace. */
export interface HostSettingsScope {
  get(): unknown
  update(patch: object): Promise<unknown>
}

/** The settings user-settings service subset. */
export interface HostSettings {
  register(ns: string, schema: unknown, options?: { base?: unknown }): HostSettingsScope
}

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The provider/model context capacity recorded for subsequent requests. */
export interface RequestContextData {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
}

/** The assistant/message payload fields this plugin renders. */
export interface AssistantMessageData {
  readonly turn: number
  readonly step?: number
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
    readonly source?: { readonly kind?: string; readonly provider?: string; readonly model?: string }
  }
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly reasoningTokens?: number
  }
}

/** The turn/end payload fields this plugin reports. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: { readonly code?: string; readonly message?: string }
  }
}

/** The assistant/chunk payload fields this plugin streams. */
export interface AssistantChunkData {
  readonly turn: number
  readonly chunk: { readonly type: string; readonly text?: string }
}

/** The tool/result payload fields a card reports. */
export interface ToolResultData {
  readonly turn: number
  readonly message: {
    readonly source?: { readonly callId?: string }
    readonly content: readonly {
      readonly type: string
      readonly toolCallId?: string
      readonly text?: string
      readonly content?: readonly { readonly type: string; readonly text?: string }[]
    }[]
  }
  readonly error?: { readonly name: string; readonly code: string }
}

/** The tool/call payload fields this plugin surfaces as activity. */
export interface ToolCallData {
  readonly turn: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/** Narrow a session event to the active model request context. */
export function isRequestContextEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: RequestContextData } {
  return event.type === 'request/context'
}

/** Narrow a session event to the assembled assistant message for one step. */
export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === 'assistant/message'
}

/** Narrow a session event to a closed turn boundary. */
export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === 'turn/end'
}

/** Narrow a session event to one raw assistant stream chunk. */
export function isAssistantChunkEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantChunkData } {
  return event.type === 'assistant/chunk'
}

/** Narrow a session event to one completed tool call's result. */
export function isToolResultEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolResultData } {
  return event.type === 'tool/result'
}

/** Narrow a session event to one model-requested tool invocation. */
export function isToolCallEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolCallData } {
  return event.type === 'tool/call'
}

/** Join the text blocks of a committed assistant message. */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join('')
}

/** The model that produced a committed message, when the payload names it. */
export function assistantModel(data: AssistantMessageData): string | undefined {
  const model = data.message.source?.model
  return typeof model === 'string' && model !== '' ? model : undefined
}

/** The call one result answers. */
export function toolResultCallId(data: ToolResultData): string | undefined {
  const block = data.message.content[0]
  return block?.toolCallId ?? data.message.source?.callId
}

/** Closed outcome of a host approval question; allowed-once is the only grant. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Readonly same-process permission question subset. */
export interface HostApprovalRequest {
  readonly agent: HostAgent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via inject. */
    agents: HostAgentRegistry
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
    /** Waterfall permission question; answer only for owned agents, else delegate via next(). */
    'approval/request'(
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
    /** Registry notification: any command registration changed (used to re-sync the slash panel). */
    'commands/change'(): void
  }
}
