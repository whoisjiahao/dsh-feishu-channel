import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { internals } from '../src/runtime.ts'
import { createFakeAgents, createFakePort, INBOUND_SUBSCRIPTIONS } from './harness.ts'

/** Boot the real plugin through Loader's namespace normalization over local fakes. */
export async function bootThroughLoader() {
  const ctx = new Context()
  const fake = createFakePort()
  const agents = createFakeAgents()
  const cwd = await mkdtemp(join(tmpdir(), 'feishu-loader-test-'))
  ctx.provide('agents', agents.service)

  const originalCreatePort = internals.createPort
  const originalNotify = internals.notify
  internals.createPort = () => fake.port
  internals.notify = () => undefined

  const loaderFiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
  const normalized = ctx.loader.unwrapExports(plugin) as Parameters<Context['plugin']>[0]
  const pluginFiber = await ctx.plugin(normalized, {
    appId: 'cli_loader_test',
    appSecret: 'loader-test-secret',
    cwd,
  })
  await vi.waitFor(() => {
    if (fake.state.subscriptions !== INBOUND_SUBSCRIPTIONS) throw new Error('channel did not subscribe')
  })

  return {
    ctx,
    fake,
    agents,
    normalized,
    async dispose(): Promise<void> {
      try {
        await pluginFiber.dispose()
        await loaderFiber.dispose()
      } finally {
        internals.createPort = originalCreatePort
        internals.notify = originalNotify
        await rm(cwd, { recursive: true, force: true })
      }
    },
  }
}
