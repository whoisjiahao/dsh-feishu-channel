import { describe, expect, it } from 'vitest'
import {
  COMMAND_INPUT_NAME,
  COMMAND_INTERACTION_ACTION,
  commandFormActionId,
  commandHelpCard,
  commandInteractionActionValue,
  commandPromptCard,
  commandResultCard,
} from '../src/command-card.ts'

describe('command cards', () => {
  it('renders successful command output in the neutral design system', () => {
    const card = commandResultCard('stop', {
      reply: '⏹ 已停止当前任务。',
      status: 'success',
    }) as any

    expect(card).not.toHaveProperty('header')
    expect(card.elements[0].text.content).toContain("<text_tag color='green'>已完成</text_tag>")
    expect(card.elements[2].fields[1].text.content).toBe('/stop')
    expect(card.elements[3].text.content).toBe('已停止当前任务。')
  })

  it('renders every advertised command as an interactive command picker', () => {
    const card = commandHelpCard([
      { name: 'new', description: '新建会话' },
      { name: 'goal', description: '设置长期任务目标', input: { hint: '<objective>' } },
    ], 'menu-1') as any

    expect(card.elements[2].actions[0]).toMatchObject({
      tag: 'select_static',
      value: { kind: COMMAND_INTERACTION_ACTION, id: 'menu-1', action: 'open' },
    })
    expect(card.elements[2].actions[0].options).toEqual([
      { text: { tag: 'plain_text', content: '/new · 新建会话' }, value: 'new' },
      { text: { tag: 'plain_text', content: '/goal · 设置长期任务目标' }, value: 'goal' },
    ])
  })

  it('renders argument-free commands as explicit confirmation cards', () => {
    const card = commandPromptCard({ name: 'compact', description: '压缩较早的会话历史' }, 'run-1') as any

    expect(card.elements[0].text.content).toContain("<text_tag color='orange'>待确认</text_tag>")
    expect(card.elements[2].fields[1].text.content).toBe('/compact')
    expect(card.elements[4].actions.map((action: any) => action.value)).toEqual([
      { kind: COMMAND_INTERACTION_ACTION, id: 'run-1', action: 'run' },
      { kind: COMMAND_INTERACTION_ACTION, id: 'run-1', action: 'cancel' },
    ])
  })

  it('renders input commands as CardKit forms and recognizes only its own callbacks', () => {
    const card = commandPromptCard({
      name: 'feedback',
      description: '记录本次会话的反馈',
      input: { hint: '<text>' },
    }, 'form-1') as any
    const form = card.elements[4]

    expect(form).toMatchObject({ tag: 'form' })
    expect(form.elements[0]).toMatchObject({
      tag: 'input',
      name: COMMAND_INPUT_NAME,
      placeholder: { tag: 'plain_text', content: '<text>' },
    })
    expect(form.elements[1]).toMatchObject({
      tag: 'button',
      form_action_type: 'submit',
      name: expect.any(String),
    })
    expect(commandFormActionId(form.elements[1].name)).toBe('form-1')
    expect(commandFormActionId('foreign-form')).toBeUndefined()
    expect(commandInteractionActionValue({
      kind: COMMAND_INTERACTION_ACTION,
      id: 'run-1',
      action: 'run',
    })).toEqual({ kind: COMMAND_INTERACTION_ACTION, id: 'run-1', action: 'run' })
    expect(commandInteractionActionValue({ kind: COMMAND_INTERACTION_ACTION, id: 'run-1' })).toBeUndefined()
  })

  it('marks unknown or failed commands as failures', () => {
    const card = commandResultCard('bogus', {
      reply: '⚠️ 未知命令 /bogus。',
      status: 'failure',
    }) as any

    expect(card.elements[0].text.content).toContain("<text_tag color='red'>失败</text_tag>")
    expect(card.elements[3].text.content).toBe('未知命令 /bogus。')
  })

  it('still returns a settled card when a command has no text output', () => {
    const card = commandResultCard('quiet', {
      reply: '',
      status: 'success',
    }) as any

    expect(card.elements[3].text.content).toBe('命令已执行。')
  })
})
