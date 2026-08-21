import { describe, expect, it } from 'vitest'
import {
  applyTableOverflow,
  countMarkdownTables,
  MarkdownStreamFilter,
  normalizeMarkdownForCard,
  parseTableRow,
  scanMarkdown,
  splitMarkdown,
  stripInlineCode,
} from '../src/presentation/markdown.ts'

describe('scanMarkdown', () => {
  it('emits explicit prose, list, fence, and table blocks without data loss', () => {
    const text = [
      'intro\n\n',
      '1. first\n2. second\n\n',
      '```ts\nconst value = 1\n```\n\n',
      '| Key | Value |\n|---|---|\n| a | b |\n\n',
      'tail',
    ].join('')
    const blocks = scanMarkdown(text)
    expect(blocks.filter(block => block.text.trim() !== '').map(block => block.kind)).toEqual([
      'prose', 'list', 'fence', 'table', 'prose',
    ])
    expect(blocks.map(block => block.text).join('')).toBe(text)
    expect(blocks.find(block => block.kind === 'table')?.table).toEqual({
      headers: ['Key', 'Value'],
      rows: [['a', 'b']],
    })
  })

  it('keeps an unterminated fence as one structural block', () => {
    expect(scanMarkdown('```\ncode\nstill code').map(block => block.kind)).toEqual(['fence'])
  })

  it('parses escaped and inline-code pipes as cell content', () => {
    expect(parseTableRow('| a\\|b | `c|d` |')).toEqual(['a\\|b', '`c|d`'])
    expect(parseTableRow('plain text')).toBeUndefined()
  })
})

describe('normalizeMarkdownForCard', () => {
  it('expands consecutive inline numbering and removes inline-code pills', () => {
    expect(normalizeMarkdownForCard('使用 `path`\n11. api、12. review、13. simplify\n')).toBe(
      '使用 path\n11. api\n12. review\n13. simplify\n',
    )
  })

  it('unwraps only a plain consecutive inventory fence', () => {
    const inventory = '```\n1 api 3 review\n2 test 4 simplify\n```'
    expect(normalizeMarkdownForCard(inventory)).toBe('1. api\n2. test\n3. review\n4. simplify')

    const code = '```ts\n1 const value = 1\n2 return value\n```'
    expect(normalizeMarkdownForCard(code)).toBe(code)
  })

  it('preserves inline-code delimiters inside real fences', () => {
    const text = 'outside `name`\n\n```ts\nconst key = `literal`\n```'
    expect(stripInlineCode(text)).toBe('outside name\n\n```ts\nconst key = `literal`\n```')
  })
})

describe('splitMarkdown', () => {
  it('re-closes every oversized fence chunk while preserving its body', () => {
    const text = '```ts\n' + 'x'.repeat(400) + '\n```'
    const chunks = splitMarkdown(text, 120)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.startsWith('```ts\n') && chunk.endsWith('```\n'))).toBe(true)
    const body = chunks
      .map(chunk => chunk.replace(/^```ts\n/, '').replace(/\n```\n$/, ''))
      .join('')
      .replace(/\n/g, '')
    expect(body).toBe('x'.repeat(400))
  })

  it('repeats table headers rather than cutting table structure', () => {
    const text = '| Key | Value |\n|---|---|\n| one | ' + 'x'.repeat(300) + ' |\n'
    const chunks = splitMarkdown(text, 120)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.startsWith('| Key | Value |\n|---|---|\n'))).toBe(true)
  })
})

describe('applyTableOverflow', () => {
  const sixTables = Array.from(
    { length: 6 },
    (_, index) => '| T' + index + ' |\n|---|\n| value-' + index + ' |',
  ).join('\n\n')

  it('counts only tables outside fences', () => {
    const text = '| A |\n|---|\n| 1 |\n\n```\n| B |\n|---|\n```'
    expect(countMarkdownTables(text)).toBe(1)
  })

  it('compacts or truncates only tables beyond the budget', () => {
    const compact = applyTableOverflow(sixTables, { mode: 'compact', maxTables: 5 })
    expect(compact.sourceTableCount).toBe(6)
    expect(compact.compactedTableCount).toBe(1)
    expect(compact.text).toContain('**Table 6 · Row 1**')
    expect(compact.text).toContain('value-5')

    const truncate = applyTableOverflow(sixTables, { mode: 'truncate', maxTables: 5 })
    expect(truncate.truncatedTableCount).toBe(1)
    expect(truncate.text).not.toContain('value-5')
  })
})

describe('MarkdownStreamFilter', () => {
  it('removes think tags even when a tag crosses chunk boundaries', () => {
    const filter = new MarkdownStreamFilter()
    expect(filter.push('before<thi')).toBe('before')
    expect(filter.push('nk>inside</think')).toBe('inside')
    expect(filter.push('>after')).toBe('after')
  })
})
