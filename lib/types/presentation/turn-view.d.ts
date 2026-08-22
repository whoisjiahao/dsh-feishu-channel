/**
 * Minimal render projection for one host turn.
 * @module dsh-feishu-channel/presentation/turn-view
 */
import type { HostSessionEvent } from '../host.ts';
/** State rendered by one reply card. */
export type TurnViewStatus = 'thinking' | 'in_progress' | 'completed' | 'failed';
/** Token counts used by the card metadata and cost rows. */
export interface TurnTokenUsage {
    /** Cache-miss input tokens; the host already subtracts cache reads. */
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Disjoint cache-hit input portion, billed at the hit rate when priced. */
    readonly cacheReadTokens?: number;
}
/** One renderable process row. Raw reasoning and tool-result bodies are excluded. */
export type TurnStep = {
    readonly kind: 'reasoning';
    readonly status: 'completed';
    readonly atMs: number;
} | {
    readonly kind: 'tool';
    readonly name: string;
    status: 'running' | 'completed' | 'failed';
    readonly argumentsJson: string;
    atMs: number;
};
/** Context retained before a turn starts. */
export interface InitialTurnContext {
    readonly model?: string | undefined;
    readonly contextWindow?: number | undefined;
}
/**
 * Fold host events into exactly the state consumed by the Feishu card.
 * The first turn/end event seals the projection; later events are ignored.
 */
export declare class TurnView {
    readonly turn: number;
    status: TurnViewStatus;
    answerText: string;
    model: string;
    readonly startedAt: number;
    finishedAt: number | undefined;
    durationMs: number;
    usage: TurnTokenUsage | undefined;
    /** When the usage-bearing message arrived: the billing-window anchor. */
    usageAtMs: number | undefined;
    contextWindow: number | undefined;
    errorCode: string;
    errorMessage: string;
    private readonly stepEntries;
    private readonly toolStepByCallId;
    private readonly seenMessages;
    private readonly answerFilter;
    constructor(turn: number, initialContext?: InitialTurnContext);
    /** Process rows in observation order. */
    get steps(): readonly TurnStep[];
    /** Fold one event into the projection. */
    observe(event: HostSessionEvent): void;
    private isTerminal;
    private markInProgress;
    private applyContext;
    private observeAssistantMessage;
    private observeToolCall;
    private observeToolResult;
    private finish;
}
//# sourceMappingURL=turn-view.d.ts.map