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

/**
 * Half-open `HH:MM` wall-clock window in Beijing time (UTC+8), independent of
 * the host's timezone: `start` inclusive, `end` exclusive. An end earlier than
 * the start wraps past midnight.
 */
export interface TimeWindow {
  /** Inclusive window start, `HH:MM` (24-hour). */
  start: string
  /** Exclusive window end, `HH:MM` (24-hour). */
  end: string
}

/** Discounted per-1M-token prices applied while a turn's usage lands off-peak. */
export interface OffPeakPricing {
  /** Off-peak price per 1M cache-miss input tokens. */
  input: number
  /** Off-peak price per 1M output tokens. */
  output: number
  /** Off-peak price per 1M cache-hit input tokens; defaults to {@link input}. */
  cacheHitInput?: number
}

/** Per-million-token price for one model, as configured by the deployment. */
export interface ModelPricing {
  /** Currency symbol prefixed to the rendered cost (default ¥). */
  currency?: string
  /** Peak price per 1M cache-miss input tokens. */
  input: number
  /** Peak price per 1M output tokens. */
  output: number
  /**
   * Peak price per 1M cache-hit input tokens; defaults to {@link input}, so a
   * table without hit rates overestimates rather than underestimates.
   */
  cacheHitInput?: number
  /**
   * Time-differentiated rates (DeepSeek 空闲时段): used, with an 空闲 marker on
   * the row, when the usage lands inside the deployment's off-peak windows.
   */
  offPeak?: OffPeakPricing
}

/**
 * Built-in rates for the DeepSeek catalog — api-docs.deepseek.com pricing as
 * of the 2026-08-17 schedule: peak is Beijing 9:00–12:00 & 14:00–18:00,
 * off-peak (空闲) half price otherwise. Input rates are the cache-miss ones;
 * cache-hit inputs bill at `cacheHitInput`. Deployments override per model id;
 * an entry replaces the built-in one whole.
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  'deepseek-v4-flash': {
    input: 3,
    output: 9,
    cacheHitInput: 0.1,
    offPeak: { input: 1.5, output: 4.5, cacheHitInput: 0.05 },
  },
  'deepseek-v4-flash-vision-exp': {
    input: 3,
    output: 9,
    cacheHitInput: 0.1,
    offPeak: { input: 1.5, output: 4.5, cacheHitInput: 0.05 },
  },
  'deepseek-v4-pro': {
    input: 9,
    output: 27,
    cacheHitInput: 0.3,
    offPeak: { input: 4.5, output: 13.5, cacheHitInput: 0.15 },
  },
}

/**
 * DeepSeek's published peak schedule (api-docs.deepseek.com pricing): peak is
 * Beijing 9:00–12:00 and 14:00–18:00, so off-peak is the complement — the
 * midday and overnight windows below, billed at half price.
 */
export const DEFAULT_OFF_PEAK_WINDOWS: readonly TimeWindow[] = [
  { start: '12:00', end: '14:00' },
  { start: '18:00', end: '09:00' },
]

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
  /**
   * Per-model token prices keyed by the card's model id; entries add the 费用
   * row to the status-row disclosure. Merged over {@link DEFAULT_PRICING} by
   * model id (a configured entry replaces the built-in one whole), so the
   * DeepSeek catalog bills out of the box and other models join by config.
   */
  pricing?: Record<string, ModelPricing>
  /**
   * Beijing-time windows (UTC+8) that decide when a priced model's `offPeak`
   * rates apply. Defaults to DeepSeek's published schedule; override for other
   * providers or schedule changes. `[]` disables off-peak billing.
   */
  offPeakWindows?: TimeWindow[]
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
  pricing: Record<string, ModelPricing>
  offPeakWindows: TimeWindow[]
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
  pricing: z.dict(z.object({
    currency: z.string(),
    input: z.number(),
    output: z.number(),
    offPeak: z.object({
      input: z.number(),
      output: z.number(),
    }),
  })),
  // Schema-level default: loader validation materializes missing keys as [],
  // and an empty array means "off-peak disabled" — without this default the
  // published schedule could never reach the runtime (measured in 0.6.2).
  offPeakWindows: z.array(z.object({
    start: z.string(),
    end: z.string(),
  })).default(DEFAULT_OFF_PEAK_WINDOWS.map(window => ({ ...window }))),
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
    footerFields: config.footerFields ?? ['duration', 'model', 'input_tokens', 'output_tokens', 'cost', 'context'],
    pricing: seededPricing(config.pricing),
    offPeakWindows: resolveOffPeakWindows(config.offPeakWindows),
    maxTimelineItems: config.maxTimelineItems ?? 12,
    tableOverflowMode: config.tableOverflowMode ?? 'compact',
  }
}

/**
 * Fresh built-in entries merged under the deployment's explicit ones: a
 * configured model id replaces the built-in entry whole; everything else
 * keeps billing out of the box. Copies defensively so callers cannot mutate
 * {@link DEFAULT_PRICING} through the resolved config.
 */
function seededPricing(explicit: Record<string, ModelPricing> | undefined): Record<string, ModelPricing> {
  const seeded: Record<string, ModelPricing> = {}
  for (const [id, price] of Object.entries(DEFAULT_PRICING)) {
    seeded[id] = { ...price, ...(price.offPeak !== undefined ? { offPeak: { ...price.offPeak } } : {}) }
  }
  return { ...seeded, ...explicit }
}

/**
 * Fail fast on malformed windows instead of silently never matching: each
 * bound must be a 24-hour `HH:MM`. An explicit `[]` disables off-peak billing.
 */
function resolveOffPeakWindows(windows: TimeWindow[] | undefined): TimeWindow[] {
  // Copy defensively: the schema default is a shared module-level literal.
  const resolved = (windows ?? DEFAULT_OFF_PEAK_WINDOWS).map(window => ({ ...window }))
  for (const window of resolved) {
    for (const bound of [window.start, window.end]) {
      if (parseClock(bound) === undefined) {
        throw new Error(`config.offPeakWindows: expected "HH:MM" (24-hour), got "${bound}"`)
      }
    }
  }
  return resolved
}

/** Minutes since midnight for a strict `H:MM`/`HH:MM` 24-hour clock string. */
function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}
