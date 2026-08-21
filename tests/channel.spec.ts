import { describe, expect, it } from 'vitest'
import { approvalCard, settledCard } from '../src/approval-gate.ts'
import { REPLY_CARD_PROMPT } from '../src/channel.ts'

describe('REPLY_CARD_PROMPT', () => {
  it('requires ordered collections to keep one visible number per line', () => {
    expect(REPLY_CARD_PROMPT).toContain('each item its own physical Markdown line')
    expect(REPLY_CARD_PROMPT).toContain('strictly increasing `N.` marker')
    expect(REPLY_CARD_PROMPT).toContain('Do not join items with')
    expect(REPLY_CARD_PROMPT).toContain('do not place an ordered list in a fenced block')
    expect(REPLY_CARD_PROMPT).toContain('is every ordered item visibly numbered on its own line')
  })
})

describe('approval cards', () => {
  it('uses the shared neutral card shell for pending and settled states', () => {
    const pending = approvalCard('bash', '需要执行', 'pnpm test', 'approval-1') as any
    const settled = settledCard('bash', 'allowed-once', 'Jiahao') as any

    expect(pending).not.toHaveProperty('header')
    expect(pending.elements[0].text.content).toContain(
      "<text_tag color='orange'>待确认</text_tag>",
    )
    expect(pending.elements[2].fields[1].text).toEqual({ tag: 'plain_text', content: 'bash' })
    expect(settled).not.toHaveProperty('header')
    expect(settled.elements[0].text.content).toContain(
      "<text_tag color='green'>已允许</text_tag>",
    )
  })
})
