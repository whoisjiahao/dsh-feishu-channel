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

/** Render every available command in the same neutral help card. */
export function commandHelpCard(commands: readonly HostCommandDescriptor[]): object {
  return interactiveCard([
    interactiveStatusLine('命令中心', '可用', 'info'),
    interactiveDivider(),
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: commands.map(command => '/' + command.name + '  ·  ' + command.description).join('\n'),
      },
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '在输入框键入 / 可随时打开飞书命令面板。' }],
    },
  ])
}
