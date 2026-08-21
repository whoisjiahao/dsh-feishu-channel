/** Interactive Feishu cards for inspecting and changing one session's permission preset. */
import type { HostPermissionSelect } from './host.ts';
/** Marker distinguishing permission-setting selectors from other card actions. */
export declare const PERMISSION_SETTING_ACTION = "dsh-feishu-channel/permission-setting";
/** The preset whose unsandboxed behavior requires an additional confirmation. */
export declare const FULL_ACCESS_PERMISSION = "danger-full-access";
/** One server-approved permission option shown by the selector. */
export interface PermissionSettingChoice {
    readonly value: string;
    readonly label: string;
    readonly description?: string | undefined;
}
type PermissionSettingAction = 'select' | 'confirm' | 'cancel';
/** Compact callback payload; the allowed choices remain server-side. */
export interface PermissionSettingActionValue {
    readonly kind: typeof PERMISSION_SETTING_ACTION;
    readonly id: string;
    readonly action: PermissionSettingAction;
}
/** Narrow one arbitrary card-action value to a permission-setting callback. */
export declare function permissionSettingActionValue(value: unknown): PermissionSettingActionValue | undefined;
/** Preserve the host's option order while excluding the non-writable custom state. */
export declare function permissionSettingChoices(select: HostPermissionSelect): PermissionSettingChoice[];
/** Build a native Feishu dropdown from the session's permission projection. */
export declare function permissionSettingCard(select: HostPermissionSelect, id: string, choices: readonly PermissionSettingChoice[]): object;
/** Require a second explicit click before enabling unrestricted access. */
export declare function permissionConfirmationCard(choice: PermissionSettingChoice, id: string): object;
/** Replace a used selector with the chosen current value. */
export declare function settledPermissionSettingCard(choice: PermissionSettingChoice): object;
/** Replace a failed selector with a bounded retry instruction. */
export declare function failedPermissionSettingCard(detail: string): object;
export {};
//# sourceMappingURL=permission-card.d.ts.map