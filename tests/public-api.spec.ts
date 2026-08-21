import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as invariant from '../src/invariant.ts'
import * as plugin from '../src/index.ts'

describe('published entry points', () => {
  it('keeps the root runtime surface narrow and has no default export', () => {
    expect(Object.keys(plugin).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('feishu-channel')
    expect(plugin.inject).toEqual(['agents'])
  })

  it('keeps the invariant companion package-owned and named', () => {
    expect(Object.keys(invariant).sort()).toEqual(['apply', 'inject', 'invariantName', 'name'])
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('feishu-channel-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })

  it('publishes only the root, invariant, and package metadata entry points', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './invariant', './package.json'])
  })
})
