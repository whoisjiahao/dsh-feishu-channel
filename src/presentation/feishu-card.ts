/** Compose the frozen Feishu reply-card UI from one transport-free turn view. */

import { cardKitStatusLine, statusTag } from '../card-design.ts'
import { CARD_COLOR, SPACE_2, SPACE_3, SPACE_4, SPACE_5, SPACE_6, type CardTone } from '../card-tokens.ts'
import type { TurnStep, TurnView, TurnViewStatus } from './turn-view.ts'
import { inspectCardBudget, type CardBudgetInspection } from './card-budget.ts'
import {
  applyTableOverflow,
  normalizeMarkdownForCard,
  scanMarkdown,
  splitMarkdown,
  stripInlineCode,
} from './markdown.ts'

const CARD_TEXT_CHUNK = 2_400
const FAILURE_HEADING_LIMIT = 48
const FAILURE_MESSAGE_LIMIT = 240
const TOOL_LABEL_WIDTH = 72

const SPINNER = {
  intervalMs: 120,
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
} as const

const COLOR = {
  quiet: CARD_COLOR.grey,
  active: CARD_COLOR.blue,
  reasoning: CARD_COLOR.indigo,
  success: CARD_COLOR.green,
  failure: CARD_COLOR.red,
} as const

const DEFAULT_META_FIELDS = ['duration', 'model', 'input_tokens', 'output_tokens', 'context'] as const

/** Card-button payload marking this plugin's retry action. */
export const RETRY_ACTION = 'dsh-feishu-channel/retry'

/** Card-button payload marking this plugin's copy-error action. */
export const COPY_ERROR_ACTION = 'dsh-feishu-channel/copy-error'

/** Narrow an arbitrary card-action value to this plugin's retry payload. */
export function isRetryAction(value: unknown): value is { readonly kind: typeof RETRY_ACTION } {
  return objectValue(value)?.kind === RETRY_ACTION
}

/** Narrow an arbitrary card-action value to this plugin's copy-error payload. */
export function isCopyErrorAction(
  value: unknown,
): value is { readonly kind: typeof COPY_ERROR_ACTION; readonly text: string } {
  const payload = objectValue(value)
  return payload?.kind === COPY_ERROR_ACTION && typeof payload.text === 'string'
}

/** Describe one tool call for a step row; falls back to the raw tool name. */
export type ToolPresenter = (name: string, argumentsJson: string) => { readonly title: string }

/** Options controlling card assembly. */
export interface CardRenderOptions {
  readonly showProcess: boolean
  readonly maxTimelineItems: number
  readonly tableOverflowMode: 'compact' | 'truncate'
  readonly footerFields: readonly string[]
  readonly timelineExpanded?: boolean
  readonly presentCall?: ToolPresenter
}

/** The assembled card plus the platform-limit verdict. */
export interface CardRenderResult {
  readonly card: object
  readonly disposition: 'card' | 'native'
  readonly inspection: CardBudgetInspection
  readonly limitReason: string
}

type CardNode = object

interface MetaRow {
  readonly field: string
  readonly id: string
  readonly label: string
  readonly value: string
}

interface CardMeta {
  readonly duration: string
  readonly rows: readonly MetaRow[]
}

interface AnswerPartition {
  readonly heading: string
  readonly primary: string
  readonly details: string
}

interface HeadingBoundary {
  readonly start: number
  readonly contentStart: number
  readonly depth: number
  readonly label: string
}

/** Assemble a reply card, replacing an oversized result with the handoff card. */
export function renderCard(view: TurnView, options: CardRenderOptions): CardRenderResult {
  const candidate = composeReplyCard(view, options)
  const inspection = inspectCardBudget(candidate)
  if (inspection.safe) {
    return { card: candidate, disposition: 'card', inspection, limitReason: '' }
  }

  return {
    card: renderHandoffCard(isTerminal(view.status)),
    disposition: 'native',
    inspection,
    limitReason: inspection.primaryReason,
  }
}

/** Return one stable spinner frame for an integer index. */
export function spinnerFrame(index: number): string {
  const bounded = Math.max(0, Math.trunc(index))
  return SPINNER.frames[bounded % SPINNER.frames.length]!
}

/** Derive the spinner frame from elapsed time without retaining timer state. */
export function spinnerFrameIndex(elapsedMs: number): number {
  return Math.floor(Math.max(0, elapsedMs) / SPINNER.intervalMs)
}

/** Format a live elapsed time in the same notation as terminal duration. */
export function formatClock(elapsedMs: number): string {
  return formatDuration(elapsedMs / 1_000)
}

/** Format a local wall-clock time without seconds. */
export function formatWallClock(ms: number): string {
  return localTime(ms, false)
}

/** Format a local wall-clock time with seconds for timeline rows. */
export function formatStepTime(ms: number): string {
  return localTime(ms, true)
}

function composeReplyCard(view: TurnView, options: CardRenderOptions): CardNode {
  const now = Date.now()
  const renderedAt = isTerminal(view.status) ? view.finishedAt ?? now : now
  const elapsed = now - view.startedAt
  const meta = collectCardMeta(view, options.footerFields, renderedAt)
  const elements = [
    composeStatusDisclosure(view.status, formatWallClock(renderedAt), meta),
    divider('head_divider', '0px -' + SPACE_6 + ' 0px -' + SPACE_6),
    ...composeStatePanel(view, options, spinnerFrameIndex(elapsed)),
  ]

  return cardDocument(elements, SPACE_4, '0px ' + SPACE_6 + ' ' + SPACE_5 + ' ' + SPACE_6)
}

function composeStatePanel(view: TurnView, options: CardRenderOptions, frame: number): CardNode[] {
  switch (view.status) {
    case 'completed':
      return composeCompletedPanel(view, options)
    case 'failed':
      return composeFailedPanel(view, options)
    default:
      return composeLoadingPanel(view, options, frame)
  }
}

function composeLoadingPanel(view: TurnView, options: CardRenderOptions, frame: number): CardNode[] {
  const panel = [markdown('main_content', spinnerFrame(frame) + ' **正在分析**', 'heading')]
  if (options.showProcess && (view.steps.length > 0 || view.status === 'in_progress')) {
    const activity = composeLiveActivity(view, options, frame)
    if (activity !== undefined) panel.push(activity)
  }
  panel.push(composeLoadingSkeleton())
  return panel
}

function composeCompletedPanel(view: TurnView, options: CardRenderOptions): CardNode[] {
  const panel = view.answerText === '' ? [] : composeAnswer(view.answerText, options)
  if (!options.showProcess) return panel.length === 0 ? [emptyAnswer()] : panel
  if (panel.length > 0) panel.push(divider('main_divider'))
  panel.push(composeAnalysisDisclosure(view, options))
  return panel
}

function composeFailedPanel(view: TurnView, options: CardRenderOptions): CardNode[] {
  const panel = view.answerText === '' ? [] : composeMarkdown(view.answerText, options)
  if (panel.length > 0) panel.push(divider('main_divider'))
  panel.push(
    composeFailureHeading(view),
    composeFailureBox(view),
    composeFailureActions(view),
  )
  return panel
}

function composeAnswer(text: string, options: CardRenderOptions): CardNode[] {
  const partition = partitionAnswer(stripInlineCode(text))
  const nodes: CardNode[] = []
  if (partition.heading !== '') {
    nodes.push(markdown('answer_title', '**' + partition.heading + '**', 'heading'))
  }
  if (partition.primary !== '') nodes.push(...composeMarkdown(partition.primary, options))
  if (partition.details !== '') {
    nodes.push(simpleDisclosure(
      'answer_details',
      '**详细说明**',
      [markdown('answer_details_text', partition.details, 'normal')],
    ))
  }
  return nodes
}

/** Split answer content around the preferred conclusion and optional details heading. */
function partitionAnswer(input: string): AnswerPartition {
  const source = input.replace(/\r\n/g, '\n').trim()
  const headings = headingBoundaries(source)
  if (headings.length === 0) return { heading: '', primary: source, details: '' }

  const conclusion = headings.find(item => /(?:最终|核心|明确)结论/.test(plainLabel(item.label)))
    ?? headings[0]!
  const conclusionIndex = headings.indexOf(conclusion)
  const followingPeer = headings
    .slice(conclusionIndex + 1)
    .find(item => item.depth <= conclusion.depth)
  const conclusionEnd = followingPeer?.start ?? source.length

  let primary = source.slice(conclusion.contentStart, conclusionEnd).trim()
  let details = ''
  if (conclusionIndex === 0) {
    primary = joinText(primary, source.slice(conclusionEnd))
  } else {
    details = joinText(source.slice(0, conclusion.start), source.slice(conclusionEnd))
  }

  const detailsHeading = headingBoundaries(primary).find(item =>
    /^(?:详细说明|详细证据|证据与细节)$/.test(plainLabel(item.label)),
  )
  if (detailsHeading !== undefined) {
    details = joinText(details, primary.slice(detailsHeading.contentStart))
    primary = primary.slice(0, detailsHeading.start).trim()
  }

  return { heading: conclusion.label, primary, details }
}

/** Find ATX headings only inside prose blocks, so fenced code never becomes structure. */
function headingBoundaries(source: string): HeadingBoundary[] {
  const boundaries: HeadingBoundary[] = []
  const pattern = /^ {0,3}(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/gm
  for (const block of scanMarkdown(source)) {
    if (block.kind !== 'prose') continue
    for (const match of block.text.matchAll(pattern)) {
      const relative = match.index
      const full = match[0]
      const marks = match[1]
      const label = match[2]
      if (relative === undefined || full === undefined || marks === undefined || label === undefined) continue
      const start = block.start + relative
      boundaries.push({
        start,
        contentStart: start + full.length,
        depth: marks.length,
        label: label.trim(),
      })
    }
  }
  return boundaries.sort((left, right) => left.start - right.start)
}

function plainLabel(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function joinText(...parts: string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n\n')
}

function composeStatusDisclosure(status: TurnViewStatus, clock: string, meta: CardMeta): CardNode {
  const visual = statusVisual(status)
  const title = [clock, meta.duration, statusTag(visual.label, visual.tone)].join(' · ')
  return {
    tag: 'collapsible_panel',
    element_id: 'card_head',
    expanded: false,
    direction: 'vertical',
    margin: '5px 0px 5px 0px',
    padding: '0px',
    vertical_spacing: SPACE_2,
    header: {
      title: { tag: 'markdown', content: title, text_size: 'notation' },
      width: 'fill',
      vertical_align: 'center',
      padding: '0px',
      icon: disclosureIcon(),
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: [composeMetaRows(meta.rows)],
  }
}

function composeMetaRows(rows: readonly MetaRow[]): CardNode {
  const column = (side: 'label' | 'value'): CardNode => ({
    tag: 'column',
    width: side === 'label' ? 'auto' : 'weighted',
    ...(side === 'value' ? { weight: 1 } : {}),
    vertical_spacing: '3px',
    elements: rows.map(row => side === 'label' ? metaLabel(row) : metaValue(row)),
  })

  return {
    tag: 'column_set',
    element_id: 'head_details',
    flex_mode: 'none',
    horizontal_spacing: SPACE_3,
    margin: '1px 0px 3px 0px',
    columns: [column('label'), column('value')],
  }
}

function metaLabel(row: MetaRow): CardNode {
  return { tag: 'div', text: plainText(row.label, { text_size: 'notation', text_color: COLOR.quiet, lines: 1 }) }
}

function metaValue(row: MetaRow): CardNode {
  return {
    tag: 'div',
    element_id: 'head_' + row.id,
    width: 'fill',
    text: plainText(row.value, {
      text_size: 'notation',
      text_color: COLOR.quiet,
      text_align: 'right',
      lines: 1,
    }),
  }
}

function statusVisual(status: TurnViewStatus): { readonly label: string; readonly tone: CardTone } {
  const visuals: Record<TurnViewStatus, { readonly label: string; readonly tone: CardTone }> = {
    thinking: { label: '处理中', tone: 'neutral' },
    in_progress: { label: '处理中', tone: 'neutral' },
    completed: { label: '已完成', tone: 'success' },
    failed: { label: '失败', tone: 'failure' },
  }
  return visuals[status]
}

/** Turn Markdown into separately spaced CardKit blocks without losing structure. */
function composeMarkdown(text: string, options: CardRenderOptions): CardNode[] {
  const normalized = normalizeMarkdownForCard(text)
  const boundedTables = applyTableOverflow(normalized, { mode: options.tableOverflowMode }).text
  const groups: string[] = []

  for (const block of scanMarkdown(boundedTables)) {
    const previous = groups.at(-1)
    if (block.kind === 'list' && previous !== undefined && !/\n\s*\n$/.test(previous)) {
      groups[groups.length - 1] = previous + block.text
    } else {
      groups.push(block.text)
    }
  }

  const chunks = groups
    .filter(group => group.trim() !== '')
    .flatMap(group => group.length <= CARD_TEXT_CHUNK ? [group] : splitMarkdown(group, CARD_TEXT_CHUNK))
  const visible = chunks.length === 0 ? splitMarkdown(boundedTables, CARD_TEXT_CHUNK) : chunks
  return visible.map((content, index) => markdown(
    index === 0 ? 'main_content' : 'main_content_' + index,
    content,
  ))
}

function composeLoadingSkeleton(): CardNode {
  const widths = [[5, 1], [3, 2], [2, 3]] as const
  return {
    tag: 'column_set',
    element_id: 'loading_skeleton',
    flex_mode: 'none',
    horizontal_spacing: '0px',
    margin: SPACE_5 + ' 0px 0px 0px',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: SPACE_3,
      elements: widths.map(([bar, space], index) => skeletonRow(index + 1, bar, space)),
    }],
  }
}

function skeletonRow(index: number, barWeight: number, spaceWeight: number): CardNode {
  const segment = (weight: number, filled: boolean): CardNode => ({
    tag: 'column',
    width: 'weighted',
    weight,
    ...(filled ? { background_style: COLOR.quiet, padding: '6px 0px 6px 0px' } : {}),
    elements: [],
  })
  return {
    tag: 'column_set',
    element_id: 'skeleton_bar_' + index,
    flex_mode: 'none',
    horizontal_spacing: '0px',
    columns: [segment(barWeight, true), segment(spaceWeight, false)],
  }
}

function composeLiveActivity(
  view: TurnView,
  options: CardRenderOptions,
  frame: number,
): CardNode | undefined {
  const lines = timelineLines(view.steps, options, frame, true)
  return lines.length === 0 ? undefined : markdown('live_steps', lines.join('\n'), 'small')
}

function timelineLines(
  steps: readonly TurnStep[],
  options: CardRenderOptions,
  frame: number,
  appendNextStep: boolean,
): string[] {
  const visible = steps.slice(-options.maxTimelineItems)
  const hidden = steps.length - visible.length
  const lines = hidden > 0
    ? ['<font color="' + COLOR.quiet + '">已折叠 ' + hidden + ' 条早期步骤</font>']
    : []
  lines.push(...visible.map(step => timelineLine(step, options, frame)))
  if (appendNextStep) lines.push('<font color="' + COLOR.quiet + '">下一步 · 生成回复</font>')
  return lines
}

function timelineLine(step: TurnStep, options: CardRenderOptions, frame: number): string {
  const timestamp = formatStepTime(step.atMs)
  if (step.kind === 'reasoning') {
    return timestamp + ' <font color="' + COLOR.reasoning + '">**思考**</font> · ' + step.status
  }

  const indicator = toolIndicator(step.status, frame)
  const label = boundedToolLabel(step, options)
  return timestamp + ' <font color="' + indicator.color + '">' + indicator.glyph + '</font> **'
    + escapeCardText(label) + '**'
}

function toolIndicator(
  status: Extract<TurnStep, { kind: 'tool' }>['status'],
  frame: number,
): { readonly glyph: string; readonly color: string } {
  const terminal = {
    completed: { glyph: '✓', color: COLOR.success },
    failed: { glyph: '✕', color: COLOR.failure },
  } as const
  return status === 'running'
    ? { glyph: spinnerFrame(frame), color: COLOR.active }
    : terminal[status]
}

function boundedToolLabel(step: Extract<TurnStep, { kind: 'tool' }>, options: CardRenderOptions): string {
  const presented = compactLine(callTitle(options.presentCall, step.name, step.argumentsJson))
  const preferred = presented === '' ? compactLine(step.name) : presented
  if (visualWidth(preferred) <= TOOL_LABEL_WIDTH) return preferred === '' ? '工具' : preferred

  const rawName = compactLine(step.name)
  return rawName !== '' && visualWidth(rawName) <= TOOL_LABEL_WIDTH ? rawName : '执行工具'
}

function callTitle(presenter: ToolPresenter | undefined, name: string, argumentsJson: string): string {
  if (presenter === undefined) return ''
  try {
    const title = presenter(name, argumentsJson)?.title
    return typeof title === 'string' ? title : ''
  } catch {
    return ''
  }
}

function visualWidth(value: string): number {
  let width = 0
  for (const character of value) width += /[^\u0000-\u00ff]/.test(character) ? 2 : 1
  return width
}

function composeAnalysisDisclosure(view: TurnView, options: CardRenderOptions): CardNode {
  const ordered = [...view.steps].sort((left, right) => left.atMs - right.atMs)
  const visible = ordered.slice(-options.maxTimelineItems)
  const hidden = ordered.length - visible.length
  const content: CardNode[] = []

  if (hidden > 0) content.push(markdown('timeline_folded', '> 已折叠 ' + hidden + ' 条早期步骤', 'x-small'))
  if (visible.length === 0) {
    content.push(markdown(
      'timeline_empty',
      '<font color="' + COLOR.quiet + '">本轮直接生成回复</font>',
      'small',
    ))
  } else {
    const elapsed = (view.finishedAt ?? Date.now()) - view.startedAt
    const lines = visible.map(step => timelineLine(step, options, spinnerFrameIndex(elapsed)))
    content.push(markdown('timeline_steps', lines.join('\n'), 'small'))
  }

  return {
    tag: 'collapsible_panel',
    element_id: 'analysis_timeline',
    expanded: options.timelineExpanded ?? false,
    margin: '0px',
    padding: '0px',
    vertical_spacing: SPACE_2,
    header: {
      title: { tag: 'markdown', content: '🔍 **分析过程**' },
      icon: disclosureIcon(),
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: content,
  }
}

function composeFailureHeading(view: TurnView): CardNode {
  const reason = bounded(compactLine(view.errorMessage), FAILURE_HEADING_LIMIT)
  const label = reason === '' ? '分析失败' : '分析失败：' + escapeCardText(reason)
  return markdown('failure_title', '**' + label + '**', 'heading')
}

function composeFailureBox(view: TurnView): CardNode {
  const lines: string[] = []
  if (view.errorCode !== '') {
    lines.push('<font color="' + COLOR.failure + '">**' + escapeCardText(view.errorCode) + '**</font>')
  }
  const message = bounded(compactLine(view.errorMessage), FAILURE_MESSAGE_LIMIT)
  if (message !== '') lines.push(escapeCardText(message))
  lines.push('<font color="' + COLOR.quiet + '">last attempt: ' + failureTime(view) + '</font>')

  return {
    tag: 'column_set',
    element_id: 'failure_error_box',
    flex_mode: 'none',
    background_style: COLOR.failure,
    horizontal_spacing: '0px',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: COLOR.failure,
      padding: SPACE_4 + ' ' + SPACE_3 + ' ' + SPACE_4 + ' ' + SPACE_3,
      elements: [markdown('failure_error', lines.join('<br>'), 'small')],
    }],
  }
}

function composeFailureActions(view: TurnView): CardNode {
  const actionColumn = (
    id: string,
    label: string,
    type: 'primary' | 'default',
    value: Record<string, string>,
  ): CardNode => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      element_id: id,
      text: plainText(label),
      type,
      width: 'default',
      size: 'medium',
      behaviors: [{ type: 'callback', value }],
    }],
  })

  return {
    tag: 'column_set',
    element_id: 'failure_actions',
    flex_mode: 'none',
    horizontal_spacing: SPACE_3,
    columns: [
      actionColumn('retry_button', '↻ 重试', 'primary', { kind: RETRY_ACTION }),
      actionColumn('copy_error_button', '复制错误', 'default', {
        kind: COPY_ERROR_ACTION,
        text: copyableError(view),
      }),
    ],
  }
}

function copyableError(view: TurnView): string {
  const parts: string[] = []
  if (view.errorCode !== '') parts.push(view.errorCode)
  const message = bounded(compactLine(view.errorMessage), 120)
  if (message !== '') parts.push(message)
  parts.push('last attempt: ' + failureTime(view))
  return parts.join(' · ')
}

function collectCardMeta(view: TurnView, requested: readonly string[], renderedAt: number): CardMeta {
  const duration = isTerminal(view.status)
    ? formatDuration(view.durationMs / 1_000)
    : formatClock(renderedAt - view.startedAt)
  const usage = view.usage
  const inputTokens = usage?.inputTokens
  const catalog: readonly MetaRow[] = [
    { field: 'duration', id: 'duration', label: '耗时', value: duration },
    { field: 'model', id: 'model', label: '模型', value: view.model.trim() },
    {
      field: 'input_tokens',
      id: 'input',
      label: '输入 Token',
      value: inputTokens !== undefined && inputTokens > 0 ? '↑' + formatCount(inputTokens) : '',
    },
    {
      field: 'output_tokens',
      id: 'output',
      label: '输出 Token',
      value: usage !== undefined && usage.outputTokens > 0 ? '↓' + formatCount(usage.outputTokens) : '',
    },
    { field: 'context', id: 'context', label: 'ctx', value: formatContext(inputTokens, view.contextWindow) },
  ]

  const fields = requested.length === 0 ? DEFAULT_META_FIELDS : requested
  const rows: MetaRow[] = []
  const included = new Set<string>()
  for (const field of fields) {
    const row = catalog.find(candidate => candidate.field === field)
    if (row === undefined || row.id === 'duration' || row.value === '' || included.has(row.id)) continue
    rows.push(row)
    included.add(row.id)
  }
  if (!included.has('context')) rows.push(catalog.find(row => row.id === 'context')!)
  return { duration, rows }
}

function formatContext(used: number | undefined, capacity: number | undefined): string {
  const safeUsed = used === undefined ? undefined : Math.max(0, used)
  const percent = safeUsed === undefined || capacity === undefined
    ? 0
    : Math.min(100, Math.round(safeUsed / capacity * 100))
  return (safeUsed === undefined ? '—' : formatCount(safeUsed))
    + '/' + (capacity === undefined ? '—' : formatCount(capacity))
    + ' · ' + percent + '%'
}

/** Render seconds as a compact h/m/s duration. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor(total % 3_600 / 60)
  const remainder = total % 60
  if (hours > 0) return hours + 'h' + minutes + 'm' + remainder + 's'
  if (minutes > 0) return minutes + 'm' + remainder + 's'
  return remainder + 's'
}

/** Format a token count with compact decimal suffixes. */
export function formatCount(value: number): string {
  if (value < 1_000) return String(value)
  const factor = value >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = factor === 1_000_000 ? 'm' : 'k'
  const scaled = value / factor
  if (scaled >= 100 || Number.isInteger(scaled)) return Math.round(scaled) + suffix
  return scaled.toFixed(1).replace(/\.0$/, '') + suffix
}

/** Build the compact card shown before native-message delivery. */
export function renderHandoffCard(terminal: boolean): object {
  const message = terminal
    ? '完整内容已切换为原生消息发送。'
    : '内容较长，完成后将由原生消息发送。'
  const status = terminal ? '已完成' : '生成中'
  return cardDocument([
    cardKitStatusLine('handoff_status', '内容交付', status, terminal ? 'success' : 'warning'),
    divider('handoff_divider', '0px -' + SPACE_6 + ' ' + SPACE_4 + ' -' + SPACE_6),
    markdown('main_content', message),
  ], '0px', '0px ' + SPACE_6 + ' ' + SPACE_5 + ' ' + SPACE_6)
}

function simpleDisclosure(id: string, title: string, elements: readonly CardNode[]): CardNode {
  return {
    tag: 'collapsible_panel',
    element_id: id,
    expanded: false,
    margin: '0px',
    padding: SPACE_3 + ' 0px 0px 0px',
    vertical_spacing: SPACE_2,
    header: { title: { tag: 'markdown', content: title }, padding: '0px' },
    elements,
  }
}

function cardDocument(elements: readonly CardNode[], spacing: string, padding: string): CardNode {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { direction: 'vertical', vertical_spacing: spacing, padding, elements },
  }
}

function divider(id: string, margin?: string): CardNode {
  return { tag: 'hr', element_id: id, ...(margin === undefined ? {} : { margin }) }
}

function markdown(id: string, content: string, size?: string): CardNode {
  return { tag: 'markdown', element_id: id, content, ...(size === undefined ? {} : { text_size: size }) }
}

function plainText(content: string, extra: Record<string, unknown> = {}): CardNode {
  return { tag: 'plain_text', content, ...extra }
}

function disclosureIcon(): CardNode {
  return {
    tag: 'standard_icon',
    token: 'down-small-ccm_outlined',
    color: COLOR.quiet,
    size: '14px 14px',
  }
}

function emptyAnswer(): CardNode {
  return markdown('main_content', '<font color="' + COLOR.quiet + '">—</font>', 'x-small')
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeCardText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function localTime(ms: number, includeSeconds: boolean): string {
  const date = new Date(ms)
  const values = [date.getHours(), date.getMinutes(), ...(includeSeconds ? [date.getSeconds()] : [])]
  return values.map(value => String(value).padStart(2, '0')).join(':')
}

function failureTime(view: TurnView): string {
  return formatStepTime(view.finishedAt ?? Date.now())
}

function isTerminal(status: TurnViewStatus): boolean {
  return status === 'completed' || status === 'failed'
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
