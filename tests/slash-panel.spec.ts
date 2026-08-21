import { describe, expect, it, vi } from 'vitest'
import { syncSlashPanel } from '../src/slash-panel.ts'

describe('syncSlashPanel', () => {
  it('can add channel commands at startup without removing unresolved host commands', async () => {
    const create = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const result = await syncSlashPanel({
      listSlashCommands: async () => ({
        commands: [{ command: 'host-command', commandId: 'cmd_1' }],
      }),
      createSlashCommand: create,
      deleteSlashCommand: remove,
    }, [{ name: 'new', description: '新建会话' }], () => {}, { removeUnknown: false })

    expect(result.added).toEqual(['new'])
    expect(create).toHaveBeenCalledWith('new', '新建会话')
    expect(remove).not.toHaveBeenCalled()
    expect(result.removed).toEqual([])
  })

  it('registers duplicate desired names only once and keeps the channel description', async () => {
    const create = vi.fn(async () => {})
    await syncSlashPanel({
      listSlashCommands: async () => ({ commands: [] }),
      createSlashCommand: create,
      deleteSlashCommand: async () => {},
    }, [
      { name: 'model', description: '显示当前模型' },
      { name: 'model', description: '查看或更换当前会话模型' },
    ], () => {})

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('model', '查看或更换当前会话模型')
  })

  it('reads every page before computing the difference', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      command: 'command-' + index,
      commandId: 'id-' + index,
    }))
    const list = vi.fn(async (pageToken?: string) => pageToken === undefined
      ? { commands: firstPage, nextPageToken: 'page-2' }
      : { commands: [{ command: 'command-50', commandId: 'id-50' }] })
    const create = vi.fn(async () => {})

    const result = await syncSlashPanel({
      listSlashCommands: list,
      createSlashCommand: create,
      deleteSlashCommand: async () => {},
    }, [
      ...firstPage.map(entry => ({ name: entry.command, description: entry.command })),
      { name: 'command-50', description: 'command-50' },
      { name: 'command-51', description: 'command-51' },
    ], () => {}, { removeUnknown: false })

    expect(list).toHaveBeenNthCalledWith(1, undefined)
    expect(list).toHaveBeenNthCalledWith(2, 'page-2')
    expect(result.added).toEqual(['command-51'])
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('stops pagination and mutations after lifecycle cancellation', async () => {
    const controller = new AbortController()
    const create = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const list = vi.fn(async () => {
      controller.abort()
      return {
        commands: [{ command: 'old', commandId: 'id-old' }],
        nextPageToken: 'page-2',
      }
    })

    const result = await syncSlashPanel({
      listSlashCommands: list,
      createSlashCommand: create,
      deleteSlashCommand: remove,
    }, [{ name: 'new', description: 'new' }], () => {}, { signal: controller.signal })

    expect(list).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(result).toEqual({ added: [], removed: [] })
  })
})
