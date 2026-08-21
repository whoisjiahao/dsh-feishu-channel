import { describe, expect, it, vi } from 'vitest'
import {
  startOnboarding,
  type RegisterAppPort,
} from '../src/onboarding.ts'

describe('OnboardingFlow', () => {
  it('claims credentials were saved only after persistence succeeds', async () => {
    const notices: string[] = []
    const onCredentials = vi.fn()
    const flow = startOnboarding({
      register: successfulRegistration(),
      notify: line => notices.push(line),
      persist: vi.fn(async () => true),
      onCredentials,
    })

    await flow.completed

    expect(notices).toContain('feishu-channel: 扫码成功，凭据已保存，正在连接…')
    expect(onCredentials).toHaveBeenCalledTimes(1)
    expect(notices.join('\n')).not.toContain('sec_private')
  })

  it('connects without claiming persistence when no settings store exists', async () => {
    const notices: string[] = []
    const onCredentials = vi.fn()
    const flow = startOnboarding({
      register: successfulRegistration(),
      notify: line => notices.push(line),
      persist: vi.fn(async () => false),
      onCredentials,
    })

    await flow.completed

    expect(notices.some(line => line.includes('凭据已保存'))).toBe(false)
    expect(notices).toContain('feishu-channel: 扫码成功，凭据未持久化，正在连接…')
    expect(onCredentials).toHaveBeenCalledTimes(1)
  })

  it('waits for the reissue floor after an expired code', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const register: RegisterAppPort = vi.fn(async request => {
      attempts += 1
      request.onQRCodeReady({ url: 'https://qr.example/' + attempts, expireIn: 300 })
      if (attempts === 1) throw { code: 'expired_token', description: 'expired' }
      return { client_id: 'cli_new', client_secret: 'sec_private' }
    })
    const flow = startOnboarding({
      register,
      notify: vi.fn(),
      persist: vi.fn(async () => true),
      onCredentials: vi.fn(),
      reissueFloorMs: 1_000,
    })

    try {
      await vi.advanceTimersByTimeAsync(999)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await flow.completed
      expect(attempts).toBe(2)
    } finally {
      flow.close()
      vi.useRealTimers()
    }
  })

  it('does not persist, announce, or connect after close', async () => {
    let finish!: (value: {
      client_id: string
      client_secret: string
    }) => void
    let request: Parameters<RegisterAppPort>[0] | undefined
    const register: RegisterAppPort = vi.fn(options => {
      request = options
      return new Promise<{ client_id: string; client_secret: string }>(resolve => { finish = resolve })
    })
    const persist = vi.fn(async () => true)
    const onCredentials = vi.fn()
    const notices: string[] = []
    const flow = startOnboarding({
      register,
      notify: line => notices.push(line),
      persist,
      onCredentials,
    })
    await vi.waitFor(() => { expect(request).toBeDefined() })

    flow.close()
    request!.onQRCodeReady({ url: 'https://qr.after-close', expireIn: 300 })
    finish({ client_id: 'cli_late', client_secret: 'sec_late' })
    await flow.completed

    expect(persist).not.toHaveBeenCalled()
    expect(onCredentials).not.toHaveBeenCalled()
    expect(notices.join('\n')).not.toContain('qr.after-close')
  })
})

function successfulRegistration(): RegisterAppPort {
  return vi.fn(async request => {
    request.onQRCodeReady({ url: 'https://qr.example', expireIn: 300 })
    return {
      client_id: 'cli_new',
      client_secret: 'sec_private',
      user_info: { open_id: 'ou_owner' },
    }
  })
}
