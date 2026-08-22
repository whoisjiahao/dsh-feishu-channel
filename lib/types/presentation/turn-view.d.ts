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
/**
 * One renderable process row. Raw reasoning and tool-result bodies are
 * excluded. `startedAtMs` is preserved for the step's whole life — the span
 * against `endedAtMs` is the per-step duration the timeline renders.
 */
export type TurnStep = {
    readonly kind: 'reasoning';
    status: 'thinking' | 'completed' | 'stopped';
    readonly startedAtMs: number;
    endedAtMs?: number;
} | {
    readonly kind: 'tool';
    readonly name: string;
    readonly argumentsJson: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    readonly startedAtMs: number;
    endedAtMs?: number;
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
    /** Open the live 思考中 row, or keep the already-open one (replay-safe). */
    private openOrKeepThinkingStep;
    private completeOrAddReasoningStep;
    private observeToolCall;
    private observeToolResult;
    private finish;
}
//# sourceMappingURL=turn-view.d.ts.map