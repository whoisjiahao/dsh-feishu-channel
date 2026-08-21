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
    attachImages?: boolean;
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
    attachImages: boolean;
    syncSlashCommands: boolean;
    denyTools: string[];
    requireMention: boolean;
    senderAllowlist: string[];
    groupAllowlist: string[];
    approvers: string[];
    footerFields: string[];
    maxTimelineItems: number;
    tableOverflowMode: 'compact' | 'truncate';
}
/** Loader-visible configuration schema and defaults. */
export declare const Config: z<Config>;
/** Defaults for direct callers that bypass the Cordis Loader. */
export declare function resolveConfig(config: Config): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map