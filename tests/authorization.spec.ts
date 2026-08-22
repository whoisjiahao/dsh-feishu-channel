import { describe, expect, it } from 'vitest'
import { refuseApprovalClick, refuseMessage, resolveAuthorization } from '../src/authorization.ts'
import { defaultChatWorkspaceDir, type ResolvedConfig } from '../src/config.ts'

const base: ResolvedConfig = {
  cwd: defaultChatWorkspaceDir(),
  sessionScope: 'chat',
  showProcess: true,
  syncSlashCommands: true,
  denyTools: [],
  requireMention: true,
  senderAllowlist: [],
  groupAllowlist: [],
  approvers: [],
  footerFields: [],
  pricing: {},
  offPeakWindows: [],
  maxTimelineItems: 12,
  tableOverflowMode: 'compact',
}

describe('refuseMessage', () => {
  it('serves everyone when lists are empty', () => {
    const auth = resolveAuthorization(base)
    expect(refuseMessage(auth, { senderId: 'ou_1', chatId: 'oc_1', chatType: 'p2p' })).toBeUndefined()
    expect(refuseMessage(auth, { senderId: 'ou_1', chatId: 'oc_1', chatType: 'group' })).toBeUndefined()
  })

  it('narrows direct senders', () => {
    const auth = resolveAuthorization({ ...base, senderAllowlist: ['ou_1'] })
    expect(refuseMessage(auth, { senderId: 'ou_1', chatId: 'oc_1', chatType: 'p2p' })).toBeUndefined()
    expect(refuseMessage(auth, { senderId: 'ou_2', chatId: 'oc_1', chatType: 'p2p' })).toContain('senderAllowlist')
  })

  it('narrows groups without gating members', () => {
    const auth = resolveAuthorization({ ...base, groupAllowlist: ['oc_1'] })
    expect(refuseMessage(auth, { senderId: 'ou_x', chatId: 'oc_1', chatType: 'group' })).toBeUndefined()
    expect(refuseMessage(auth, { senderId: 'ou_x', chatId: 'oc_2', chatType: 'group' })).toContain('groupAllowlist')
  })
})

describe('refuseApprovalClick', () => {
  it('requires the click chat to match the card chat', () => {
    const auth = resolveAuthorization(base)
    const refusal = refuseApprovalClick(
      auth,
      { operatorId: 'ou_1', chatId: 'oc_2' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )
    expect(refusal).toContain('does not match')
  })

  it('enforces the approvers list when set', () => {
    const auth = resolveAuthorization({ ...base, approvers: ['ou_1'] })
    expect(refuseApprovalClick(
      auth,
      { operatorId: 'ou_1', chatId: 'oc_1' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )).toBeUndefined()
    expect(refuseApprovalClick(
      auth,
      { operatorId: 'ou_2', chatId: 'oc_1' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )).toContain('approvers')
  })

  it('falls back to the chat authorization without approvers', () => {
    const auth = resolveAuthorization({ ...base, senderAllowlist: ['ou_1'] })
    expect(refuseApprovalClick(
      auth,
      { operatorId: 'ou_1', chatId: 'oc_1' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )).toBeUndefined()
    expect(refuseApprovalClick(
      auth,
      { operatorId: 'ou_2', chatId: 'oc_1' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )).toContain('senderAllowlist')
  })

  it('rejects clicks without an operator id', () => {
    const auth = resolveAuthorization(base)
    expect(refuseApprovalClick(
      auth,
      { operatorId: undefined, chatId: 'oc_1' },
      { chatId: 'oc_1', chatType: 'p2p' },
    )).toContain('no operator id')
  })
})
