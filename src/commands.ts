/** Parse and execute the slash commands exposed by the Feishu surface. */

import type {
  HostAgent,
  HostCommandDescriptor,
  HostCommands,
  HostModelController,
  HostModelDirectory,
} from './host.ts'
import { catalog, currentModel, route, type CatalogEntry } from './model-catalog.ts'

export const NEW_COMMAND = 'new'
export const RESET_COMMAND = 'reset'
export const STOP_COMMAND = 'stop'
export const HELP_COMMAND = 'help'
export const MODEL_COMMAND = 'model'
export const EFFORT_COMMAND = 'effort'

/** Commands owned by this channel, shared by help and slash-panel sync. */
export const CHANNEL_COMMANDS = [
  channelCommand(NEW_COMMAND, '新建会话'),
  channelCommand(RESET_COMMAND, '重置会话'),
  channelCommand(STOP_COMMAND, '停止当前任务'),
  channelCommand(MODEL_COMMAND, '查看或更换当前会话模型'),
  channelCommand(EFFORT_COMMAND, '调整当前会话推理强度'),
  channelCommand(HELP_COMMAND, '显示可用命令'),
] as const

const COMMAND_SYNTAX = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*?))?\s*$/

/** One syntactically valid command. Parsing has no runtime side effects. */
export interface ParsedCommand {
  readonly name: string
  readonly input: string
  readonly source: string
}

/** Parse one complete command line; surrounding non-command text is rejected. */
export function parseCommandLine(text: string): ParsedCommand | undefined {
  const source = text.trim()
  const match = COMMAND_SYNTAX.exec(source)
  if (match === null) return undefined
  return Object.freeze({
    name: match[1]!.toLowerCase(),
    input: (match[2] ?? '').trim(),
    source,
  })
}

export function isCommandLine(text: string): boolean {
  return parseCommandLine(text) !== undefined
}

export function isSessionCommand(text: string): boolean {
  const command = parseCommandLine(text)
  return command?.name === NEW_COMMAND || command?.name === RESET_COMMAND
}

/** User-visible result consumed by the command card. */
export interface CommandOutcome {
  readonly reply: string
  readonly status: 'success' | 'info' | 'failure'
}

/** Runtime services required after parsing. */
export interface CommandExecutionContext {
  readonly agent: HostAgent
  readonly commands?: HostCommands | undefined
  readonly models?: HostModelController | undefined
  readonly signal: AbortSignal
}

/** Deduplicated directory shared by help cards and slash-panel sync. */
export function commandCatalog(
  commands: HostCommands | undefined,
  agent: HostAgent,
): HostCommandDescriptor[] {
  const owned = new Set<string>(CHANNEL_COMMANDS.map(command => command.name))
  const hosted = (commands?.list(agent) ?? []).filter(command => !owned.has(command.name))
  return [...new Map(
    [...hosted, ...CHANNEL_COMMANDS].map(command => [command.name, command]),
  ).values()]
}

export function helpText(commands: HostCommands | undefined, agent: HostAgent): string {
  return [
    '**可用命令**',
    ...commandCatalog(commands, agent).map(command => '/' + command.name + ' — ' + command.description),
  ].join('\n')
}

/** Execute a command that has already passed syntax parsing. */
export async function executeCommand(
  command: ParsedCommand,
  context: CommandExecutionContext,
): Promise<CommandOutcome> {
  if (command.name === STOP_COMMAND) {
    context.agent.cancel('user')
    return success('⏹ 已停止当前任务。')
  }
  if (command.name === HELP_COMMAND) {
    return info(helpText(context.commands, context.agent))
  }
  if (command.name === MODEL_COMMAND || command.name === EFFORT_COMMAND) {
    if (context.models === undefined) return failure('⚠️ 当前部署没有会话模型控制服务。')
    return command.name === MODEL_COMMAND
      ? executeModelCommand(command.input, context.agent, context.models)
      : executeEffortCommand(command.input, context.agent, context.models)
  }
  return executeHostCommand(command, context)
}

async function executeHostCommand(
  command: ParsedCommand,
  context: CommandExecutionContext,
): Promise<CommandOutcome> {
  if (context.commands === undefined) {
    return failure('⚠️ 本部署没有组合命令运行时，/' + command.name + ' 无法执行。')
  }
  let execution
  try {
    execution = await context.commands.execute(context.agent, command.source, [], context.signal)
  } catch (error) {
    return commandFailure(command.name, error)
  }
  if (execution === undefined) {
    return failure('⚠️ 未知命令 /' + command.name + '。\n\n' + helpText(context.commands, context.agent))
  }
  if (execution.result.kind === 'error') {
    return commandFailure(command.name, execution.result.text)
  }
  return success(execution.result.text ?? '')
}

async function executeModelCommand(
  input: string,
  agent: HostAgent,
  models: HostModelController,
): Promise<CommandOutcome> {
  try {
    const directory = await models.inspect(agent.session.id)
    if (input === '') return info(modelChoices(directory))
    const matches = matchingModels(directory, input)
    if (matches.length === 0) {
      return failure('⚠️ 找不到模型“' + input + '”。\n\n' + modelChoices(directory))
    }
    if (matches.length > 1) {
      return failure('⚠️ 模型 ID“' + input + '”属于多个提供方，请使用完整名称：\n'
        + matches.map(entry => '- /' + MODEL_COMMAND + ' '
          + route({ provider: entry.provider, model: entry.model.id })).join('\n'))
    }
    const match = matches[0]!
    const selected = await models.select(agent.session.id, {
      provider: match.provider,
      model: match.model.id,
      ...(match.model.reasoning?.defaultEffort === undefined
        ? {}
        : { reasoningEffort: match.model.reasoning.defaultEffort }),
    })
    return success('✅ 已切换模型：' + route(selected)
      + (selected.reasoningEffort === undefined ? '' : '（推理强度：' + selected.reasoningEffort + '）'))
  } catch (error) {
    return commandFailure(MODEL_COMMAND, error)
  }
}

async function executeEffortCommand(
  input: string,
  agent: HostAgent,
  models: HostModelController,
): Promise<CommandOutcome> {
  try {
    const directory = await models.inspect(agent.session.id)
    const reasoning = currentModel(directory)?.reasoning
    const choices = effortChoices(directory)
    if (input === '') return info(choices)
    if (reasoning === undefined) return failure('⚠️ 当前模型没有公布可调的推理强度。')

    const effort = input === 'default'
      ? reasoning.defaultEffort
      : reasoning.efforts.find(candidate => candidate.id === input)?.id
    if (input !== 'default' && effort === undefined) {
      return failure('⚠️ 不支持推理强度“' + input + '”。\n\n' + choices)
    }
    const selected = await models.select(agent.session.id, {
      provider: directory.current.provider,
      model: directory.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })
    return success('✅ 推理强度已调整为：' + (selected.reasoningEffort ?? '默认'))
  } catch (error) {
    return commandFailure(EFFORT_COMMAND, error)
  }
}

function modelChoices(directory: HostModelDirectory): string {
  const choices = catalog(directory).map(entry => '- /' + MODEL_COMMAND + ' '
    + route({ provider: entry.provider, model: entry.model.id }) + ' — ' + entry.model.name)
  return choiceDocument(directory, '可选模型', choices)
}

function effortChoices(directory: HostModelDirectory): string {
  const efforts = currentModel(directory)?.reasoning?.efforts ?? []
  const choices = [
    '- /' + EFFORT_COMMAND + ' default — 使用模型默认值',
    ...efforts.map(effort => '- /' + EFFORT_COMMAND + ' ' + effort.id + ' — ' + effort.name),
  ]
  return choiceDocument(directory, '可选强度', choices)
}

function choiceDocument(directory: HostModelDirectory, title: string, choices: readonly string[]): string {
  return [
    '当前模型：' + route(directory.current),
    '当前推理强度：' + (directory.current.reasoningEffort ?? '默认'),
    '',
    '**' + title + '**',
    ...choices,
  ].join('\n')
}

function channelCommand<const Name extends string>(name: Name, description: string) {
  return { name, description }
}

function matchingModels(directory: HostModelDirectory, input: string): CatalogEntry[] {
  const entries = catalog(directory)
  const byRoute = entries.filter(entry =>
    route({ provider: entry.provider, model: entry.model.id }) === input)
  return byRoute.length > 0 ? byRoute : entries.filter(entry => entry.model.id === input)
}

function commandFailure(name: string, error: unknown): CommandOutcome {
  const detail = error instanceof Error ? error.message : String(error)
  return failure('⚠️ 命令执行失败（/' + name + '）：' + detail)
}

function success(reply: string): CommandOutcome {
  return { reply, status: 'success' }
}

function info(reply: string): CommandOutcome {
  return { reply, status: 'info' }
}

function failure(reply: string): CommandOutcome {
  return { reply, status: 'failure' }
}
