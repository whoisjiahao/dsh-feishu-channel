import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvalCard, settledCard } from '../src/approval-gate.ts'
import { commandHelpCard, commandPromptCard, commandResultCard } from '../src/command-card.ts'
import type { HostModelDirectory, HostPermissionSelect, HostSessionEvent } from '../src/host.ts'
import {
  modelSettingCard,
  modelSettingChoices,
  settledModelSettingCard,
} from '../src/model-card.ts'
import { permissionSettingCard, permissionSettingChoices } from '../src/permission-card.ts'
import { TurnView } from '../src/presentation/turn-view.ts'
import { renderCard, type CardRenderOptions } from '../src/presentation/feishu-card.ts'
import { UI_CONTRACT } from './fixtures/ui-contract.ts'

type Json = Record<string, any>

const options: CardRenderOptions = {
  showProcess: true,
  maxTimelineItems: 12,
  tableOverflowMode: 'compact',
  footerFields: ['duration', 'model', 'input_tokens', 'output_tokens', 'context'],
}

const directory: HostModelDirectory = {
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
      reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' },
    }, {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      reasoning: { efforts: [{ id: 'max', name: '最高' }], defaultEffort: 'max' },
    }],
  }],
}

function event(type: string, data: object): HostSessionEvent {
  return { type, data }
}

function findElement(value: unknown, elementId: string): Json | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElement(item, elementId)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Json
  if (record.element_id === elementId) return record
  for (const nested of Object.values(record)) {
    const found = findElement(nested, elementId)
    if (found !== undefined) return found
  }
  return undefined
}

function replyShell(card: Json) {
  return {
    schema: card.schema,
    wide: card.config.wide_screen_mode,
    updateMulti: card.config.update_multi,
    padding: card.body.padding,
    spacing: card.body.vertical_spacing,
    status: findElement(card, 'card_head')?.header?.title?.content,
  }
}

function fields(card: Json): { label: string; value: string }[] {
  return card.elements
    .filter((element: Json) => Array.isArray(element.fields))
    .map((element: Json) => ({
      label: element.fields[0].text.content,
      value: element.fields[1].text.content,
    }))
}

function actionRows(card: Json): Json[] {
  return card.elements.filter((element: Json) => element.tag === 'action')
}

function notes(card: Json): string[] {
  return card.elements
    .filter((element: Json) => element.tag === 'note')
    .flatMap((element: Json) => element.elements.map((item: Json) => item.content))
}

function interactiveStatus(card: Json): string {
  return card.elements[0].text.content
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error('missing UI contract element: ' + label)
  return value
}

describe('frozen UI/UX contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 2, 20, 13, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('freezes loading, completed, and failed reply cards', () => {
    const loading = renderCard(new TurnView(1), options).card as Json
    expect({
      ...replyShell(loading),
      main: findElement(loading, 'main_content')?.content,
      skeleton: findElement(loading, 'loading_skeleton') !== undefined,
    }).toEqual(UI_CONTRACT.reply.loading)

    const completedState = new TurnView(1)
    completedState.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '## 结论\n\n答案' }] },
    }))
    completedState.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const completed = renderCard(completedState, options).card as Json
    expect({
      ...replyShell(completed),
      answerTitle: findElement(completed, 'answer_title')?.content,
      main: findElement(completed, 'main_content')?.content,
      analysisTitle: findElement(completed, 'analysis_timeline')?.header?.title?.content,
      analysisExpanded: findElement(completed, 'analysis_timeline')?.expanded,
    }).toEqual(UI_CONTRACT.reply.completed)

    const failedState = new TurnView(1)
    failedState.observe(event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'READ_TIMEOUT', message: 'boom' } },
    }))
    const failed = renderCard(failedState, options).card as Json
    const failedActions = required(findElement(failed, 'failure_actions'), 'failure_actions')
    expect({
      ...replyShell(failed),
      title: findElement(failed, 'failure_title')?.content,
      errorTone: findElement(failed, 'failure_error_box')?.background_style,
      actions: failedActions.columns.map((column: Json) => {
        const button = column.elements[0]
        return {
          label: button.text.content,
          type: button.type,
          kind: button.behaviors[0].value.kind,
        }
      }),
    }).toEqual(UI_CONTRACT.reply.failed)
  })

  it('freezes pending and settled approval cards', () => {
    const pending = approvalCard('bash', '需要执行测试', 'pnpm test', 'approval-1') as Json
    const plainSections = pending.elements
      .map((element: Json, index: number) => ({ element, next: pending.elements[index + 1] }))
      .filter(({ element, next }: { element: Json; next: Json }) =>
        element.text?.tag === 'lark_md' && next?.text?.tag === 'plain_text')
      .map(({ element, next }: { element: Json; next: Json }) => ({
        label: element.text.content,
        value: next.text.content,
      }))
    expect({
      wide: pending.config.wide_screen_mode,
      status: interactiveStatus(pending),
      fields: fields(pending),
      sections: plainSections,
      note: notes(pending)[0],
      actions: required(actionRows(pending)[0], 'approval actions').actions.map((action: Json) => ({
        label: action.text.content,
        type: action.type,
        decision: action.value.decision,
      })),
    }).toEqual(UI_CONTRACT.approval.pending)

    const settled = settledCard('bash', 'allowed-once', 'Jiahao') as Json
    expect({
      wide: settled.config.wide_screen_mode,
      status: interactiveStatus(settled),
      fields: fields(settled),
      note: notes(settled)[0],
      actions: actionRows(settled),
    }).toEqual(UI_CONTRACT.approval.settled)
  })

  it('freezes command result, discovery, confirmation, and input cards', () => {
    const success = commandResultCard('stop', {
      reply: '⏹ 已停止当前任务。',
      status: 'success',
    }) as Json
    expect({
      wide: success.config.wide_screen_mode,
      status: interactiveStatus(success),
      fields: fields(success),
      text: success.elements[3].text.content,
    }).toEqual(UI_CONTRACT.command.success)

    const help = commandHelpCard([
      { name: 'new', description: '新建会话' },
      { name: 'model', description: '查看或更换当前会话模型' },
    ], 'menu-1') as Json
    const select = required(required(actionRows(help)[0], 'command menu actions').actions[0], 'command menu')
    expect({
      wide: help.config.wide_screen_mode,
      status: interactiveStatus(help),
      placeholder: select.placeholder.content,
      options: select.options.map((option: Json) => option.text.content),
      note: notes(help)[0],
    }).toEqual(UI_CONTRACT.command.help)

    const confirm = commandPromptCard({
      name: 'compact',
      description: '压缩较早的会话历史',
    }, 'confirm-1') as Json
    expect({
      wide: confirm.config.wide_screen_mode,
      status: interactiveStatus(confirm),
      fields: fields(confirm),
      actions: required(actionRows(confirm)[0], 'command confirmation actions').actions
        .map((action: Json) => ({
          label: action.text.content,
          type: action.type,
          action: action.value.action,
        })),
    }).toEqual(UI_CONTRACT.command.confirm)

    const input = commandPromptCard({
      name: 'feedback',
      description: '记录反馈',
      input: { hint: '<text>' },
    }, 'input-1') as Json
    const form = required(input.elements.find((element: Json) => element.tag === 'form'), 'command input form')
    expect({
      wide: input.config.wide_screen_mode,
      status: interactiveStatus(input),
      fields: fields(input),
      placeholder: form.elements[0].placeholder.content,
      submit: form.elements[1].text.content,
    }).toEqual(UI_CONTRACT.command.input)
  })

  it('freezes the permission picker', () => {
    const permissions: HostPermissionSelect = {
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
    }
    const picker = permissionSettingCard(
      permissions,
      'permission-1',
      permissionSettingChoices(permissions),
    ) as Json
    const select = required(required(actionRows(picker)[0], 'permission picker actions').actions[0], 'permission picker')
    expect({
      wide: picker.config.wide_screen_mode,
      status: interactiveStatus(picker),
      fields: fields(picker),
      placeholder: select.placeholder.content,
      options: select.options.map((option: Json) => option.text.content),
      note: notes(picker)[0],
    }).toEqual(UI_CONTRACT.permission.picker)
  })

  it('freezes model picker and settled cards', () => {
    const choices = modelSettingChoices(directory, 'model')
    const picker = modelSettingCard(directory, 'model', 'picker-1', choices) as Json
    const select = required(required(actionRows(picker)[0], 'model picker actions').actions[0], 'model picker')
    expect({
      wide: picker.config.wide_screen_mode,
      status: interactiveStatus(picker),
      fields: fields(picker),
      placeholder: select.placeholder.content,
      options: select.options.map((option: Json) => option.text.content),
      note: notes(picker)[0],
    }).toEqual(UI_CONTRACT.model.picker)

    const settled = settledModelSettingCard('effort', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }) as Json
    expect({
      wide: settled.config.wide_screen_mode,
      status: interactiveStatus(settled),
      fields: fields(settled),
      actions: actionRows(settled),
    }).toEqual(UI_CONTRACT.model.settled)
  })
})
