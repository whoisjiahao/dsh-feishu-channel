import { describe, expect, it } from 'vitest'
import {
  Config as ConfigSchema,
  DEFAULT_OFF_PEAK_WINDOWS,
  DEFAULT_PRICING,
  defaultChatWorkspaceDir,
  resolveConfig,
  type Config,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const resolved = resolveConfig({})
    // The chat workspace defaults to the user's home directory, portably.
    expect(resolved.cwd).toBe(defaultChatWorkspaceDir())
    expect(resolved.cwd).toContain('.dsh-feishu')
    expect(resolved.sessionScope).toBe('chat')
    expect(resolved.showProcess).toBe(true)
    expect(resolved.requireMention).toBe(true)
    expect(resolved.denyTools).toContain('ask_user_question')
    expect(resolved.maxTimelineItems).toBe(12)
    expect(resolved.tableOverflowMode).toBe('compact')
    expect(resolved.pricing).toEqual(structuredClone(DEFAULT_PRICING))
    expect(resolved.offPeakWindows).toEqual(DEFAULT_OFF_PEAK_WINDOWS.map(window => ({ ...window })))
  })

  it('keeps explicit values', () => {
    const config: Config = {
      sessionScope: 'chat-thread',
      senderAllowlist: ['ou_1'],
      appId: 'cli_x',
      cwd: '/srv/feishu-workspace',
      pricing: { 'deepseek-chat': { input: 2, output: 8 } },
      offPeakWindows: [{ start: '23:00', end: '06:00' }],
    }
    const resolved = resolveConfig(config)
    expect(resolved.cwd).toBe('/srv/feishu-workspace')
    expect(resolved.sessionScope).toBe('chat-thread')
    expect(resolved.senderAllowlist).toEqual(['ou_1'])
    expect(resolved.appId).toBe('cli_x')
    // Explicit entries merge over the built-in DeepSeek table by model id.
    expect(resolved.pricing['deepseek-chat']).toEqual({ input: 2, output: 8 })
    expect(resolved.pricing['deepseek-v4-pro']).toEqual(DEFAULT_PRICING['deepseek-v4-pro'])
    expect(resolved.offPeakWindows).toEqual([{ start: '23:00', end: '06:00' }])
  })

  it('lets an explicit entry replace a built-in one whole', () => {
    const resolved = resolveConfig({
      pricing: { 'deepseek-v4-flash': { input: 5, output: 20 } },
    })
    expect(resolved.pricing['deepseek-v4-flash']).toEqual({ input: 5, output: 20 })
    expect(resolved.pricing['deepseek-v4-flash']?.offPeak).toBeUndefined()
    expect(resolved.pricing['deepseek-v4-pro']).toBeDefined()
  })

  it('seeds off-peak windows through schema validation (the loader path)', () => {
    // Regression: schema validation materializes missing keys as [] / {},
    // which used to disable off-peak billing entirely while pricing kept its
    // defaults via the resolveConfig merge. The loader path is
    // validate-then-resolve, so assert both stages.
    const validated = ConfigSchema({ appId: 'cli_x', appSecret: 's' })
    expect(validated.pricing).toEqual({})
    expect(validated.offPeakWindows).toEqual(DEFAULT_OFF_PEAK_WINDOWS.map(window => ({ ...window })))
    expect(resolveConfig(validated).pricing).toEqual(structuredClone(DEFAULT_PRICING))
    expect(resolveConfig(validated).offPeakWindows).toEqual(DEFAULT_OFF_PEAK_WINDOWS.map(window => ({ ...window })))
  })

  it('rejects malformed off-peak window bounds', () => {
    for (const bad of ['9点', '24:00', '12:60', 'noon', '']) {
      const config = { offPeakWindows: [{ start: bad!, end: '06:00' }] } as unknown as Config
      expect(() => resolveConfig(config)).toThrow(/offPeakWindows.*HH:MM/)
    }
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
