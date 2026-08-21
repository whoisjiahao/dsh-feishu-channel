/** First-boot Feishu app registration through the official QR flow. */

import qrcode from 'qrcode-terminal'

export interface LarkCredentials {
  readonly appId: string
  readonly appSecret: string
}

export interface OnboardedApp extends LarkCredentials {
  readonly registeredBy?: string
}

interface RegistrationPreset {
  readonly name: string
  readonly desc: string
}

interface RegistrationCode {
  readonly url: string
  readonly expireIn: number
}

export interface RegisterAppRequest {
  readonly source: string
  readonly appId?: string
  readonly appPreset: RegistrationPreset
  readonly signal: AbortSignal
  readonly onQRCodeReady: (code: RegistrationCode) => void
}

interface RegistrationResult {
  readonly client_id: string
  readonly client_secret: string
  readonly user_info?: { readonly open_id?: string }
}

export type RegisterAppPort = (request: RegisterAppRequest) => Promise<RegistrationResult>

export interface OnboardingOptions {
  readonly register: RegisterAppPort
  readonly notify: (line: string) => void
  readonly persist: (app: OnboardedApp) => Promise<boolean>
  readonly onCredentials: (app: OnboardedApp) => void
  readonly appId?: string
  readonly reissueFloorMs?: number
}

/** Lifecycle handle owned by the runtime fiber. */
export interface OnboardingFlow {
  readonly completed: Promise<void>
  close(): void
}

const REGISTRATION_PRESET = {
  source: 'dsh-feishu-channel',
  appPreset: { name: 'DSH Agent', desc: 'DSH 会话机器人' },
}
const EXPIRED_CODE = 'expired_token'
const REISSUE_FLOOR_MS = 60_000

/** Start registration and return an explicit cancellation boundary. */
export function startOnboarding(options: OnboardingOptions): OnboardingFlow {
  const controller = new AbortController()
  const { signal } = controller
  const announcements = new Set<Promise<void>>()
  let lastIssuedAt = 0

  const announce = (url: string, expireIn: number): void => {
    lastIssuedAt = Date.now()
    if (signal.aborted) return
    const pending = announceQr(url, expireIn, signal, options.notify)
    announcements.add(pending)
    pending.finally(() => { announcements.delete(pending) }).catch(() => undefined)
  }

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      options.notify('feishu-channel: 未配置应用凭据，开始扫码注册流程…')
      let registered: Awaited<ReturnType<RegisterAppPort>>
      try {
        registered = await options.register({
          ...REGISTRATION_PRESET,
          ...(options.appId === undefined ? {} : { appId: options.appId }),
          signal,
          onQRCodeReady: info => { announce(info.url, info.expireIn) },
        })
      } catch (error) {
        if (signal.aborted) return
        if (registrationCode(error) !== EXPIRED_CODE) {
          options.notify('feishu-channel: 扫码注册失败: ' + errorDetail(error))
          return
        }
        const waitMs = Math.max(0, (options.reissueFloorMs ?? REISSUE_FLOOR_MS)
          - (Date.now() - lastIssuedAt))
        if (waitMs > 0) {
          options.notify('feishu-channel: 注册码意外过期，稍后重试')
          await abortableDelay(waitMs, signal)
        }
        continue
      }

      if (signal.aborted) return
      const app: OnboardedApp = {
        appId: registered.client_id,
        appSecret: registered.client_secret,
        ...(registered.user_info?.open_id === undefined
          ? {}
          : { registeredBy: registered.user_info.open_id }),
      }
      let saved = false
      try {
        saved = await options.persist(app)
      } catch (error) {
        if (signal.aborted) return
        options.notify('feishu-channel: 凭据保存失败: ' + errorDetail(error))
      }
      if (signal.aborted) return
      options.notify(saved
        ? 'feishu-channel: 扫码成功，凭据已保存，正在连接…'
        : 'feishu-channel: 扫码成功，凭据未持久化，正在连接…')
      options.onCredentials(app)
      return
    }
  }

  const completed = run().finally(async () => {
    await Promise.allSettled([...announcements])
  })
  return {
    completed,
    close() { controller.abort() },
  }
}

async function announceQr(
  url: string,
  expireIn: number,
  signal: AbortSignal,
  notify: (line: string) => void,
): Promise<void> {
  const drawn = await drawQrCode(url)
  if (signal.aborted) return
  notify('feishu-channel: 请用飞书扫码创建应用（' + Math.round(expireIn / 60) + ' 分钟内有效）:')
  if (drawn !== undefined) notify(drawn)
  notify('feishu-channel: 扫码页面: ' + url)
}

function drawQrCode(url: string): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      qrcode.generate(url, { small: true }, (drawn: string) => { resolve(drawn) })
    } catch {
      resolve(undefined)
    }
  })
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function registrationCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  const code = registrationCode(error)
  if (code === undefined) return String(error)
  const description = (error as { readonly description?: unknown }).description
  return typeof description === 'string' ? code + ': ' + description : code
}
