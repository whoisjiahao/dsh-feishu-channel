import { describe, expect, it } from 'vitest'
import { Config as ConfigSchema, defaultChatWorkspaceDir, resolveConfig, type Config } from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const resolved = resolveConfig({})
    // The chat workspace defaults to the user's home directory, portably.
    expect(resolved.cwd).toBe(defaultChatWorkspaceDir())
    expect(resolved.cwd).toContain('.dsh-feishu')
    expect(resolved.sessionScope).toBe('chat')
    expect(resolved.showProcess).toBe(true)
    expect(resolved.attachImages).toBe(false)
    expect(resolved.requireMention).toBe(true)
    expect(resolved.denyTools).toContain('ask_user_question')
    expect(resolved.maxTimelineItems).toBe(12)
    expect(resolved.tableOverflowMode).toBe('compact')
  })

  it('keeps explicit values', () => {
    const config: Config = {
      sessionScope: 'chat-thread',
      senderAllowlist: ['ou_1'],
      appId: 'cli_x',
      cwd: '/srv/feishu-workspace',
    }
    const resolved = resolveConfig(config)
    expect(resolved.cwd).toBe('/srv/feishu-workspace')
    expect(resolved.sessionScope).toBe('chat-thread')
    expect(resolved.senderAllowlist).toEqual(['ou_1'])
    expect(resolved.appId).toBe('cli_x')
  })

  it('does not retain removed configuration fields', () => {
    const stale = {
      output: 'card',
      title: 'legacy',
      maxReasoningChars: 100,
      maxToolResultChars: 100,
    } as unknown as Config

    expect(resolveConfig(stale)).not.toMatchObject(stale)
    expect(resolveConfig(ConfigSchema(stale))).not.toMatchObject(stale)
  })
})
