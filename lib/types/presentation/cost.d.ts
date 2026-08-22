/**
 * Turn-cost estimation from the configured per-model price table, including
 * DeepSeek-style time-differentiated (peak/off-peak) billing.
 * @module dsh-feishu-channel/presentation/cost
 */
import type { ModelPricing, TimeWindow } from '../config.ts';
import type { TurnTokenUsage } from './turn-view.ts';
/**
 * Render the 费用 disclosure-row value for one turn: reported usage times the
 * configured per-million-token prices of the turn's model. When the model has
 * `offPeak` rates and `atMs` falls inside one of the Beijing-time windows, the
 * discounted rates apply and the row gains an 空闲 marker. An empty string
 * means "no price covers this model" (or no usage yet), which the meta
 * renderer omits — an absent row, never a blank one.
 */
export declare function estimateCost(usage: TurnTokenUsage | undefined, pricing: Readonly<Record<string, ModelPricing>> | undefined, model: string, atMs: number | undefined, windows: readonly TimeWindow[] | undefined): string;
/** Whether `atMs` falls inside any half-open Beijing-time window. */
export declare function inOffPeak(atMs: number, windows: readonly TimeWindow[] | undefined): boolean;
//# sourceMappingURL=cost.d.ts.map