import { describe, expect, it } from 'vitest'
import {
  inspectCardBudget,
  SAFE_CARD_JSON_BYTES,
} from '../src/presentation/card-budget.ts'

describe('inspectCardBudget', () => {
  it('counts serialized UTF-8 bytes, tagged elements, and Markdown tables', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '中文\n\n| A |\n|---|\n| 1 |' },
          { tag: 'table', rows: [] },
        ],
      },
    }
    const budget = inspectCardBudget(card)
    expect(budget.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(card), 'utf8'))
    expect(budget.elementCount).toBe(2)
    expect(budget.tableCount).toBe(2)
    expect(budget.safe).toBe(true)
    expect(budget.violations).toEqual([])
  })

  it('reports element, table, and byte limits independently', () => {
    const elements = Array.from({ length: 201 }, (_, index) => ({
      tag: 'markdown',
      content: index < 6 ? '| A |\n|---|\n| ' + index + ' |' : 'x',
    }))
    const budget = inspectCardBudget({
      body: { elements, padding: 'x'.repeat(SAFE_CARD_JSON_BYTES) },
    })
    expect(budget.violations).toEqual(['json_bytes', 'elements', 'tables'])
    expect(budget.safe).toBe(false)
    expect(budget.primaryReason).toBe('json_bytes')
  })

  it('rejects circular structures without throwing', () => {
    const card: { tag: string; child?: unknown } = { tag: 'div' }
    card.child = card
    const budget = inspectCardBudget(card)
    expect(budget.safe).toBe(false)
    expect(budget.violations).toContain('unserializable')
    expect(budget.serializationError).toBe('circular_reference')
  })

  it('rejects values JSON would silently discard or coerce', () => {
    for (const value of [undefined, () => undefined, Symbol('x'), 1n, Number.NaN, new Map()]) {
      const budget = inspectCardBudget({ tag: 'div', value })
      expect(budget.safe).toBe(false)
      expect(budget.violations).toContain('unserializable')
    }
  })

  it('accepts the same plain object reused in sibling branches', () => {
    const shared = { tag: 'plain_text', content: 'same' }
    const budget = inspectCardBudget({ left: shared, right: shared })
    expect(budget.safe).toBe(true)
    expect(budget.elementCount).toBe(2)
  })
})
