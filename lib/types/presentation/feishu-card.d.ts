/** Compose the frozen Feishu reply-card UI from one transport-free turn view. */
import type { TurnView } from './turn-view.ts';
import { type CardBudgetInspection } from './card-budget.ts';
/** Card-button payload marking this plugin's retry action. */
export declare const RETRY_ACTION = "dsh-feishu-channel/retry";
/** Card-button payload marking this plugin's copy-error action. */
export declare const COPY_ERROR_ACTION = "dsh-feishu-channel/copy-error";
/** Narrow an arbitrary card-action value to this plugin's retry payload. */
export declare function isRetryAction(value: unknown): value is {
    readonly kind: typeof RETRY_ACTION;
};
/** Narrow an arbitrary card-action value to this plugin's copy-error payload. */
export declare function isCopyErrorAction(value: unknown): value is {
    readonly kind: typeof COPY_ERROR_ACTION;
    readonly text: string;
};
/** Describe one tool call for a step row; falls back to the raw tool name. */
export type ToolPresenter = (name: string, argumentsJson: string) => {
    readonly title: string;
};
/** Options controlling card assembly. */
export interface CardRenderOptions {
    readonly showProcess: boolean;
    readonly maxTimelineItems: number;
    readonly tableOverflowMode: 'compact' | 'truncate';
    readonly footerFields: readonly string[];
    readonly timelineExpanded?: boolean;
    readonly presentCall?: ToolPresenter;
}
/** The assembled card plus the platform-limit verdict. */
export interface CardRenderResult {
    readonly card: object;
    readonly disposition: 'card' | 'native';
    readonly inspection: CardBudgetInspection;
    readonly limitReason: string;
}
/** Assemble a reply card, replacing an oversized result with the handoff card. */
export declare function renderCard(view: TurnView, options: CardRenderOptions): CardRenderResult;
/** Return one stable spinner frame for an integer index. */
export declare function spinnerFrame(index: number): string;
/** Derive the spinner frame from elapsed time without retaining timer state. */
export declare function spinnerFrameIndex(elapsedMs: number): number;
/** Format a live elapsed time in the same notation as terminal duration. */
export declare function formatClock(elapsedMs: number): string;
/** Format a local wall-clock time without seconds. */
export declare function formatWallClock(ms: number): string;
/** Format a local wall-clock time with seconds for timeline rows. */
export declare function formatStepTime(ms: number): string;
/** Render seconds as a compact h/m/s duration. */
export declare function formatDuration(seconds: number): string;
/** Format a token count with compact decimal suffixes. */
export declare function formatCount(value: number): string;
/** Build the compact card shown before native-message delivery. */
export declare function renderHandoffCard(terminal: boolean): object;
//# sourceMappingURL=feishu-card.d.ts.map