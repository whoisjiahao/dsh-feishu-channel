import { describe, expect, it } from 'vitest'
import {
  cardKitStatusLine,
  interactiveCard,
  interactiveDivider,
  interactiveFieldRow,
  interactiveStatusLine,
  statusTag,
} from '../src/card-design.ts'

describe('shared Feishu card design system', () => {
  it('keeps semantic color inside one compact status tag', () => {
    const card = interactiveCard([
      interactiveStatusLine('命令执行', '已完成', 'success'),
      interactiveDivider(),
      interactiveFieldRow('命令', '/help'),
    ]) as any

    expect(card).not.toHaveProperty('header')
    expect(card.elements[0].text.content).toBe(
      "**命令执行**  <text_tag color='green'>已完成</text_tag>",
    )
    expect(card.elements[1]).toEqual({ tag: 'hr' })
    expect(card.elements[2].fields[1].text).toEqual({ tag: 'plain_text', content: '/help' })
  })

  it('uses the same status vocabulary in CardKit 2.0', () => {
    expect(statusTag('失败', 'failure')).toBe("<text_tag color='red'>失败</text_tag>")
    expect(cardKitStatusLine('status', '内容交付', '生成中', 'warning')).toMatchObject({
      tag: 'markdown',
      element_id: 'status',
      content: "**内容交付**  <text_tag color='orange'>生成中</text_tag>",
      text_size: 'normal',
    })
  })
})
