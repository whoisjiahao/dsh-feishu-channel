/** Interactive Feishu cards for inspecting and changing one session's model settings. */
import type { HostModelDirectory, HostModelSelection } from './host.ts';
/** Marker distinguishing model-setting selectors from other card actions. */
export declare const MODEL_SETTING_ACTION = "dsh-feishu-channel/model-setting";
/** Which setting one selector changes. */
export type ModelSettingKind = 'model' | 'effort';
/** One server-approved option shown by a model-setting selector. */
export interface ModelSettingChoice {
    readonly value: string;
    readonly label: string;
    readonly selection: HostModelSelection;
}
/** Compact callback payload; the actual allowed selections remain server-side. */
export interface ModelSettingActionValue {
    readonly kind: typeof MODEL_SETTING_ACTION;
    readonly id: string;
}
/** Narrow one arbitrary card-action value to a model-setting callback. */
export declare function modelSettingActionValue(value: unknown): ModelSettingActionValue | undefined;
/** Build exact server-approved choices for one selector. */
export declare function modelSettingChoices(directory: HostModelDirectory, kind: ModelSettingKind): ModelSettingChoice[];
/** Build a native Feishu dropdown card showing the current value and choices. */
export declare function modelSettingCard(directory: HostModelDirectory, kind: ModelSettingKind, id: string, choices: readonly ModelSettingChoice[]): object;
/** Replace a used selector with an unambiguous settled result. */
export declare function settledModelSettingCard(kind: ModelSettingKind, selected: HostModelSelection): object;
/** Replace a failed selector with a clear retry instruction. */
export declare function failedModelSettingCard(kind: ModelSettingKind, detail: string): object;
//# sourceMappingURL=model-card.d.ts.map