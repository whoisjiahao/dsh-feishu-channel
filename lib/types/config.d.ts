/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-feishu-channel/config
 */
import z from '@deepseek-ai/schemastery';
import type { SessionScope } from './conversation.ts';
/**
 * The default chat workspace directory: the user's home directory, portable
 * across operating systems (~/.dsh-feishu on unix-like hosts, the same
 * relative name under the user profile on Windows).
 */
export declare function defaultChatWorkspaceDir(): string;
/**
 * Half-open `HH:MM` wall-clock window in Beijing time (UTC+8), independent of
 * the host's timezone: `start` inclusive, `end` exclusive. An end earlier than
 * the start wraps past midnight.
 */
export interface TimeWindow {
    /** Inclusive window start, `HH:MM` (24-hour). */
    start: string;
    /** Exclusive window end, `HH:MM` (24-hour). */
    end: string;
}
/** Discounted per-1M-token prices applied while a turn's usage lands off-peak. */
export interface OffPeakPricing {
    /** Off-peak price per 1M cache-miss input tokens. */
    input: number;
    /** Off-peak price per 1M output tokens. */
    output: number;
    /** Off-peak price per 1M cache-hit input tokens; defaults to {@link input}. */
    cacheHitInput?: number;
}
/** Per-million-token price for one model, as configured by the deployment. */
export interface ModelPricing {
    /** Currency symbol prefixed to the rendered cost (default ¥). */
    currency?: string;
    /** Peak price per 1M cache-miss input tokens. */
    input: number;
    /** Peak price per 1M output tokens. */
    output: number;
    /**
     * Peak price per 1M cache-hit input tokens; defaults to {@link input}, so a
     * table without hit rates overestimates rather than underestimates.
     */
    cacheHitInput?: number;
    /**
     * Time-differentiated rates (DeepSeek 空闲时段): used, with an 空闲 marker on
     * the row, when the usage lands inside the deployment's off-peak windows.
     */
    offPeak?: OffPeakPricing;
}
/**
 * Built-in rates for the DeepSeek catalog — api-docs.deepseek.com pricing as
 * of the 2026-08-17 schedule: peak is Beijing 9:00–12:00 & 14:00–18:00,
 * off-peak (空闲) half price otherwise. Input rates are the cache-miss ones;
 * cache-hit inputs bill at `cacheHitInput`. Deployments override per model id;
 * an entry replaces the built-in one whole.
 */
export declare const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>>;
/**
 * DeepSeek's published peak schedule (api-docs.deepseek.com pricing): peak is
 * Beijing 9:00–12:00 and 14:00–18:00, so off-peak is the complement — the
 * midday and overnight windows below, billed at half price.
 */
export declare const DEFAULT_OFF_PEAK_WINDOWS: readonly TimeWindow[];
/** Plugin configuration supplied by the profile composition. */
export interface Config {
    /** Lark/Feishu app id (cli_...); absent (with no stored credential) starts first-boot QR registration. */
    appId?: string;
    /** Lark/Feishu app secret paired with appId. */
    appSecret?: string;
    /** Open-platform domain: open.feishu.cn (default) or open.larksuite.com. */
    domain?: string;
    /** Absolute workspace directory for chat-driven agents; defaults to the host process cwd. */
    cwd?: string;
    /** Provider route override for chat agents. */
    provider?: string;
    /** Model id override for chat agents. */
    model?: string;
    /** Agent preset chat agents join, when the deployment composes a roster. */
    preset?: string;
    /**
     * Which conversation facet owns one agent session. The session id derives
     * from that facet alone, so a restarted process reaches the conversation's
     * stored session. chat gives a group one shared agent; chat-thread gives
     * each topic thread its own; chat-sender gives each person in a shared chat
     * their own.
     */
    sessionScope?: SessionScope;
    /** Show what the agent did on its way to an answer. */
    showProcess?: boolean;
    /** Pass images a chat sends on to the model. Off by default. */
    /** Register this channel's commands on the bot's slash panel. */
    syncSlashCommands?: boolean;
    /** Tools chat agents may not call, denied per agent at execution. */
    denyTools?: string[];
    /** In group chats, only respond when the bot is @-mentioned. */
    requireMention?: boolean;
    /** Open ids (ou_...) allowed to send direct messages. Empty serves anyone the app is visible to. */
    senderAllowlist?: string[];
    /** Group chat ids (oc_...) served. Empty serves any group the bot is in. */
    groupAllowlist?: string[];
    /** Open ids allowed to answer approval questions. Empty lets whoever may drive that chat answer. */
    approvers?: string[];
    /** Head-meta fields shown in the status-row disclosure (duration stays in the row). */
    footerFields?: string[];
    /**
     * Per-model token prices keyed by the card's model id; entries add the 费用
     * row to the status-row disclosure. Merged over {@link DEFAULT_PRICING} by
     * model id (a configured entry replaces the built-in one whole), so the
     * DeepSeek catalog bills out of the box and other models join by config.
     */
    pricing?: Record<string, ModelPricing>;
    /**
     * Beijing-time windows (UTC+8) that decide when a priced model's `offPeak`
     * rates apply. Defaults to DeepSeek's published schedule; override for other
     * providers or schedule changes. `[]` disables off-peak billing.
     */
    offPeakWindows?: TimeWindow[];
    /** Maximum timeline items shown before folding. */
    maxTimelineItems?: number;
    /** Table overflow policy beyond the card's table budget. */
    tableOverflowMode?: 'compact' | 'truncate';
}
/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
    appId?: string | undefined;
    appSecret?: string | undefined;
    domain?: string | undefined;
    /** Absolute workspace directory for chat-driven agents; defaults to the user's .dsh-feishu directory. */
    cwd: string;
    provider?: string | undefined;
    model?: string | undefined;
    preset?: string | undefined;
    sessionScope: SessionScope;
    showProcess: boolean;
    syncSlashCommands: boolean;
    denyTools: string[];
    requireMention: boolean;
    senderAllowlist: string[];
    groupAllowlist: string[];
    approvers: string[];
    footerFields: string[];
    pricing: Record<string, ModelPricing>;
    offPeakWindows: TimeWindow[];
    maxTimelineItems: number;
    tableOverflowMode: 'compact' | 'truncate';
}
/** Loader-visible configuration schema and defaults. */
export declare const Config: z<Config>;
/** Defaults for direct callers that bypass the Cordis Loader. */
export declare function resolveConfig(config: Config): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map