/** Structure-aware Markdown preparation for Feishu cards. */

const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TABLE_SEPARATOR = /^:?-{3,}:?$/
const LIST_START = /^ {0,3}(?:[-+*]|\d{1,4}\.)\s+/
const THINK_TAGS = ['<think>', '</think>', '<thinking>', '</thinking>'] as const
const THINK_TAG = /<\/?think(?:ing)?>/gi
const TABLE_COMPACT_NOTE = '> 后续表格已转换为紧凑字段列表，以兼容飞书卡片限制；内容完整保留。'
const TABLE_TRUNCATE_NOTE = '> 内容含超过 5 个表格，超出部分已省略。'

/** Parsed table content retained by a table block. */
export interface MarkdownTable {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/** One non-overlapping source region with explicit Markdown semantics. */
export interface MarkdownBlock {
  readonly kind: 'prose' | 'list' | 'fence' | 'table'
  readonly text: string
  readonly start: number
  readonly end: number
  readonly table?: MarkdownTable | undefined
}

/** Result of enforcing the card's Markdown table budget. */
export interface TableOverflow {
  readonly text: string
  readonly sourceTableCount: number
  readonly compactedTableCount: number
  readonly truncatedTableCount: number
}

function linesOf(text: string): string[] {
  return text.match(/.*(?:\n|$)/g)?.filter(line => line !== '') ?? []
}

function lineText(line: string): string {
  return line.replace(/\r?\n$/, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fenceStart(line: string): { readonly marker: string; readonly info: string } | undefined {
  const match = FENCE_START.exec(lineText(line))
  if (match === null) return undefined
  return { marker: match[1]!, info: match[2]!.trim() }
}

function closesFence(line: string, marker: string): boolean {
  const pattern = new RegExp('^ {0,3}' + escapeRegExp(marker[0]!) + '{' + marker.length + ',}\\s*$')
  return pattern.test(lineText(line))
}

/** Parse one Markdown table row while respecting escapes and inline-code spans. */
export function parseTableRow(row: string): string[] | undefined {
  const source = row.trim()
  if (source === '') return undefined
  const cells: string[] = []
  let cell = ''
  let delimiters = 0
  let codeRun = 0
  let cursor = 0
  while (cursor < source.length) {
    const character = source[cursor]!
    if (character === '\\' && cursor + 1 < source.length) {
      cell += source.slice(cursor, cursor + 2)
      cursor += 2
      continue
    }
    if (character === '`') {
      let end = cursor + 1
      while (source[end] === '`') end += 1
      const run = end - cursor
      cell += source.slice(cursor, end)
      codeRun = codeRun === 0 ? run : codeRun === run ? 0 : codeRun
      cursor = end
      continue
    }
    if (character === '|' && codeRun === 0) {
      cells.push(cell.trim())
      cell = ''
      delimiters += 1
      cursor += 1
      continue
    }
    cell += character
    cursor += 1
  }
  cells.push(cell.trim())
  if (delimiters === 0) return undefined
  if (source.startsWith('|')) cells.shift()
  if (source.endsWith('|')) cells.pop()
  return cells.length === 0 ? undefined : cells
}

function tableAt(lines: readonly string[], index: number): MarkdownTable | undefined {
  if (index + 1 >= lines.length) return undefined
  const headers = parseTableRow(lineText(lines[index]!))
  const separator = parseTableRow(lineText(lines[index + 1]!))
  if (
    headers === undefined
    || separator === undefined
    || headers.length !== separator.length
    || !separator.every(cell => TABLE_SEPARATOR.test(cell.trim()))
  ) return undefined
  return { headers, rows: [] }
}

/** Scan source Markdown into explicit blocks while preserving every byte. */
export function scanMarkdown(text: string): MarkdownBlock[] {
  if (text === '') return [{ kind: 'prose', text: '', start: 0, end: 0 }]
  const lines = linesOf(text)
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length
  }

  const blocks: MarkdownBlock[] = []
  let proseStart = 0
  let prose: string[] = []
  const flushProse = (end: number): void => {
    if (prose.length === 0) return
    blocks.push({ kind: 'prose', text: prose.join(''), start: proseStart, end })
    prose = []
  }

  let index = 0
  while (index < lines.length) {
    const opening = fenceStart(lines[index]!)
    if (opening !== undefined) {
      flushProse(offsets[index]!)
      const start = offsets[index]!
      const region = [lines[index]!]
      index += 1
      while (index < lines.length) {
        const line = lines[index]!
        region.push(line)
        index += 1
        if (closesFence(line, opening.marker)) break
      }
      const value = region.join('')
      blocks.push({ kind: 'fence', text: value, start, end: start + value.length })
      continue
    }

    const parsedTable = tableAt(lines, index)
    if (parsedTable !== undefined) {
      flushProse(offsets[index]!)
      const start = offsets[index]!
      const region = [lines[index]!, lines[index + 1]!]
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const row = parseTableRow(lineText(lines[index]!))
        if (row === undefined) break
        region.push(lines[index]!)
        rows.push(row)
        index += 1
      }
      const value = region.join('')
      blocks.push({
        kind: 'table',
        text: value,
        start,
        end: start + value.length,
        table: { headers: parsedTable.headers, rows },
      })
      continue
    }

    if (LIST_START.test(lineText(lines[index]!))) {
      flushProse(offsets[index]!)
      const start = offsets[index]!
      const region: string[] = []
      while (index < lines.length) {
        const line = lines[index]!
        const raw = lineText(line)
        if (!LIST_START.test(raw) && !/^ {2,}\S/.test(raw)) break
        region.push(line)
        index += 1
      }
      const value = region.join('')
      blocks.push({ kind: 'list', text: value, start, end: start + value.length })
      continue
    }

    if (prose.length === 0) proseStart = offsets[index]!
    prose.push(lines[index]!)
    index += 1
  }
  flushProse(text.length)
  return blocks.length === 0 ? [{ kind: 'prose', text, start: 0, end: text.length }] : blocks
}

function stripInlineCodeLine(line: string): string {
  let output = ''
  let cursor = 0
  while (cursor < line.length) {
    if (line[cursor] !== '`' || line[cursor - 1] === '\\') {
      output += line[cursor]
      cursor += 1
      continue
    }
    let markerEnd = cursor + 1
    while (line[markerEnd] === '`') markerEnd += 1
    const marker = line.slice(cursor, markerEnd)
    const closing = line.indexOf(marker, markerEnd)
    if (closing < 0) {
      output += marker
      cursor = markerEnd
      continue
    }
    output += line.slice(markerEnd, closing)
    cursor = closing + marker.length
  }
  return output
}

/** Remove inline-code styling outside fenced code blocks. */
export function stripInlineCode(text: string): string {
  return scanMarkdown(text).map(block => block.kind === 'fence'
    ? block.text
    : linesOf(block.text).map(stripInlineCodeLine).join('')).join('')
}

function expandInlineNumbering(line: string): string {
  const first = /^ {0,3}(\d{1,4})\.\s+/.exec(line)
  if (first === null) return line
  let expected = Number(first[1]) + 1
  let contiguous = true
  return line.replace(/、\s*(\d{1,4})\.\s+/g, (source, numberText: string) => {
    if (!contiguous || Number(numberText) !== expected) {
      contiguous = false
      return source
    }
    expected += 1
    return '\n' + numberText + '. '
  })
}

function normalizeInlineNumbering(text: string): string {
  return scanMarkdown(text).map(block => block.kind === 'fence' || block.kind === 'table'
    ? block.text
    : linesOf(block.text).map(expandInlineNumbering).join('')).join('')
}

function unwrapInventory(block: string): string {
  const lines = linesOf(block)
  if (lines.length < 3) return block
  const opening = fenceStart(lines[0]!)
  if (opening === undefined || !['', 'text', 'plaintext', 'txt'].includes(opening.info.toLowerCase())) return block
  if (!closesFence(lines.at(-1)!, opening.marker)) return block

  const items = new Map<number, string>()
  for (const line of lines.slice(1, -1)) {
    const row = lineText(line).trim()
    if (row === '') continue
    const match = /^(\d{1,4})[.)]?\s+(\S+)(?:\s+(\d{1,4})[.)]?\s+(\S+))?$/.exec(row)
    if (match === null) return block
    const pairs = [[match[1]!, match[2]!], ...(match[3] === undefined ? [] : [[match[3], match[4]!]])] as const
    for (const [rawNumber, label] of pairs) {
      const number = Number(rawNumber)
      if (items.has(number)) return block
      items.set(number, label)
    }
  }
  if (items.size < 4) return block

  const ordered = [...items].sort(([left], [right]) => left - right)
  const firstNumber = ordered[0]![0]
  if (!ordered.every(([number], index) => number === firstNumber + index)) return block
  const markdown = ordered.map(([number, label]) => number + '. ' + label).join('\n')
  return markdown + (block.endsWith('\n') ? '\n' : '')
}

function normalizeInventoryFences(text: string): string {
  return scanMarkdown(text).map(block => block.kind === 'fence' ? unwrapInventory(block.text) : block.text).join('')
}

/** Apply all visual Markdown normalizations used by reply and command cards. */
export function normalizeMarkdownForCard(text: string): string {
  return stripInlineCode(normalizeInlineNumbering(normalizeInventoryFences(text)))
}

/** Count actual Markdown tables, excluding fenced examples. */
export function countMarkdownTables(text: string): number {
  return scanMarkdown(text).filter(block => block.kind === 'table').length
}

function tableHeaders(headers: readonly string[], columns: number): string[] {
  const seen = new Map<string, number>()
  return Array.from({ length: columns }, (_, index) => {
    const base = headers[index]?.trim() || 'Column ' + (index + 1)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : base + ' (' + count + ')'
  })
}

function compactTable(table: MarkdownTable, tableNumber: number): string {
  const columns = Math.max(table.headers.length, ...table.rows.map(row => row.length))
  const headers = tableHeaders(table.headers, columns)
  if (table.rows.length === 0) {
    return '**Table ' + tableNumber + '**\n- Columns: ' + headers.join(', ') + '\n- Rows: （空）\n\n'
  }
  return table.rows.map((row, rowIndex) => [
    '**Table ' + tableNumber + ' · Row ' + (rowIndex + 1) + '**',
    ...headers.map((header, column) => '- ' + header + ': ' + (row[column] ?? '')),
  ].join('\n')).join('\n\n') + '\n\n'
}

/** Compact or truncate Markdown tables beyond the allowed count. */
export function applyTableOverflow(
  text: string,
  options: { readonly mode: 'compact' | 'truncate'; readonly maxTables?: number } = { mode: 'compact' },
): TableOverflow {
  const maxTables = Math.max(0, Math.floor(options.maxTables ?? 5))
  const blocks = scanMarkdown(text)
  const sourceTableCount = blocks.filter(block => block.kind === 'table').length
  const overflow = Math.max(0, sourceTableCount - maxTables)
  if (overflow === 0) {
    return { text, sourceTableCount, compactedTableCount: 0, truncatedTableCount: 0 }
  }

  let tableNumber = 0
  let wroteNote = false
  const output: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'table') {
      output.push(block.text)
      continue
    }
    tableNumber += 1
    if (tableNumber <= maxTables) {
      output.push(block.text)
      continue
    }
    if (!wroteNote) {
      output.push((options.mode === 'compact' ? TABLE_COMPACT_NOTE : TABLE_TRUNCATE_NOTE) + '\n\n')
      wroteNote = true
    }
    if (options.mode === 'compact' && block.table !== undefined) {
      output.push(compactTable(block.table, tableNumber))
    }
  }
  return {
    text: output.join(''),
    sourceTableCount,
    compactedTableCount: options.mode === 'compact' ? overflow : 0,
    truncatedTableCount: options.mode === 'truncate' ? overflow : 0,
  }
}

function splitPlain(text: string, maxChars: number): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1)
    const newline = window.lastIndexOf('\n')
    const space = window.lastIndexOf(' ')
    const boundary = Math.max(newline >= 0 ? newline + 1 : 0, space >= 0 ? space + 1 : 0)
    const size = boundary > 0 ? boundary : maxChars
    chunks.push(remaining.slice(0, size))
    remaining = remaining.slice(size)
  }
  if (remaining !== '' || chunks.length === 0) chunks.push(remaining)
  return chunks
}

function wrapFence(opening: string, body: string, closing: string): string {
  return opening + body + (body === '' || body.endsWith('\n') ? '' : '\n') + closing
}

function splitFence(block: string, maxChars: number): string[] {
  const lines = linesOf(block)
  const openingInfo = fenceStart(lines[0] ?? '')
  if (openingInfo === undefined) return splitPlain(block, maxChars)
  const opening = (lines[0]!.endsWith('\n') ? lines[0]! : lines[0]! + '\n')
  const hasClosing = lines.length > 1 && closesFence(lines.at(-1)!, openingInfo.marker)
  const closing = hasClosing
    ? (lines.at(-1)!.endsWith('\n') ? lines.at(-1)! : lines.at(-1)! + '\n')
    : openingInfo.marker + '\n'
  const body = (hasClosing ? lines.slice(1, -1) : lines.slice(1)).join('')
  const capacity = maxChars - opening.length - closing.length
  if (capacity < 1) return [block]
  return splitPlain(body, capacity).map(part => wrapFence(opening, part, closing))
}

function formatTableRow(cells: readonly string[]): string {
  return '| ' + cells.map(cell => cell.trim()).join(' | ') + ' |\n'
}

function splitOversizedRow(row: string, maxChars: number): string[] {
  const cells = parseTableRow(lineText(row))
  if (cells === undefined) return splitPlain(row, maxChars)
  let target = 0
  for (let index = 1; index < cells.length; index += 1) {
    if (cells[index]!.length > cells[target]!.length) target = index
  }
  const firstTemplate = [...cells]
  firstTemplate[target] = ''
  const continuationTemplate = cells.map(() => '')
  const firstCapacity = maxChars - formatTableRow(firstTemplate).length
  const continuationCapacity = maxChars - formatTableRow(continuationTemplate).length
  if (firstCapacity < 1 || continuationCapacity < 1) return [row]

  const output: string[] = []
  let remaining = cells[target]!
  let first = true
  while (remaining !== '') {
    const capacity = first ? firstCapacity : continuationCapacity
    const piece = remaining.slice(0, capacity)
    remaining = remaining.slice(capacity)
    const rowCells = first ? [...cells] : cells.map(() => '')
    rowCells[target] = piece
    output.push(formatTableRow(rowCells))
    first = false
  }
  return output
}

function splitTable(block: string, maxChars: number): string[] {
  const lines = linesOf(block)
  if (lines.length <= 2) return [block]
  const header = lines.slice(0, 2).join('')
  if (header.length >= maxChars) return [block]
  const rowBudget = maxChars - header.length
  const rows = lines.slice(2).flatMap(row => row.length > rowBudget ? splitOversizedRow(row, rowBudget) : [row])
  const chunks: string[] = []
  let body = ''
  for (const row of rows) {
    if (body !== '' && body.length + row.length > rowBudget) {
      chunks.push(header + body)
      body = ''
    }
    if (row.length > rowBudget) {
      if (body !== '') {
        chunks.push(header + body)
        body = ''
      }
      chunks.push(header + row)
      continue
    }
    body += row
  }
  if (body !== '' || chunks.length === 0) chunks.push(header + body)
  return chunks
}

/** Split Markdown to size while re-closing fences and repeating table headers. */
export function splitMarkdown(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer')
  if (text === '' || text.length <= maxChars) return [text]
  const chunks: string[] = []
  let plain = ''
  const flushPlain = (): void => {
    if (plain !== '') chunks.push(plain)
    plain = ''
  }
  for (const block of scanMarkdown(text)) {
    if (block.kind === 'fence' || block.kind === 'table') {
      flushPlain()
      chunks.push(...(block.kind === 'fence' ? splitFence(block.text, maxChars) : splitTable(block.text, maxChars)))
      continue
    }
    for (const piece of splitPlain(block.text, maxChars)) {
      if (plain !== '' && plain.length + piece.length > maxChars) flushPlain()
      plain += piece
      if (plain.length >= maxChars) flushPlain()
    }
  }
  flushPlain()
  return chunks.length === 0 ? [''] : chunks
}

/** Stateful filter for think tags split across model stream chunks. */
export class MarkdownStreamFilter {
  private suffix = ''

  push(delta: string): string {
    const combined = this.suffix + delta
    const lower = combined.toLowerCase()
    let held = 0
    for (const tag of THINK_TAGS) {
      for (let size = 1; size < tag.length; size += 1) {
        if (lower.endsWith(tag.slice(0, size))) held = Math.max(held, size)
      }
    }
    this.suffix = held === 0 ? '' : combined.slice(-held)
    return combined.slice(0, combined.length - held).replace(THINK_TAG, '')
  }
}
