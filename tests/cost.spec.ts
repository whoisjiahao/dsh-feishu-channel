import { describe, expect, it } from 'vitest'
import { estimateCost, inOffPeak } from '../src/presentation/cost.ts'
import type { ModelPricing, TimeWindow } from '../src/config.ts'

const PRICES: Record<string, ModelPricing> = {
  'deepseek-v4-flash': { input: 4, output: 16 },
  'usd-model': { currency: '$', input: 2, output: 8 },
}

/** UTC instants whose Beijing wall clock (UTC+8) is easy to reason about. */
const BEIJING = (utc: string): number => Date.parse(utc + 'Z')

describe('estimateCost', () => {
  it('returns empty without usage, pricing, or a matching model', () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    expect(estimateCost(undefined, PRICES, 'deepseek-v4-flash', undefined, undefined)).toBe('')
    expect(estimateCost(usage, undefined, 'deepseek-v4-flash', undefined, undefined)).toBe('')
    expect(estimateCost(usage, {}, 'deepseek-v4-flash', undefined, undefined)).toBe('')
    expect(estimateCost(usage, PRICES, '', undefined, undefined)).toBe('')
    expect(estimateCost(usage, PRICES, 'unknown-model', undefined, undefined)).toBe('')
  })

  it('prices input and output per million tokens', () => {
    // 35_900×4 + 362×16 = 149_392 / 1M → ¥0.1494
    expect(estimateCost({ inputTokens: 35_900, outputTokens: 362 }, PRICES, 'deepseek-v4-flash', undefined, undefined))
      .toBe('¥0.1494')
    // 2M×4 + 1M×16 → whole-unit amounts keep two decimals.
    expect(estimateCost(
      { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      PRICES,
      'deepseek-v4-flash',
      undefined,
      undefined,
    )).toBe('¥24.00')
  })

  it('honours the configured currency symbol', () => {
    expect(estimateCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      PRICES,
      'usd-model',
      undefined,
      undefined,
    )).toBe('$2.00')
  })

  it('trims trailing zeros on sub-unit amounts', () => {
    // 100_000×4 + 0×16 = 0.4 → "¥0.4", not "¥0.4000"
    expect(estimateCost(
      { inputTokens: 100_000, outputTokens: 0 },
      PRICES,
      'deepseek-v4-flash',
      undefined,
      undefined,
    )).toBe('¥0.4')
  })

  it('keeps tiny non-zero amounts visible', () => {
    // 100×4 + 0 = 0.0004 survives rounding; 1×4 = 0.000004 rounds to zero.
    expect(estimateCost({ inputTokens: 100, outputTokens: 0 }, PRICES, 'deepseek-v4-flash', undefined, undefined))
      .toBe('¥0.0004')
    expect(estimateCost({ inputTokens: 1, outputTokens: 0 }, PRICES, 'deepseek-v4-flash', undefined, undefined))
      .toBe('¥<0.0001')
  })

  it('falls back to the model id after the last route slash', () => {
    expect(estimateCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      PRICES,
      'deepseek/deepseek-v4-flash',
      undefined,
      undefined,
    )).toBe('¥4.00')
  })
})

describe('inOffPeak', () => {
  const windows: TimeWindow[] = [
    { start: '12:00', end: '14:00' },
    { start: '18:00', end: '09:00' },
  ]

  it('matches the midday window in Beijing time regardless of host timezone', () => {
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), windows)).toBe(true) // 12:00 +8
    expect(inOffPeak(BEIJING('2026-01-15T05:59:00'), windows)).toBe(true) // 13:59 +8
    expect(inOffPeak(BEIJING('2026-01-15T02:00:00'), windows)).toBe(false) // 10:00 +8
  })

  it('matches the overnight window across midnight', () => {
    expect(inOffPeak(BEIJING('2026-01-14T18:00:00'), windows)).toBe(true) // 02:00 +8 next day
    expect(inOffPeak(BEIJING('2026-01-15T16:00:00'), windows)).toBe(true) // 00:00 +8
    expect(inOffPeak(BEIJING('2026-01-15T01:00:00'), windows)).toBe(false) // 09:00 +8, exclusive end
  })

  it('treats window bounds as half-open', () => {
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), windows)).toBe(true) // 12:00 inclusive
    expect(inOffPeak(BEIJING('2026-01-15T06:00:00'), windows)).toBe(false) // 14:00 exclusive
    expect(inOffPeak(BEIJING('2026-01-15T10:00:00'), windows)).toBe(true) // 18:00 inclusive
  })

  it('matches nothing without windows or with malformed bounds', () => {
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), undefined)).toBe(false)
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), [])).toBe(false)
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), [{ start: '12:00', end: '12:00' }])).toBe(false)
    expect(inOffPeak(BEIJING('2026-01-15T04:00:00'), [{ start: '25:00', end: '26:00' }])).toBe(false)
  })
})

describe('estimateCost off-peak rates', () => {
  // DeepSeek-style: peak ¥3/¥9, off-peak half — 空闲时段价格为高峰的一半.
  const PEAKED: Record<string, ModelPricing> = {
    'deepseek-v4-flash': { input: 3, output: 9, offPeak: { input: 1.5, output: 4.5 } },
  }
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  const windows: TimeWindow[] = [{ start: '12:00', end: '14:00' }]

  it('bills off-peak rates with the 空闲 marker inside the window', () => {
    expect(estimateCost(usage, PEAKED, 'deepseek-v4-flash', BEIJING('2026-01-15T04:30:00'), [windows[0]!]))
      .toBe('¥6.00 ·空闲')
  })

  it('bills standard rates outside the window, without the marker', () => {
    expect(estimateCost(usage, PEAKED, 'deepseek-v4-flash', BEIJING('2026-01-15T02:00:00'), [windows[0]!]))
      .toBe('¥12.00')
  })

  it('ignores off-peak rates when windows are disabled or absent', () => {
    expect(estimateCost(usage, PEAKED, 'deepseek-v4-flash', BEIJING('2026-01-15T04:30:00'), [])).toBe('¥12.00')
    expect(estimateCost(usage, PEAKED, 'deepseek-v4-flash', BEIJING('2026-01-15T04:30:00'), undefined))
      .toBe('¥12.00')
  })

  it('never applies off-peak rates the model does not declare', () => {
    expect(estimateCost(usage, PRICES, 'deepseek-v4-flash', BEIJING('2026-01-15T04:30:00'), [windows[0]!]))
      .toBe('¥20.00')
  })

  it('splits cache-hit input onto its own rate', () => {
    const CACHED: Record<string, ModelPricing> = {
      m: { input: 3, output: 9, cacheHitInput: 0.3, offPeak: { input: 1.5, output: 4.5, cacheHitInput: 0.15 } },
    }
    // Peak: 1M miss ×3 + 2M hit ×0.3 + 1M out ×9 → ¥12.60
    const cachedUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 2_000_000 }
    expect(estimateCost(cachedUsage, CACHED, 'm', undefined, undefined)).toBe('¥12.60')
    // Off-peak halves every rate: 1×1.5 + 2×0.15 + 1×4.5 → ¥6.30
    expect(estimateCost(cachedUsage, CACHED, 'm', BEIJING('2026-01-15T04:30:00'), [{ start: '12:00', end: '14:00' }]))
      .toBe('¥6.30 ·空闲')
  })

  it('bills unpriced cache hits at the miss rate instead of undercounting', () => {
    const cachedUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }
    expect(estimateCost(cachedUsage, PRICES, 'usd-model', undefined, undefined)).toBe('$4.00')
  })
})
