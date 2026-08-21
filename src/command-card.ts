/** Unified cards for slash-command discovery, success, information, and failure. */

import type { HostCommandDescriptor } from './host.ts'
import type { CommandOutcome } from './commands.ts'
import {
  interactiveCard,
  interactiveDivider,
  interactiveFieldRow,
  interactiveStatusLine,
} from './card-design.ts'
import type { CardTone } from './card-tokens.ts'
import { normalizeMarkdownForCard } from './presentation/markdown.ts'

/** Keep a command result inside one interactive card's practical text budget. */
const COMMAND_RESULT_MAX_CHARS = 6000

/** Marker distinguishing command-card callbacks from other card actions. */
export const COMMAND_INTERACTION_ACTION = 'dsh-feishu-channel/command-interaction'

/** Form field carrying one command's free-form argument text. */
export const COMMAND_INPUT_NAME = 'command_input'

const COMMAND_FORM_ACTION_PREFIX = 'dsh_command_submit_'

type CommandInteractionKind = 'open' | 'run' | 'cancel'

/** Compact callback payload; allowed commands remain in server-side pending state. */
export interface CommandInteractionActionValue {
  readonly kind: typeof COMMAND_INTERACTION_ACTION
  readonly id: string
  readonly action: CommandInteractionKind
}

/** Narrow an arbitrary card value to this plugin's command interaction. */
export function commandInteractionActionValue(value: unknown): CommandInteractionActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== COMMAND_INTERACTION_ACTION || typeof record.id !== 'string') return undefined
  if (record.action !== 'open' && record.action !== 'run' && record.action !== 'cancel') return undefined
  return { kind: COMMAND_INTERACTION_ACTION, id: record.id, action: record.action }
}

/** Encode one unguessable pending id into a CardKit form-submit button name. */
export function commandFormActionName(id: string): string {
  return COMMAND_FORM_ACTION_PREFIX + id
}

/** Recover a pending id only from this plugin's form-submit namespace. */
export function commandFormActionId(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.startsWith(COMMAND_FORM_ACTION_PREFIX)) return undefined
  const id = name.slice(COMMAND_FORM_ACTION_PREFIX.length)
  return id === '' ? undefined : id
}

function normalizedResult(text: string): string {
  const withoutStatusEmoji = text.replace(/^(?:✅|⚠️|⏹)\s*/, '')
  const normalized = normalizeMarkdownForCard(withoutStatusEmoji).trim()
  if (normalized === '') return '命令已执行。'
  return normalized.length <= COMMAND_RESULT_MAX_CHARS
    ? normalized
    : normalized.slice(0, COMMAND_RESULT_MAX_CHARS - 12) + '\n\n内容已截断。'
}

function outcomeLook(outcome: CommandOutcome): { status: string; tone: CardTone } {
  switch (outcome.status) {
    case 'success': return { status: '已完成', tone: 'success' }
    case 'failure': return { status: '失败', tone: 'failure' }
    default: return { status: '提示', tone: 'info' }
  }
}

/** Render one command's result without falling back to a naked chat message. */
export function commandResultCard(command: string, outcome: CommandOutcome): object {
  const look = outcomeLook(outcome)
  return interactiveCard([
    interactiveStatusLine('命令执行', look.status, look.tone),
    interactiveDivider(),
    interactiveFieldRow('命令', '/' + command),
    { tag: 'div', text: { tag: 'lark_md', content: normalizedResult(outcome.reply) } },
  ])
}

/** Render every available command as one native selector. */
export function commandHelpCard(commands: readonly HostCommandDescriptor[], id: string): object {
  return interactiveCard([
    interactiveStatusLine('命令中心', '可用', 'info'),
    interactiveDivider(),
    {
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择命令' },
        options: commands.map(command => ({
          text: {
            tag: 'plain_text',
            content: ('/' + command.name + ' · ' + command.description).slice(0, 120),
          },
          value: command.name,
        })),
        value: { kind: COMMAND_INTERACTION_ACTION, id, action: 'open' },
      }],
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '选择后将在当前卡片中打开对应操作。' }],
    },
  ])
}

/** Render one host descriptor as a confirmation card or free-text form. */
export function commandPromptCard(command: HostCommandDescriptor, id: string): object {
  const interaction = command.input === undefined
    ? {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: commandActionLabel(command.name) },
            type: 'primary',
            value: { kind: COMMAND_INTERACTION_ACTION, id, action: 'run' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消' },
            type: 'default',
            value: { kind: COMMAND_INTERACTION_ACTION, id, action: 'cancel' },
          },
        ],
      }
    : {
        tag: 'form',
        name: 'dsh_command_form',
        elements: [
          {
            tag: 'input',
            element_id: COMMAND_INPUT_NAME,
            name: COMMAND_INPUT_NAME,
            input_type: 'text',
            placeholder: { tag: 'plain_text', content: command.input.hint.slice(0, 120) },
            width: 'fill',
            required: false,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '执行' },
            type: 'primary',
            width: 'default',
            form_action_type: 'submit',
            name: commandFormActionName(id),
          },
        ],
      }

  return interactiveCard([
    interactiveStatusLine('命令确认', command.input === undefined ? '待确认' : '待输入', 'warning'),
    interactiveDivider(),
    interactiveFieldRow('命令', '/' + command.name),
    interactiveFieldRow('作用', command.description),
    interaction,
  ])
}

/** Replace a dismissed prompt with a terminal, inert card. */
export function cancelledCommandCard(command: string): object {
  return interactiveCard([
    interactiveStatusLine('命令确认', '已取消', 'neutral'),
    interactiveDivider(),
    interactiveFieldRow('命令', '/' + command),
  ])
}

function commandActionLabel(name: string): string {
  switch (name) {
    case 'new': return '新建会话'
    case 'reset': return '重置会话'
    case 'stop': return '停止任务'
    default: return '执行命令'
  }
}
