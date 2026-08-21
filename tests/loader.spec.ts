import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as invariant from '../src/invariant.ts'
import * as plugin from '../src/index.ts'
import { bootThroughLoader } from './loader-fixture.ts'

let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

describe('real Loader normalization path', () => {
  it('keeps the namespace plugin intact and starts then stops the channel', async () => {
    const mounted = await bootThroughLoader()
    dispose = mounted.dispose

    expect(mounted.normalized).toBe(plugin)
    expect(mounted.fake.state.connected).toBe(true)
    expect(mounted.fake.state.subscriptions).toBe(6)

    await mounted.dispose()
    dispose = undefined
    expect(mounted.fake.state.connected).toBe(false)
    expect(mounted.fake.state.subscriptions).toBe(0)
    expect(mounted.fake.state.disconnects).toBe(1)
  })

  it('normalizes and composes the package-owned invariant companion', async () => {
    const ctx = new Context()
    const registrations: string[] = []
    const disposed: string[] = []
    ctx.provide('invariants', {
      register(packageName: string) {
        registrations.push(packageName)
        return () => { disposed.push(packageName) }
      },
    })
    const loaderFiber = await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const normalized = ctx.loader.unwrapExports(invariant) as Parameters<Context['plugin']>[0]
    const invariantFiber = await ctx.plugin(normalized)

    expect(normalized).toBe(invariant)
    expect(registrations).toEqual(['dsh-feishu-channel'])
    await invariantFiber.dispose()
    expect(disposed).toEqual(['dsh-feishu-channel'])
    await loaderFiber.dispose()
  })
})
