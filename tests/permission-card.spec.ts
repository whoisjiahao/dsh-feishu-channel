import { describe, expect, it } from 'vitest'
import {
  PERMISSION_SETTING_ACTION,
  permissionConfirmationCard,
  permissionSettingActionValue,
  permissionSettingCard,
  permissionSettingChoices,
  settledPermissionSettingCard,
} from '../src/permission-card.ts'
import type { HostPermissionSelect } from '../src/host.ts'

const permissions: HostPermissionSelect = {
  currentValue: 'workspace-write',
  options: [
    { value: 'read-only', name: 'Read only', description: 'Read files without changing them.' },
    { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Run without sandbox restrictions.' },
  ],
}

describe('permission setting cards', () => {
  it('renders only host-advertised presets and marks the current value', () => {
    const choices = permissionSettingChoices(permissions)
    const card = permissionSettingCard(permissions, 'permission-1', choices) as any

    expect(choices.map(choice => choice.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])
    expect(card.elements[2].fields[1].text.content).toBe('workspace-write')
    expect(card.elements[3].actions[0]).toMatchObject({
      tag: 'select_static',
      value: { kind: PERMISSION_SETTING_ACTION, id: 'permission-1', action: 'select' },
    })
    expect(card.elements[3].actions[0].options.map((option: any) => option.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])
  })

  it('does not advertise the derived custom state as a writable preset', () => {
    const choices = permissionSettingChoices({
      currentValue: 'custom',
      options: [...permissions.options, { value: 'custom', name: 'Custom' }],
    })

    expect(choices.map(choice => choice.value)).not.toContain('custom')
  })

  it('requires a second explicit confirmation before full access', () => {
    const choice = permissionSettingChoices(permissions)[2]!
    const card = permissionConfirmationCard(choice, 'permission-1') as any

    expect(card.elements[0].text.content).toContain("<text_tag color='orange'>高风险</text_tag>")
    expect(card.elements.find((element: any) => element.tag === 'action').actions
      .map((action: any) => action.value)).toEqual([
      { kind: PERMISSION_SETTING_ACTION, id: 'permission-1', action: 'confirm' },
      { kind: PERMISSION_SETTING_ACTION, id: 'permission-1', action: 'cancel' },
    ])
  })

  it('renders a settled permission value and rejects malformed callbacks', () => {
    const card = settledPermissionSettingCard({
      value: 'read-only',
      label: 'Read only',
      description: 'Read files without changing them.',
    }) as any

    expect(card.elements[0].text.content).toContain("<text_tag color='green'>已完成</text_tag>")
    expect(card.elements[2].fields[1].text.content).toBe('read-only')
    expect(permissionSettingActionValue({
      kind: PERMISSION_SETTING_ACTION,
      id: 'permission-1',
      action: 'select',
    })).toEqual({ kind: PERMISSION_SETTING_ACTION, id: 'permission-1', action: 'select' })
    expect(permissionSettingActionValue({
      kind: PERMISSION_SETTING_ACTION,
      id: 'permission-1',
      action: 'unknown',
    })).toBeUndefined()
  })
})
