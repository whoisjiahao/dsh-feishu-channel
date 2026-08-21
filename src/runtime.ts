/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-feishu-channel/runtime
 */

import { createLarkChannel, registerApp } from '@larksuite/channel'
import type { LarkChannelOptions, PolicyConfig } from '@larksuite/channel'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { installChannel, type ChannelPort } from './channel.ts'
import type { PanelCommand, PanelCommandPage } from './slash-panel.ts'
import { startOnboarding } from './onboarding.ts'
import type {
  LarkCredentials,
  OnboardedApp,
  OnboardingFlow,
  RegisterAppPort,
} from './onboarding.ts'
import { describeAuthorization, resolveAuthorization } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import type { HostLoader, HostSettings } from './host.ts'

/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials

/** The app-config endpoint for the bot's slash-command panel. */
const SLASH_COMMAND_API = '/open-apis/application/v7/app_slash_commands'

/** The user-settings namespace holding this plugin's section. */
const SETTINGS_NAMESPACE = 'feishu-channel'

/** Narrow a resolved configuration to one carrying live credentials. */
function hasCredentials(config: ResolvedConfig): config is ChannelConfig {
  return typeof config.appId === 'string' && config.appId !== ''
    && typeof config.appSecret === 'string' && config.appSecret !== ''
}

/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - the channel's authorization rules.
 * @returns the real @larksuite/channel client behind the channel's port surface.
 */
export function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort {
  // Transport-level defense in depth. The plugin's own inbound check is the
  // authority, but an allowlist the transport enforces never depends on this
  // plugin's handler being reached.
  const policy: PolicyConfig = { requireMention: config.requireMention }
  if (authorization.directSenders.size > 0) {
    policy.dmMode = 'allowlist'
    policy.dmAllowlist = [...authorization.directSenders]
  }
  if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist
  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    policy,
    source: 'dsh-feishu-channel',
  }
  if (config.domain !== undefined) options.domain = config.domain
  const channel = createLarkChannel(options)
  const raw = channel.rawClient as {
    request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>
  }
  return Object.assign(channel, {
    async listSlashCommands(pageToken?: string): Promise<PanelCommandPage> {
      const query = new URLSearchParams({ page_size: '50' })
      if (pageToken !== undefined) query.set('page_token', pageToken)
      const response = await raw.request({
        method: 'GET',
        url: SLASH_COMMAND_API + '?' + query.toString(),
      }) as {
        data?: {
          items?: { command?: string; command_id?: string }[]
          has_more?: boolean
          page_token?: string
        }
      }
      const commands: PanelCommand[] = (response.data?.items ?? [])
        .filter((item): item is { command: string; command_id: string } =>
          typeof item.command === 'string' && typeof item.command_id === 'string')
        .map(item => ({ command: item.command, commandId: item.command_id }))
      const next = response.data?.has_more === true ? response.data.page_token : undefined
      return {
        commands,
        ...(typeof next === 'string' && next !== '' ? { nextPageToken: next } : {}),
      }
    },
    async deleteSlashCommand(commandId: string): Promise<void> {
      await raw.request({ method: 'DELETE', url: SLASH_COMMAND_API + '/' + commandId })
    },
    async createSlashCommand(command: string, description: string): Promise<void> {
      await raw.request({
        method: 'POST',
        url: SLASH_COMMAND_API,
        data: { command, description: { default_value: description } },
      })
    },
  })
}

/** Substitutable production boundaries; tests replace them with fakes. */
export const internals: {
  createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort
  registerApp: RegisterAppPort
  notify: (line: string) => void
  reissueFloorMs?: number
} = {
  createPort: createLarkChannelPort,
  registerApp,
  notify: (line) => void process.stderr.write(line + '\n'),
}

/**
 * Apply the plugin to its Cordis context. With credentials configured the
 * transport connects directly; without them the QR registration flow runs
 * first and persists the scanned credentials through the host settings
 * service when one is composed.
 * @param ctx - scoped plugin context; requires the agents service.
 * @param config - configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  let active = true
  let started = false
  let onboarding: OnboardingFlow | undefined
  ctx.effect(() => () => {
    active = false
    onboarding?.close()
  }, 'feishu:lifetime')

  const start = (resolved: ChannelConfig): void => {
    if (!active || started) return
    started = true
    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))
    installChannel(ctx, resolved, internals.createPort(resolved, authorization), internals.notify, authorization)
  }

  const bootstrap = async (): Promise<void> => {
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    if (!active) return

    let resolved = resolveConfig(config)
    let persist = async (_app: OnboardedApp): Promise<boolean> => false
    const settings = ctx.get('settings') as HostSettings | undefined
    if (settings !== undefined) {
      try {
        const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config })
        resolved = resolveConfig(scope.get() as Config)
        persist = async (credentials) => {
          await scope.update(credentials)
          return true
        }
      } catch (error) {
        ctx.logger.error(
          'settings registration failed; continuing with entry config only: %s',
          error instanceof Error ? error.message : error,
        )
      }
    }

    if (hasCredentials(resolved)) {
      start(resolved)
      return
    }
    const base = resolved
    onboarding = startOnboarding({
      register: internals.registerApp,
      notify: internals.notify,
      persist,
      onCredentials: app => { start({ ...base, ...app }) },
      ...(resolved.appId === undefined ? {} : { appId: resolved.appId }),
      ...(internals.reissueFloorMs === undefined ? {} : { reissueFloorMs: internals.reissueFloorMs }),
    })
    void onboarding.completed.catch((error: unknown) => {
      ctx.logger.error('feishu-channel onboarding failed: %s', error instanceof Error ? error.message : error)
    })
  }

  void bootstrap().catch((error: unknown) => {
    ctx.logger.error('feishu-channel bootstrap failed: %s', error instanceof Error ? error.message : error)
  })
}
