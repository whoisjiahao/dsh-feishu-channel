/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-feishu-channel/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { SessionScope } from './conversation.ts'

/**
 * Human-interaction tools whose answer cannot reach a chat: both ask through
 * ctx.userQuestions, whose single provider belongs to whichever UI registered
 * it first. Denied per chat agent so the model asks in the chat instead.
 */
const DEFAULT_DENY_TOOLS = ['ask_user_question', 'exit_plan_mode'] as const

/**
 * The default chat workspace directory: the user's home directory, portable
 * across operating systems (~/.dsh-feishu on unix-like hosts, the same
 * relative name under the user profile on Windows).
 */
export function defaultChatWorkspaceDir(): string {
  return join(homedir(), '.dsh-feishu')
}

/** Plugin configuration supplied by the profile composition. */
export interface Config {
  /** Lark/Feishu app id (cli_...); absent (with no stored credential) starts first-boot QR registration. */
  appId?: string
  /** Lark/Feishu app secret paired with appId. */
  appSecret?: string
  /** Open-platform domain: open.feishu.cn (default) or open.larksuite.com. */
  domain?: string
  /** Absolute workspace directory for chat-driven agents; defaults to the host process cwd. */
  cwd?: string
  /** Provider route override for chat agents. */
  provider?: string
  /** Model id override for chat agents. */
  model?: string
  /** Agent preset chat agents join, when the deployment composes a roster. */
  preset?: string
  /**
   * Which conversation facet owns one agent session. The session id derives
   * from that facet alone, so a restarted process reaches the conversation's
   * stored session. chat gives a group one shared agent; chat-thread gives
   * each topic thread its own; chat-sender gives each person in a shared chat
   * their own.
   */
  sessionScope?: SessionScope
  /** Show what the agent did on its way to an answer. */
  showProcess?: boolean
  /** Pass images a chat sends on to the model. Off by default. */
  attachImages?: boolean
  /** Register this channel's commands on the bot's slash panel. */
  syncSlashCommands?: boolean
  /** Tools chat agents may not call, denied per agent at execution. */
  denyTools?: string[]
  /** In group chats, only respond when the bot is @-mentioned. */
  requireMention?: boolean
  /** Open ids (ou_...) allowed to send direct messages. Empty serves anyone the app is visible to. */
  senderAllowlist?: string[]
  /** Group chat ids (oc_...) served. Empty serves any group the bot is in. */
  groupAllowlist?: string[]
  /** Open ids allowed to answer approval questions. Empty lets whoever may drive that chat answer. */
  approvers?: string[]
  /** Head-meta fields shown in the status-row disclosure (duration stays in the row). */
  footerFields?: string[]
  /** Maximum timeline items shown before folding. */
  maxTimelineItems?: number
  /** Table overflow policy beyond the card's table budget. */
  tableOverflowMode?: 'compact' | 'truncate'
}

/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
  appId?: string | undefined
  appSecret?: string | undefined
  domain?: string | undefined
  /** Absolute workspace directory for chat-driven agents; defaults to the user's .dsh-feishu directory. */
  cwd: string
  provider?: string | undefined
  model?: string | undefined
  preset?: string | undefined
  sessionScope: SessionScope
  showProcess: boolean
  attachImages: boolean
  syncSlashCommands: boolean
  denyTools: string[]
  requireMention: boolean
  senderAllowlist: string[]
  groupAllowlist: string[]
  approvers: string[]
  footerFields: string[]
  maxTimelineItems: number
  tableOverflowMode: 'compact' | 'truncate'
}

/** Loader-visible configuration schema and defaults. */
export const Config: z<Config> = z.object({
  appId: z.string(),
  appSecret: z.string().role('secret'),
  domain: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string(),
  preset: z.string(),
  sessionScope: z.union(['chat', 'chat-thread', 'chat-sender'] as const).default('chat'),
  showProcess: z.boolean().default(true),
  attachImages: z.boolean().default(false),
  syncSlashCommands: z.boolean().default(true),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
  requireMention: z.boolean().default(true),
  senderAllowlist: z.array(String),
  groupAllowlist: z.array(String),
  approvers: z.array(String),
  footerFields: z.array(String),
  maxTimelineItems: z.number(),
  tableOverflowMode: z.union(['compact', 'truncate'] as const),
})

/** Defaults for direct callers that bypass the Cordis Loader. */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    cwd: config.cwd ?? defaultChatWorkspaceDir(),
    provider: config.provider,
    model: config.model,
    preset: config.preset,
    sessionScope: config.sessionScope ?? 'chat',
    showProcess: config.showProcess ?? true,
    attachImages: config.attachImages ?? false,
    syncSlashCommands: config.syncSlashCommands ?? true,
    denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
    requireMention: config.requireMention ?? true,
    senderAllowlist: config.senderAllowlist ?? [],
    groupAllowlist: config.groupAllowlist ?? [],
    approvers: config.approvers ?? [],
    footerFields: config.footerFields ?? ['duration', 'model', 'input_tokens', 'output_tokens', 'context'],
    maxTimelineItems: config.maxTimelineItems ?? 12,
    tableOverflowMode: config.tableOverflowMode ?? 'compact',
  }
}
