/** Interactive Feishu cards for inspecting and changing one session's permission preset. */

import type { HostPermissionSelect } from './host.ts'
import {
  interactiveCard,
  interactiveDivider,
  interactiveFieldRow,
  interactivePlainSection,
  interactiveStatusLine,
} from './card-design.ts'

/** Marker distinguishing permission-setting selectors from other card actions. */
export const PERMISSION_SETTING_ACTION = 'dsh-feishu-channel/permission-setting'

/** DSH's derived current-only state; it is descriptive, not a writable preset. */
const CUSTOM_PERMISSION = 'custom'

/** The preset whose unsandboxed behavior requires an additional confirmation. */
export const FULL_ACCESS_PERMISSION = 'danger-full-access'

/** One server-approved permission option shown by the selector. */
export interface PermissionSettingChoice {
  readonly value: string
  readonly label: string
  readonly description?: string | undefined
}

type PermissionSettingAction = 'select' | 'confirm' | 'cancel'

/** Compact callback payload; the allowed choices remain server-side. */
export interface PermissionSettingActionValue {
  readonly kind: typeof PERMISSION_SETTING_ACTION
  readonly id: string
  readonly action: PermissionSettingAction
}

/** Narrow one arbitrary card-action value to a permission-setting callback. */
export function permissionSettingActionValue(value: unknown): PermissionSettingActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== PERMISSION_SETTING_ACTION || typeof record.id !== 'string') return undefined
  if (record.action !== 'select' && record.action !== 'confirm' && record.action !== 'cancel') return undefined
  return { kind: PERMISSION_SETTING_ACTION, id: record.id, action: record.action }
}

/** Preserve the host's option order while excluding the non-writable custom state. */
export function permissionSettingChoices(select: HostPermissionSelect): PermissionSettingChoice[] {
  return select.options
    .filter(option => option.value !== CUSTOM_PERMISSION)
    .map(option => ({
      value: option.value,
      label: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
    }))
}

/** Build a native Feishu dropdown from the session's permission projection. */
export function permissionSettingCard(
  select: HostPermissionSelect,
  id: string,
  choices: readonly PermissionSettingChoice[],
): object {
  return interactiveCard([
    interactiveStatusLine('权限设置', '请选择', 'info'),
    interactiveDivider(),
    interactiveFieldRow('当前权限', select.currentValue),
    {
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择权限预设' },
        options: choices.map(choice => ({
          text: { tag: 'plain_text', content: choice.label.slice(0, 120) },
          value: choice.value,
        })),
        value: { kind: PERMISSION_SETTING_ACTION, id, action: 'select' },
      }],
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '选择后将作用于当前会话；高风险权限需要再次确认。' }],
    },
  ])
}

/** Require a second explicit click before enabling unrestricted access. */
export function permissionConfirmationCard(choice: PermissionSettingChoice, id: string): object {
  return interactiveCard([
    interactiveStatusLine('权限设置', '高风险', 'warning'),
    interactiveDivider(),
    interactiveFieldRow('将切换为', choice.value),
    ...interactivePlainSection(
      '风险说明',
      choice.description ?? '该预设允许命令脱离工作区沙箱执行，请确认这是你的明确选择。',
    ),
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '确认启用' },
          type: 'danger',
          value: { kind: PERMISSION_SETTING_ACTION, id, action: 'confirm' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回' },
          type: 'default',
          value: { kind: PERMISSION_SETTING_ACTION, id, action: 'cancel' },
        },
      ],
    },
  ])
}

/** Replace a used selector with the chosen current value. */
export function settledPermissionSettingCard(choice: PermissionSettingChoice): object {
  return interactiveCard([
    interactiveStatusLine('权限设置', '已完成', 'success'),
    interactiveDivider(),
    interactiveFieldRow('当前权限', choice.value),
    ...(choice.description === undefined
      ? []
      : [{ tag: 'note', elements: [{ tag: 'plain_text', content: choice.description }] }]),
  ])
}

/** Replace a failed selector with a bounded retry instruction. */
export function failedPermissionSettingCard(detail: string): object {
  return interactiveCard([
    interactiveStatusLine('权限设置', '失败', 'failure'),
    interactiveDivider(),
    { tag: 'div', text: { tag: 'plain_text', content: detail.slice(0, 300) } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '请重新输入 /permission 再试。' }] },
  ])
}
