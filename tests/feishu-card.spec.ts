import { describe, expect, it, vi } from 'vitest'
import { TurnView } from '../src/presentation/turn-view.ts'
import {
  COPY_ERROR_ACTION,
  formatClock,
  formatCount,
  formatDuration,
  formatStepTime,
  formatWallClock,
  isCopyErrorAction,
  isRetryAction,
  renderCard,
  RETRY_ACTION,
  spinnerFrame,
  spinnerFrameIndex,
} from '../src/presentation/feishu-card.ts'
import type { CardRenderOptions } from '../src/presentation/feishu-card.ts'
import type { HostSessionEvent } from '../src/host.ts'

function event(type: string, data: object): HostSessionEvent {
  return { type, data }
}

const options: CardRenderOptions = {
  showProcess: true,
  maxTimelineItems: 12,
  tableOverflowMode: 'compact',
  footerFields: ['duration', 'model', 'input_tokens', 'output_tokens', 'context'],
}

interface CardElement {
  tag?: string
  element_id?: string
  flex_mode?: string
  expanded?: boolean
  content?: string
  margin?: string
  padding?: string
  text?: { content?: string; lines?: number; text_align?: string; text_size?: string; text_color?: string }
  icon?: { tag?: string; token?: string; color?: string; size?: string }
  background_style?: string
  width?: string
  weight?: number
  behaviors?: { type?: string; value?: unknown }[]
  header?: {
    title?: { tag?: string; content?: string; text_size?: string }
    icon?: { tag?: string; token?: string; color?: string; size?: string }
    icon_position?: string
    icon_expanded_angle?: number
    width?: string
  }
  elements?: CardElement[]
  columns?: CardElement[]
}

interface ParsedCard {
  header?: object
  body: { padding?: string; vertical_spacing?: string; elements: CardElement[] }
}

function parse(card: object): ParsedCard {
  return JSON.parse(JSON.stringify(card)) as ParsedCard
}

function elementOf(card: ParsedCard, id: string): CardElement | undefined {
  const search = (elements: CardElement[]): CardElement | undefined => {
    for (const element of elements) {
      if (element.element_id === id) return element
      for (const nested of [element.elements, element.columns]) {
        if (nested === undefined) continue
        const found = search(nested)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return search(card.body.elements)
}

function contentOf(card: ParsedCard, id: string): string {
  return elementOf(card, id)?.content ?? ''
}

function textOf(card: ParsedCard, id: string): string {
  return elementOf(card, id)?.text?.content ?? ''
}

function titleOf(card: ParsedCard, id: string): string {
  return elementOf(card, id)?.header?.title?.content ?? ''
}

/** All answer-body markdown elements concatenated, in order. */
function bodyTextOf(card: ParsedCard): string {
  return card.body.elements
    .filter(element => (element.element_id ?? '').startsWith('main_content'))
    .map(element => element.content ?? '')
    .join('\n')
}

describe('renderCard', () => {
  it('renders a completed card: compact green pill row, answer, and the analysis collapse', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '答案' } }))
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    }))
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model: 'deepseek-v4-flash' } },
      usage: { inputTokens: 35_900, outputTokens: 362 },
    }))
    s.observe(event('request/context', {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const { card, disposition, inspection } = renderCard(s, options)
    expect(disposition).toBe('card')
    expect(inspection.safe).toBe(true)
    const parsed = parse(card)
    // The status line is the full-width native disclosure title, so its arrow
    // stays at the card's right edge on both desktop and mobile.
    expect(parsed.header).toBeUndefined()
    const head = elementOf(parsed, 'card_head')
    expect(head?.tag).toBe('collapsible_panel')
    expect(head?.expanded).toBe(false)
    expect(head?.margin).toBe('5px 0px 5px 0px')
    expect(head?.behaviors).toBeUndefined()
    expect(head?.header?.title)
      .toEqual({
        tag: 'markdown',
        content: expect.stringMatching(/^\d{2}:\d{2} · 0s · <text_tag color='green'>已完成<\/text_tag>$/),
        text_size: 'notation',
      })
    expect(head?.header?.width).toBe('fill')
    expect((head?.header?.title as Record<string, unknown> | undefined)?.width).toBeUndefined()
    expect(titleOf(parsed, 'card_head'))
      .toMatch(/^\d{2}:\d{2} · 0s · <text_tag color='green'>已完成<\/text_tag>$/)
    expect(titleOf(parsed, 'card_head')).not.toContain('\n')
    expect(head?.header?.icon?.token).toBe('down-small-ccm_outlined')
    expect(head?.header?.icon_position).toBe('right')
    expect(elementOf(parsed, 'head_details')).toBeDefined()
    // The card is wide, like the mockup's 600px stage.
    expect(JSON.stringify(card)).toContain('"wide_screen_mode":true')
    // Details are already embedded in the native panel and need no server callback.
    expect(textOf(parsed, 'head_duration')).toBe('')
    expect(textOf(parsed, 'head_model')).toBe('deepseek-v4-flash')
    expect(textOf(parsed, 'head_input')).toBe('↑35.9k')
    expect(textOf(parsed, 'head_output')).toBe('↓362')
    expect(textOf(parsed, 'head_context')).toBe('35.9k/1m · 4%')
    expect(elementOf(parsed, 'head_details')?.columns?.[1]?.elements?.map(item => item.text?.content))
      .toEqual(['deepseek-v4-flash', '↑35.9k', '↓362', '35.9k/1m · 4%'])
    expect(elementOf(parsed, 'head_details')?.columns?.[1]?.elements?.every(item => item.text?.lines === 1)).toBe(true)
    expect(JSON.stringify(card)).not.toContain('dsh-feishu-channel/head-details')
    // The answer.
    expect(contentOf(parsed, 'main_content')).toBe('答案')
    // The analysis collapse stays one quiet, compact row matching the mockup.
    const collapse = elementOf(parsed, 'analysis_timeline')
    expect(collapse?.header?.title).toEqual({ tag: 'markdown', content: '🔍 **分析过程**' })
    expect(collapse?.header?.icon).toEqual({
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      color: 'grey',
      size: '14px 14px',
    })
    expect(collapse?.header?.icon_position).toBe('right')
    expect(collapse?.header?.icon_expanded_angle).toBe(-180)
    expect(collapse?.header?.title?.content).not.toContain('bash')
    expect((collapse as { border?: unknown }).border).toBeUndefined()
    // One breathing rhythm: the body vertical_spacing spaces every sibling
    // element (answer, divider, toggle); the divider itself carries no margin.
    const divider = elementOf(parsed, 'main_divider')
    expect(divider?.tag).toBe('hr')
    expect(divider?.margin).toBeUndefined()
    expect(collapse?.padding).toBe('0px')
    expect(parsed.body.padding).toBe('0px 16px 14px 16px')
    expect(parsed.body.vertical_spacing).toBe('12px')
    const steps = contentOf(parsed, 'timeline_steps')
    expect(steps).toContain('bash')
    expect(steps).not.toContain('ok')
    expect(steps).not.toContain('$ ls -la')
    expect(steps).toMatch(/^\d{2}:\d{2}:\d{2} /m)
  })

  it('keeps a long model on one small right-aligned line and reachable on tap', () => {
    const model = 'provider/' + 'very-long-model-name-'.repeat(4)
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model } },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, { ...options, footerFields: ['model'] }).card)
    expect(titleOf(parsed, 'card_head')).not.toContain(model)
    expect(textOf(parsed, 'head_model')).toBe(model)
    expect(elementOf(parsed, 'head_model')?.text?.lines).toBe(1)
  })

  it('places a model label in plain text without markdown interpretation', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model: 'x<y' } },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, { ...options, footerFields: ['model'] }).card)
    expect(titleOf(parsed, 'card_head')).not.toContain('x<y')
    expect(textOf(parsed, 'head_model')).toBe('x<y')
  })

  it('keeps ctx as the final settled field when context capacity is unavailable', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }] },
      usage: { inputTokens: 92, outputTokens: 418 },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, { ...options, footerFields: ['duration'] }).card)
    expect(titleOf(parsed, 'card_head')).toContain('0s')
    expect(textOf(parsed, 'head_context')).toBe('92/— · 0%')
  })

  it('falls back to duration when configured head fields are unknown', () => {
    const s = new TurnView(1)
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, { ...options, footerFields: ['unknown'] }).card)
    expect(titleOf(parsed, 'card_head')).toMatch(/已完成<\/text_tag>$/)
    expect(titleOf(parsed, 'card_head')).toContain('0s')
  })

  it('keeps the terminal status time stable when details are opened later', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2024, 0, 2, 20, 13, 0))
      const s = new TurnView(1)
      s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      expect(titleOf(parse(renderCard(s, options).card), 'card_head')).toContain('20:13')

      vi.setSystemTime(new Date(2024, 0, 2, 20, 43, 0))
      const later = parse(renderCard(s, options).card)
      expect(titleOf(later, 'card_head')).toContain('20:13')
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits long answers across markdown elements', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      source: { kind: 'model', model: 'deepseek-v4-flash' },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const { card } = renderCard(s, options)
    const json = JSON.stringify(card)
    expect(json.match(/main_content_/g)?.length ?? 0).toBeGreaterThan(0)
  })

  it('renders inline code as plain text while preserving fenced code blocks', () => {
    const fence = '```'
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: {
        content: [{
          type: 'text',
          text: '使用 `nexus-fi-mcp`。\n\n' + fence + 'yaml\ncommand: `literal`\n' + fence,
        }],
      },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, options).card)
    const content = contentOf(parsed, 'main_content')
    expect(content).toContain('使用 nexus-fi-mcp。')
    expect(content).not.toContain('`nexus-fi-mcp`')
    // The fenced block is a structural block of its own element now.
    expect(contentOf(parsed, 'main_content_1')).toContain(fence + 'yaml\ncommand: `literal`\n' + fence)
  })

  it('renders compact consecutive numbered items as a real ordered list', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: {
        content: [{
          type: 'text',
          text: '**通用工程**\n11. `api-and-interface-design`、12. `code-review-and-quality`、13. `code-simplification`',
        }],
      },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const content = contentOf(parse(renderCard(s, options).card), 'main_content')
    expect(content).toContain('11. api-and-interface-design\n12. code-review-and-quality\n13. code-simplification')
    expect(content).not.toContain('、12.')
  })

  it('unwraps a numbered inventory fence so Feishu does not add duplicate line numbers', () => {
    const fence = '```'
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: {
        content: [{
          type: 'text',
          text: '## 逐条清点\n\n' + fence + '\n'
            + '1  api-and-interface-design      3 code-review-and-quality\n'
            + '2  browser-testing-with-devtools 4 code-simplification\n'
            + fence,
        }],
      },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const content = contentOf(parse(renderCard(s, options).card), 'main_content')
    expect(content).toContain('1. api-and-interface-design\n2. browser-testing-with-devtools')
    expect(content).toContain('3. code-review-and-quality\n4. code-simplification')
    expect(content).not.toContain(fence)
  })

  it('renders the quiet loading panel with a live instrument subtitle', () => {
    const s = new TurnView(1)
    const { card } = renderCard(s, options)
    const parsed = parse(card)
    expect(titleOf(parsed, 'card_head'))
      .toMatch(/^\d{2}:\d{2} · 0s · <text_tag color='neutral'>处理中<\/text_tag>$/)
    expect(textOf(parsed, 'head_context')).toBe('—/— · 0%')
    expect(contentOf(parsed, 'main_content')).toContain('**正在分析**')
    expect(elementOf(parsed, 'loading_skeleton')).toBeDefined()
    expect(JSON.stringify(spinnerFrame(0))).toBe('"⠋"')
  })

  it('keeps partial model text behind the loading panel until the turn settles', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '未完成答案' } }))
    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'main_content')).toContain('正在分析')
    expect(JSON.stringify(parsed)).not.toContain('未完成答案')
  })

  it('does not repeat the quoted request in the loading title', () => {
    const s = new TurnView(1)
    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'main_content')).toContain('**正在分析**')
    expect(contentOf(parsed, 'main_content')).not.toContain('/api/orders')
  })

  it('shows live steps in mockup order: stamp, glyph, label', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    const parsed = parse(renderCard(s, options).card)
    expect(titleOf(parsed, 'card_head')).toContain('处理中')
    expect(titleOf(parsed, 'card_head')).toContain('处理中')
    const steps = contentOf(parsed, 'live_steps')
    expect(steps).toContain('**bash**')
    expect(steps).toContain('下一步 · 生成回复')
    expect(steps).toMatch(/^\d{2}:\d{2}:\d{2} /m)
  })

  it('stops a completed loading step at the tool title', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', {
      turn: 1,
      callId: 'c1',
      name: 'Call Feishu token and command APIs via node',
      arguments: '{}',
    }))
    s.observe(event('tool/result', {
      turn: 1,
      message: {
        content: [{
          type: 'text',
          toolCallId: 'c1',
          content: [{
            type: 'text',
            text: '=== 从 settings.yaml 提取的凭据（脱敏显示） ===\n=== 用 node 直接调 token 接口 ===\ndone',
          }],
        }],
      },
    }))
    const steps = contentOf(parse(renderCard(s, options).card), 'live_steps')
    expect(steps).toMatch(
      /^\d{2}:\d{2}:\d{2} <font color="green">✓<\/font> \*\*Call Feishu token and command APIs via node\*\*$/m,
    )
    expect(steps).not.toContain('settings.yaml')
    expect(steps).not.toContain('token 接口')
    expect(steps).not.toContain('done')
  })

  it('labels steps with the presenter title when one is available', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"grep 5xx"}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: '1,284 条' }] }] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const presented = { ...options, presentCall: (name: string, args: string) => {
      expect(name).toBe('bash')
      expect(JSON.parse(args).command).toBe('grep 5xx')
      return { title: '拉取 5xx 调用日志' }
    } }
    const parsed = parse(renderCard(s, presented).card)
    const collapse = elementOf(parsed, 'analysis_timeline')
    expect(collapse?.header?.title?.content).toBe('🔍 **分析过程**')
    expect(contentOf(parsed, 'timeline_steps')).toContain('拉取 5xx 调用日志')
  })

  it('adds token flow to the instrument line once usage is reported', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"x"}' }))
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '部分答案' }], source: { kind: 'model', model: 'deepseek-v4-flash' } },
      usage: { inputTokens: 1200, outputTokens: 600 },
    }))
    const parsed = parse(renderCard(s, options).card)
    expect(textOf(parsed, 'head_input')).toBe('↑1.2k')
    expect(textOf(parsed, 'head_output')).toBe('↓600')
  })

  it('shows a cost row when the turn model has a configured price', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model: 'deepseek-v4-flash' } },
      usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    }))
    const parsed = parse(renderCard(s, {
      ...options,
      footerFields: ['duration', 'model', 'input_tokens', 'output_tokens', 'cost', 'context'],
      pricing: { 'deepseek-v4-flash': { input: 4, output: 16 } },
    }).card)
    expect(textOf(parsed, 'head_cost')).toBe('¥24.00')
    // Rows follow the requested field order; cost sits beside the token rows.
    const details = elementOf(parsed, 'head_details')
    const labels = (details?.columns?.[0]?.elements ?? []).map(element => element.text?.content ?? '')
    expect(labels).toEqual(['模型', '输入 Token', '输出 Token', '费用', 'ctx'])
  })

  it('omits the cost row when pricing is absent or the model is unpriced', () => {
    const observeUsage = (s: TurnView): void => {
      s.observe(event('assistant/message', {
        turn: 1,
        message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 1200, outputTokens: 600 },
      }))
    }
    const withoutPricing = new TurnView(1)
    observeUsage(withoutPricing)
    expect(elementOf(parse(renderCard(withoutPricing, options).card), 'head_cost')).toBeUndefined()

    const unpricedModel = new TurnView(1)
    observeUsage(unpricedModel)
    const parsed = parse(renderCard(unpricedModel, {
      ...options,
      footerFields: ['duration', 'model', 'input_tokens', 'output_tokens', 'cost', 'context'],
      pricing: { 'other-model': { input: 4, output: 16 } },
    }).card)
    expect(elementOf(parsed, 'head_cost')).toBeUndefined()
    expect(JSON.stringify(parsed)).not.toContain('费用')
  })

  it('marks the cost row with 空闲 when the usage lands off-peak', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: '答案' }], source: { kind: 'model', model: 'deepseek-v4-flash' } },
      usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    }))
    // Two complementary windows cover every wall clock, so the assertion does
    // not depend on when the test runs.
    const parsed = parse(renderCard(s, {
      ...options,
      footerFields: ['duration', 'model', 'input_tokens', 'output_tokens', 'cost', 'context'],
      pricing: { 'deepseek-v4-flash': { input: 3, output: 9, offPeak: { input: 1.5, output: 4.5 } } },
      offPeakWindows: [{ start: '00:00', end: '12:00' }, { start: '12:00', end: '00:00' }],
    }).card)
    // 2M×1.5 + 1M×4.5 → half of the ¥15.00 peak price.
    expect(textOf(parsed, 'head_cost')).toBe('¥7.50 ·空闲')
  })

  it('renders a failed card: red pill, tinted error box, and JSON 2.0 buttons', () => {
    const s = new TurnView(1)
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'READ_TIMEOUT', message: 'boom' } } }))
    const parsed = parse(renderCard(s, options).card)
    expect(titleOf(parsed, 'card_head'))
      .toMatch(/^\d{2}:\d{2} · 0s · <text_tag color='red'>失败<\/text_tag>$/)
    expect(contentOf(parsed, 'failure_title')).toBe('**分析失败：boom**')
    expect(elementOf(parsed, 'failure_error_box')?.background_style).toBe('red')
    const box = contentOf(parsed, 'failure_error')
    expect(box).toContain('READ_TIMEOUT')
    expect(box).toContain('boom')
    expect(box).toContain('last attempt')
    const actions = elementOf(parsed, 'failure_actions')
    expect(actions?.tag).toBe('column_set')
    // Deterministic side-by-side pair: the mobile client ignores 'stretch'
    // (measured 2026-08-21), so the layout contract is 'none' everywhere.
    expect(actions?.flex_mode).toBe('none')
    const actionsJson = JSON.stringify(actions)
    expect(actionsJson).toContain('重试')
    expect(actionsJson).toContain(RETRY_ACTION)
    expect(actionsJson).toContain('复制错误')
    expect(actionsJson).toContain(COPY_ERROR_ACTION)
    expect(actionsJson).toContain('READ_TIMEOUT · boom')
    expect(actionsJson).toContain('"type":"callback"')
    expect(JSON.stringify(parsed)).not.toContain('"tag":"action"')
  })

  it('keeps a partial answer above the failure panel', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: '部分结论' } }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } }))
    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'main_content')).toBe('部分结论')
    expect(contentOf(parsed, 'failure_title')).toContain('分析失败')
    expect(elementOf(parsed, 'main_divider')).toBeDefined()
  })

  it('collapses the failure title reason to one short line', () => {
    const s = new TurnView(1)
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'y'.repeat(300) } } }))
    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'failure_title')).toContain('…')
  })

  it('folds old timeline entries without adding a phase chain to the toggle row', () => {
    const s = new TurnView(1)
    for (let i = 0; i < 5; i += 1) {
      s.observe(event('tool/call', { turn: 1, callId: 'c' + i, name: 'tool' + i, arguments: '{}' }))
      s.observe(event('tool/result', {
        turn: 1,
        message: { content: [{ type: 'text', toolCallId: 'c' + i, content: [{ type: 'text', text: 'r' + i }] }] },
      }))
    }
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const folded = parse(renderCard(s, { ...options, maxTimelineItems: 2 }).card)
    const title = elementOf(folded, 'analysis_timeline')?.header?.title?.content ?? ''
    expect(title).toBe('🔍 **分析过程**')
    expect(contentOf(folded, 'timeline_folded')).toContain('已折叠 3 条')
  })

  it('freezes the same process rows in timestamp order without raw content', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'later', arguments: '{}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: '后执行\n' + '详情'.repeat(100) }] }] },
    }))
    s.observe(event('tool/call', { turn: 1, callId: 'c2', name: 'earlier', arguments: '{}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c2', content: [{ type: 'text', text: '先执行' }] }] },
      }))
    s.observe(event('assistant/message', {
      turn: 1,
      step: 3,
      message: { content: [{ type: 'reasoning', text: 'The user asked me to expose a very long internal reasoning trace.' }] },
    }))
    for (const entry of s.steps) {
      if (entry.kind !== 'tool') continue
      entry.atMs = new Date(2024, 0, 2, entry.name === 'earlier' ? 14 : 15, 37).getTime()
    }
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, options).card)
    expect(elementOf(parsed, 'analysis_timeline')?.header?.title?.content)
      .toBe('🔍 **分析过程**')
    const rows = contentOf(parsed, 'timeline_steps').split('\n').filter(Boolean)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('14:37:00')
    expect(rows[0]).toContain('earlier')
    expect(rows[1]).toContain('15:37:00')
    expect(rows[1]).toContain('later')
    expect(rows[2]).toContain('思考')
    expect(rows.join('\n')).not.toContain('详情')
    expect(rows.join('\n')).not.toContain('The user')
    expect(rows.join('\n')).not.toContain('…')
  })

  it('keeps the analysis toggle when the turn has reasoning but no tools', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [
        { type: 'reasoning', text: 'internal reasoning' },
        { type: 'text', text: '答案' },
      ] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const parsed = parse(renderCard(s, options).card)
    expect(elementOf(parsed, 'analysis_timeline')?.header?.title?.content)
      .toBe('🔍 **分析过程**')
    expect(contentOf(parsed, 'timeline_steps')).toContain('思考')
    expect(contentOf(parsed, 'timeline_steps')).not.toContain('internal reasoning')
    expect(elementOf(parsed, 'timeline_empty')).toBeUndefined()
    expect(elementOf(parsed, 'main_divider')?.margin).toBeUndefined()
  })

  it('keeps live process rows unchanged when the completed card collapses them', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'raw' }] }] },
    }))
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '答案' }] },
    }))

    const live = contentOf(parse(renderCard(s, options).card), 'live_steps')
      .split('\n')
      .filter(line => !line.includes('下一步'))
      .join('\n')
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const settled = contentOf(parse(renderCard(s, options).card), 'timeline_steps')

    expect(settled).toBe(live)
    expect(settled).not.toContain('raw')
    expect(settled).not.toContain('private')
  })

  it('promotes an explicit final conclusion and folds earlier evidence', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: [
        '先说明检查过程。',
        '',
        '## 铁证：日志与源码',
        '',
        '这里是较长的证据和排查过程。',
        '',
        '## 最终结论（已核实）',
        '',
        '| 关键事实 | 值 |',
        '| --- | --- |',
        '| 工具数 | 4 |',
        '| MCP 配置 | 无 |',
        '| Nexus 来源 | 会话文字 |',
        '| 检查层级 | 日志 |',
        '',
        '没有连接任何 MCP server。',
      ].join('\n') }] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'answer_title')).toContain('最终结论（已核实）')
    // The leading key-fact table stays in the body and renders as a markdown
    // table (one header column, one content column) — not a 2×2 grid. The
    // structural split gives the table its own element and the follow-up
    // paragraph its own, so the body spacing breathes between them.
    expect(contentOf(parsed, 'main_content')).toContain('| 关键事实 | 值 |')
    expect(contentOf(parsed, 'main_content')).toContain('| 工具数 | 4 |')
    expect(contentOf(parsed, 'main_content')).toContain('| 检查层级 | 日志 |')
    expect(elementOf(parsed, 'answer_metrics')).toBeUndefined()
    const bodyText = bodyTextOf(parsed)
    expect(bodyText).toContain('没有连接任何 MCP server')
    expect(bodyText).not.toContain('铁证')
    expect(elementOf(parsed, 'answer_details')?.header?.title?.content).toContain('详细说明')
    expect(contentOf(parsed, 'answer_details_text')).toContain('铁证：日志与源码')
  })

  it('drops the process panels when showProcess is off', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    const parsed = parse(renderCard(s, { ...options, showProcess: false }).card)
    expect(elementOf(parsed, 'live_steps')).toBeUndefined()
    expect(elementOf(parsed, 'analysis_timeline')).toBeUndefined()
  })

  it('uses only Card JSON 2.0-compatible tags and element ids', () => {
    const loading = new TurnView(1)
    loading.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    const completed = new TurnView(2)
    completed.observe(event('tool/call', { turn: 2, callId: 'c2', name: 'bash', arguments: '{}' }))
    completed.observe(event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    const failed = new TurnView(3)
    failed.observe(event('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } }))

    for (const session of [loading, completed, failed]) {
      const card = renderCard(session, options).card
      const ids: string[] = []
      const tags: string[] = []
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit)
          return
        }
        if (typeof value !== 'object' || value === null) return
        const record = value as Record<string, unknown>
        if (typeof record.element_id === 'string') ids.push(record.element_id)
        if (typeof record.tag === 'string') tags.push(record.tag)
        Object.values(record).forEach(visit)
      }
      visit(card)
      expect(tags).not.toContain('action')
      expect(ids.every(id => /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(id))).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('falls back to a handoff card when limits are exceeded', () => {
    const s = new TurnView(1)
    s.observe(event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'x'.repeat(50_000) }] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const { card, disposition, limitReason } = renderCard(s, options)
    expect(disposition).toBe('native')
    expect(limitReason).toBe('json_bytes')
    expect(card).not.toHaveProperty('header')
    expect(JSON.stringify(card)).toContain("<text_tag color='green'>已完成</text_tag>")
  })
})

describe('formatDuration', () => {
  it('formats seconds compactly', () => {
    expect(formatDuration(5)).toBe('5s')
    expect(formatDuration(65)).toBe('1m5s')
    expect(formatDuration(3661)).toBe('1h1m1s')
    expect(formatDuration(-3)).toBe('0s')
  })
})

describe('formatCount', () => {
  it('formats k and m', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1500)).toBe('1.5k')
    expect(formatCount(2_000_000)).toBe('2m')
  })
})

describe('formatClock', () => {
  it('matches the compact settled duration while live', () => {
    expect(formatClock(2_000)).toBe('2s')
    expect(formatClock(65_000)).toBe('1m5s')
    expect(formatClock(3_661_000)).toBe('1h1m1s')
    expect(formatClock(-5)).toBe('0s')
  })
})

describe('formatWallClock / formatStepTime', () => {
  it('stamps local wall-clock time', () => {
    const local = new Date(2024, 0, 2, 14, 41, 5).getTime()
    expect(formatWallClock(local)).toBe('14:41')
    expect(formatStepTime(local)).toBe('14:41:05')
  })
})

describe('spinnerFrameIndex', () => {
  it('advances the frame by elapsed time', () => {
    expect(spinnerFrameIndex(0)).toBe(0)
    expect(spinnerFrameIndex(119)).toBe(0)
    expect(spinnerFrameIndex(120)).toBe(1)
    expect(spinnerFrameIndex(240)).toBe(2)
  })
})

describe('tool transcript', () => {
  it('keeps a running tool on the live steps line as a spinner row', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"make test"}' }))
    const parsed = parse(renderCard(s, options).card)
    expect(contentOf(parsed, 'live_steps')).toContain('**bash**')
    expect(contentOf(parsed, 'live_steps')).not.toContain('$ make test')
  })

  it('never exposes raw tool results inside the completed timeline', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'token=abc123' }] }] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const json = JSON.stringify(renderCard(s, options).card)
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('[REDACTED]')
  })

  it('does not append long tool details or an ellipsis to the action summary', () => {
    const s = new TurnView(1)
    s.observe(event('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' }))
    s.observe(event('tool/result', {
      turn: 1,
      message: { content: [{ type: 'text', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(2000) }] }] },
    }))
    s.observe(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const parsed = parse(renderCard(s, options).card)
    expect(JSON.stringify(parsed)).not.toContain('y'.repeat(40))
    expect(contentOf(parsed, 'timeline_steps')).toMatch(/^\d{2}:\d{2}:\d{2} .*\*\*bash\*\*$/)
  })
})

describe('card action values', () => {
  it('recognizes the retry payload only', () => {
    expect(isRetryAction({ kind: RETRY_ACTION })).toBe(true)
    expect(isRetryAction({ kind: 'other' })).toBe(false)
    expect(isRetryAction(null)).toBe(false)
    expect(isRetryAction('retry')).toBe(false)
  })

  it('recognizes the copy-error payload only', () => {
    expect(isCopyErrorAction({ kind: COPY_ERROR_ACTION, text: 'boom' })).toBe(true)
    expect(isCopyErrorAction({ kind: COPY_ERROR_ACTION })).toBe(false)
    expect(isCopyErrorAction({ kind: 'other', text: 'boom' })).toBe(false)
    expect(isCopyErrorAction(null)).toBe(false)
  })
})
