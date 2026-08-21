/** Owned DSH agent lifecycle partitioned by Feishu conversation identity. */
import type { Context } from '@deepseek-ai/cordis';
import { type ConversationKey } from './conversation.ts';
import type { HostAgentHandle, HostAgentOptions, HostAgentRegistry, HostSessionPersistence, HostWorkspace } from './host.ts';
/** One agent this plugin created or resumed and therefore owns. */
export interface OwnedAgent {
    readonly conversationKey: ConversationKey;
    readonly handle: HostAgentHandle;
}
/** Host seams and per-agent composition used by the registry. */
export interface AgentRegistryOptions {
    readonly agents: HostAgentRegistry;
    readonly workspace?: HostWorkspace | undefined;
    readonly persistence?: HostSessionPersistence | undefined;
    readonly agentOptions?: HostAgentOptions | undefined;
    readonly meta?: {
        readonly cwd?: string;
        readonly agentPreset?: string;
    } | undefined;
    readonly setup?: ((agentCtx: Context) => Promise<void>) | undefined;
    readonly report?: ((line: string) => void) | undefined;
}
/**
 * Serializes lifecycle work per conversation while allowing unrelated
 * conversations to progress independently.
 */
export declare class AgentRegistry {
    private readonly options;
    private readonly current;
    private readonly conversationBySession;
    private readonly pending;
    private closed;
    private closing;
    constructor(options: AgentRegistryOptions);
    /** Return the current owned agent, opening it once when absent. */
    acquire(key: ConversationKey): Promise<OwnedAgent>;
    /** Replace one conversation generation and retire its previous owned agent. */
    reset(key: ConversationKey): Promise<OwnedAgent>;
    /** Whether this registry currently owns one exact host session. */
    ownsSession(sessionId: string): boolean;
    /** Whether an acquired handle is still the active generation for its conversation. */
    isCurrent(agent: OwnedAgent): boolean;
    /** The conversation key currently owning a host session, when any. */
    conversationOf(sessionId: string): ConversationKey | undefined;
    /** Dispose every owned handle after in-flight lifecycle work settles. */
    close(): Promise<void>;
    private exclusive;
    private restoreOrCreate;
    private create;
    private remember;
    private candidates;
    private attach;
    private detach;
    private report;
}
//# sourceMappingURL=agent-registry.d.ts.map