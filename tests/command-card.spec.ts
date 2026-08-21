import { describe, expect, it } from 'vitest'
import { commandHelpCard, commandResultCard } from '../src/command-card.ts'

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

  it('renders every advertised command as a structured help row', () => {
    const card = commandHelpCard([
      { name: 'new', description: '新建会话' },
      { name: 'model', description: '查看或更换当前会话模型' },
    ]) as any

    expect(card.elements[2].text).toEqual({
      tag: 'plain_text',
      content: '/new  ·  新建会话\n/model  ·  查看或更换当前会话模型',
    })
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
