/** Correlates Feishu messages with host turn events and immutable reply targets. */
import type { OwnedAgent } from './agent-registry.ts';
import type { ConversationKey, TurnTarget } from './conversation.ts';
import type { HostSessionEvent, HostUserMessage } from './host.ts';
/** One Feishu-submitted turn whose target and input cannot be overwritten. */
export interface CoordinatedTurn {
    readonly id: string;
    readonly target: TurnTarget;
    readonly owner: OwnedAgent;
    readonly message: HostUserMessage;
}
/**
 * Keeps turn correlation independent from rendering and transport. Host turn
 * numbers are learned from events, so queued messages bind FIFO per session.
 */
export declare class TurnCoordinator {
    private readonly queued;
    private readonly active;
    private readonly latest;
    private nextId;
    /** Queue one user message before handing it to the owned agent. */
    submit(owner: OwnedAgent, target: TurnTarget, message: HostUserMessage): CoordinatedTurn;
    /**
     * Replay only the latest turn of one exact conversation. A stale card id is
     * refused instead of borrowing a newer message.
     */
    retry(key: ConversationKey, turnId: string): CoordinatedTurn | undefined;
    /** Resolve one host event to the Feishu turn that submitted it. */
    route(sessionId: string, event: HostSessionEvent): CoordinatedTurn | undefined;
    /** Current Feishu-submitted turn allowed to own a host-side interaction. */
    current(sessionId: string): CoordinatedTurn | undefined;
    /** Drop queued, active, and retryable state for one conversation. */
    clear(key: ConversationKey): void;
    /** Drop all process-local turn correlation. */
    close(): void;
    private remove;
}
//# sourceMappingURL=turn-coordinator.d.ts.map