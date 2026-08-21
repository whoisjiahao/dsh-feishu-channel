import { describe, expect, it, vi } from 'vitest'
import {
  commandCatalog,
  executeCommand,
  HELP_COMMAND,
  helpText,
  isCommandLine,
  isSessionCommand,
  MODEL_COMMAND,
  NEW_COMMAND,
  parseCommandLine,
  EFFORT_COMMAND,
  RESET_COMMAND,
  STOP_COMMAND,
} from '../src/commands.ts'
import type { HostAgent, HostCommands, HostModelController } from '../src/host.ts'

const agent = { id: 'a', session: { id: 's' }, followup: () => {}, cancel: vi.fn() } as unknown as HostAgent

describe('parseCommandLine and command classification', () => {
  it('parses leading slashes only', () => {
    expect(parseCommandLine('/stop')).toEqual({ name: 'stop', input: '', source: '/stop' })
    expect(parseCommandLine('  /Help now ')).toEqual({ name: 'help', input: 'now', source: '/Help now' })
    expect(parseCommandLine('not a command')).toBeUndefined()
    expect(parseCommandLine('/stop!')).toBeUndefined()
    expect(isCommandLine('/stop')).toBe(true)
    expect(isCommandLine('hello /stop')).toBe(false)
  })

  it('recognizes only the two session lifecycle commands', () => {
    expect(isSessionCommand('/new')).toBe(true)
    expect(isSessionCommand('  /RESET now')).toBe(true)
    expect(isSessionCommand('/stop')).toBe(false)
    expect(isSessionCommand('/newish')).toBe(false)
  })
})

describe('executeCommand', () => {
  it('cancels on stop', async () => {
    const outcome = await run('/stop')
    expect(agent.cancel).toHaveBeenCalled()
    expect(outcome.status).toBe('success')
    expect(outcome.reply).toContain('停止')
  })

  it('lists commands on help', async () => {
    const outcome = await run('/help')
    expect(outcome.status).toBe('info')
    expect(outcome.reply).toContain('/' + STOP_COMMAND)
    expect(outcome.reply).toContain('/' + HELP_COMMAND)
    expect(outcome.reply).toContain('/' + NEW_COMMAND)
    expect(outcome.reply).toContain('/' + RESET_COMMAND)
    expect(outcome.reply).toContain('/' + MODEL_COMMAND)
    expect(outcome.reply).toContain('/' + EFFORT_COMMAND)
  })

  it('lists session commands even without a host command runtime', () => {
    const text = helpText(undefined, agent)
    expect(text).toContain('/new — 新建会话')
    expect(text).toContain('/reset — 重置会话')
  })

  it('lets the channel model command replace the host query command in help', () => {
    const commands = {
      list: () => [{ name: 'model', description: '显示当前模型' }],
    } as unknown as HostCommands
    const text = helpText(commands, agent)

    expect(text.match(/\/model/g)).toHaveLength(1)
    expect(text).toContain('/model — 查看或更换当前会话模型')
  })

  it('deduplicates repeated host commands in the card directory', () => {
    const commands = {
      list: () => [
        { name: 'status', description: '状态一' },
        { name: 'status', description: '状态二' },
      ],
    } as unknown as HostCommands

    expect(commandCatalog(commands, agent).filter(command => command.name === 'status')).toEqual([
      { name: 'status', description: '状态二' },
    ])
  })

  it('reports unknown commands', async () => {
    const commands = {
      list: () => [],
      execute: vi.fn(async () => undefined),
    } as unknown as HostCommands
    const outcome = await run('/bogus', commands)
    expect(outcome.status).toBe('failure')
    expect(outcome.reply).toContain('未知命令')
  })

  it('reports host command failures', async () => {
    const commands = {
      list: () => [],
      execute: vi.fn(async () => ({ result: { kind: 'error', text: 'boom' } })),
    } as unknown as HostCommands
    const outcome = await run('/clear', commands)
    expect(outcome.status).toBe('failure')
    expect(outcome.reply).toContain('boom')
  })

  it('switches to an advertised model and applies its default reasoning effort', async () => {
    const models = modelController()
    const outcome = await run(
      '/model deepseek-official/deepseek-v4-pro',
      undefined,
      models,
    )

    expect(models.select).toHaveBeenCalledWith('s', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
    expect(outcome).toEqual({
      reply: '✅ 已切换模型：deepseek-official/deepseek-v4-pro（推理强度：high）',
      status: 'success',
    })
  })

  it('lists models when model has no argument', async () => {
    const outcome = await run(
      '/model',
      undefined,
      modelController(),
    )

    expect(outcome.reply).toContain('当前模型：deepseek-official/deepseek-v4-flash')
    expect(outcome.reply).toContain('/model deepseek-official/deepseek-v4-pro')
  })

  it('changes only the current model reasoning effort', async () => {
    const models = modelController()
    const outcome = await run(
      '/effort max',
      undefined,
      models,
    )

    expect(models.select).toHaveBeenCalledWith('s', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    expect(outcome).toEqual({
      reply: '✅ 推理强度已调整为：max',
      status: 'success',
    })
  })

  it('lists the current model efforts when reasoning has no argument', async () => {
    const outcome = await run(
      '/effort',
      undefined,
      modelController(),
    )

    expect(outcome.reply).toContain('当前推理强度：high')
    expect(outcome.reply).toContain('/effort max')
    expect(outcome.reply).toContain('/effort default')
  })
})

async function run(
  line: string,
  commands?: HostCommands,
  models?: HostModelController,
) {
  const command = parseCommandLine(line)
  if (command === undefined) throw new Error('invalid command test input')
  return executeCommand(command, {
    agent,
    commands,
    models,
    signal: new AbortController().signal,
  })
}

function modelController(): HostModelController {
  const directory = {
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    },
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: {
          efforts: [
            { id: 'off', name: '关闭' },
            { id: 'high', name: '高' },
            { id: 'max', name: '最高' },
          ],
          defaultEffort: 'high',
        },
      }, {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoning: {
          efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最高' }],
          defaultEffort: 'high',
        },
      }],
    }],
  }
  return {
    inspect: vi.fn(async () => directory),
    select: vi.fn(async (_sessionId, selection) => selection),
  }
}
