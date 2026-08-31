import { Context } from '@deepseek-ai/cordis'
import type { NormalizedMessage } from '@larksuite/channel'
import { describe, expect, it, vi } from 'vitest'
import { resolveAuthorization } from '../src/authorization.ts'
import { installChannel, type ChannelPort } from '../src/channel.ts'
import { resolveConfig } from '../src/config.ts'
import type { HostAgent, HostAgentHandle, HostAgentRegistry, HostWorkspace } from '../src/host.ts'

describe('Feishu session commands', () => {
  it('creates one blank session and applies interactive model settings', async () => {
    const ctx = new Context()
    const handlers = new Map<string, (value: unknown) => unknown>()
    const sends: unknown[] = []
    const panelCommands: string[] = []
    const updateCard = vi.fn(async (_messageId: string, _card: object) => {})
    const executeCommand = vi.fn(async () => ({
      result: { kind: 'success' as const, text: '运行状态正常' },
    }))
    let current = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    }
    const selectModel = vi.fn(async (request: {
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
    }) => {
      const { sessionId: _sessionId, ...selected } = request
      current = { ...selected, reasoningEffort: selected.reasoningEffort ?? 'high' }
      return { selected }
    })
    const live = new Map<string, HostAgentHandle>()
    const created: HostAgentHandle[] = []
    const sessionIds: string[] = []

    const workspace = {
      id: 'workspace',
      path: process.cwd(),
      get sessionIds() { return sessionIds },
      attachSession: vi.fn(async (sessionId: string) => {
        sessionIds.splice(0, sessionIds.length, sessionId, ...sessionIds.filter(id => id !== sessionId))
      }),
      detachSession: vi.fn(async (sessionId: string) => {
        const index = sessionIds.indexOf(sessionId)
        if (index >= 0) sessionIds.splice(index, 1)
      }),
    } satisfies HostWorkspace
    const agents: HostAgentRegistry = {
      get: sessionId => live.get(sessionId)?.agent,
      resume: async () => { throw new Error('not persisted') },
      create: async (options) => {
        await options.setup?.(ctx)
        const agent = {
          id: options.sessionId,
          session: { id: options.sessionId, requestContext: () => undefined },
          followup: vi.fn(),
          cancel: vi.fn(),
        } satisfies HostAgent
        const handle = {
          agent,
          dispose: vi.fn(async () => { live.delete(options.sessionId) }),
        } satisfies HostAgentHandle
        live.set(options.sessionId, handle)
        created.push(handle)
        return handle
      },
    }
    ctx.provide('agents', agents)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) })
    ctx.provide('workspaceRegistry', {
      resolveByPath: async () => workspace,
      create: async () => workspace,
    })
    ctx.provide('commands', {
      list: () => [{ name: 'status', description: '查看运行状态' }],
      execute: executeCommand,
    })
    ctx.provide('sessionController', {
      modelCatalog: async () => ({
        default: { ...current },
        routableProviders: ['deepseek-official'],
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            reasoning: {
              efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最高' }],
              defaultEffort: 'high',
            },
          }, {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            reasoning: { efforts: [{ id: 'max', name: '最高' }], defaultEffort: 'max' },
          }],
        }],
        failures: [],
      }),
      selectModel,
      async *follow() {
        yield {
          type: 'snapshot',
          projections: {
            asOfSeq: 0,
            values: { modelSelection: { lastUsed: null, next: { ...current } } },
          },
        }
      },
    })

    const port = {
      connect: async () => {},
      disconnect: async () => {},
      on: (name: string, handler: (value: unknown) => unknown) => {
        handlers.set(name, handler)
        return () => { handlers.delete(name) }
      },
      send: vi.fn(async (_chatId: string, input: unknown) => {
        sends.push(input)
        return { messageId: 'reply-' + sends.length }
      }),
      updateCard,
      listSlashCommands: async () => ({ commands: [] }),
      createSlashCommand: vi.fn(async (command: string) => { panelCommands.push(command) }),
      deleteSlashCommand: async () => {},
      downloadResourceToFile: async () => ({ bytesWritten: 0 }),
    } as unknown as ChannelPort
    const config = resolveConfig({ cwd: process.cwd() })
    installChannel(ctx, config, port, () => {}, resolveAuthorization(config))

    const message = {
      messageId: 'om_new',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderId: 'ou_1',
      content: '/new',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: Date.now(),
    } as NormalizedMessage
    handlers.get('message')?.(message)

    await vi.waitFor(() => { expect(sends).toHaveLength(1) })
    expect(created).toHaveLength(0)
    expect(JSON.stringify(sends[0])).toContain("<text_tag color='orange'>待确认</text_tag>")
    const newResponse = await handlers.get('cardAction')?.({
      messageId: 'reply-1',
      chatId: 'oc_1',
      operator: { openId: 'ou_1', name: 'Jiahao' },
      action: { tag: 'button', value: buttonValueFrom(sends[0]) },
    })
    expect(newResponse).toEqual({ toast: { type: 'info', content: '正在执行 /new' } })
    await vi.waitFor(() => { expect(created).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(updateCard).toHaveBeenCalledWith('reply-1', expect.objectContaining({ config: expect.any(Object) }))
    })
    await vi.waitFor(() => {
      expect(panelCommands).toEqual(expect.arrayContaining(['new', 'reset', 'stop', 'model', 'effort', 'help']))
    })
    expect(created[0]!.agent.cancel).not.toHaveBeenCalled()
    expect(created[0]!.dispose).not.toHaveBeenCalled()
    expect(workspace.detachSession).not.toHaveBeenCalled()
    expect(sessionIds).toEqual([created[0]!.agent.session.id])

    handlers.get('message')?.({ ...message, messageId: 'om_help', content: '/help' })
    await vi.waitFor(() => { expect(sends).toHaveLength(2) })
    expect(JSON.stringify(sends[1])).toContain('**命令中心**')
    expect(JSON.stringify(sends[1])).toContain('/model · 查看或更换当前会话模型')

    handlers.get('message')?.({ ...message, messageId: 'om_model', content: '/model' })
    await vi.waitFor(() => { expect(sends).toHaveLength(3) })
    const modelSelector = selectorFrom(sends[2])
    expect(JSON.stringify(sends[2])).toContain('**当前模型**')
    expect(JSON.stringify(sends[2])).toContain('deepseek-official/deepseek-v4-flash')
    const modelResponse = await handlers.get('cardAction')?.({
      messageId: 'reply-3',
      chatId: 'oc_1',
      operator: { openId: 'ou_1', name: 'Jiahao' },
      action: {
        tag: 'select_static',
        value: modelSelector.value,
        option: modelSelector.options[1]!.value,
      },
    })
    expect(modelResponse).toEqual({ toast: { type: 'info', content: '正在切换模型' } })
    await vi.waitFor(() => {
      expect(selectModel).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: created[0]!.agent.session.id,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      }))
    })
    await vi.waitFor(() => { expect(updateCard).toHaveBeenCalledWith('reply-3', expect.any(Object)) })

    handlers.get('message')?.({ ...message, messageId: 'om_effort', content: '/effort' })
    await vi.waitFor(() => { expect(sends).toHaveLength(4) })
    const effortSelector = selectorFrom(sends[3])
    expect(JSON.stringify(sends[3])).toContain('**当前强度**')
    expect(JSON.stringify(sends[3])).toContain('"content":"max"')
    current = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    }
    const effortResponse = await handlers.get('cardAction')?.({
      messageId: 'reply-4',
      chatId: 'oc_1',
      operator: { openId: 'ou_1', name: 'Jiahao' },
      action: {
        tag: 'select_static',
        value: effortSelector.value,
        option: 'max',
      },
    })
    expect(effortResponse).toEqual({ toast: { type: 'info', content: '正在调整推理强度' } })
    await vi.waitFor(() => {
      const failed = updateCard.mock.calls.find(([messageId]) => messageId === 'reply-4')?.[1]
      expect(JSON.stringify(failed)).toContain('当前模型已变化')
    })
    expect(selectModel).toHaveBeenCalledTimes(1)

    handlers.get('message')?.({ ...message, messageId: 'om_effort_fresh', content: '/effort' })
    await vi.waitFor(() => { expect(sends).toHaveLength(5) })
    const freshEffortSelector = selectorFrom(sends[4])
    const freshEffortResponse = await handlers.get('cardAction')?.({
      messageId: 'reply-5',
      chatId: 'oc_1',
      operator: { openId: 'ou_1', name: 'Jiahao' },
      action: {
        tag: 'select_static',
        value: freshEffortSelector.value,
        option: 'max',
      },
    })
    expect(freshEffortResponse).toEqual({
      toast: { type: 'info', content: '正在调整推理强度' },
    })
    await vi.waitFor(() => {
      expect(selectModel).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: created[0]!.agent.session.id,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      }))
    })

    handlers.get('message')?.({ ...message, messageId: 'om_status', content: '/status' })
    await vi.waitFor(() => { expect(sends).toHaveLength(6) })
    expect(executeCommand).not.toHaveBeenCalled()
    const statusResponse = await handlers.get('cardAction')?.({
      messageId: 'reply-6',
      chatId: 'oc_1',
      operator: { openId: 'ou_1', name: 'Jiahao' },
      action: { tag: 'button', value: buttonValueFrom(sends[5]) },
    })
    expect(statusResponse).toEqual({ toast: { type: 'info', content: '正在执行 /status' } })
    await vi.waitFor(() => { expect(executeCommand).toHaveBeenCalledTimes(1) })
    expect(executeCommand).toHaveBeenCalledWith(
      created[0]!.agent,
      '/status',
      [],
      expect.any(AbortSignal),
    )
    await vi.waitFor(() => {
      const result = updateCard.mock.calls.find(([messageId]) => messageId === 'reply-6')?.[1]
      expect(JSON.stringify(result)).toContain('运行状态正常')
    })

    await ctx.fiber.dispose()
  })
})

function selectorFrom(input: unknown): {
  readonly value: unknown
  readonly options: readonly { readonly value: string }[]
} {
  const card = (input as {
    card: { elements: readonly { tag: string; actions?: readonly unknown[] }[] }
  }).card
  const action = card.elements.find(element => element.tag === 'action')?.actions?.[0]
  return action as { readonly value: unknown; readonly options: readonly { readonly value: string }[] }
}

function buttonValueFrom(input: unknown): unknown {
  const card = (input as {
    card: { elements: readonly { tag: string; actions?: readonly { value: unknown }[] }[] }
  }).card
  return card.elements.find(element => element.tag === 'action')?.actions?.[0]?.value
}
