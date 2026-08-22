/**
 * Turn-cost estimation from the configured per-model price table, including
 * DeepSeek-style time-differentiated (peak/off-peak) billing.
 * @module dsh-feishu-channel/presentation/cost
 */

import type { ModelPricing, TimeWindow } from '../config.ts'
import type { TurnTokenUsage } from './turn-view.ts'

/** Suffix marking a row billed at the off-peak rates. */
const OFF_PEAK_MARK = ' ·空闲'

/**
 * Render the 费用 disclosure-row value for one turn: reported usage times the
 * configured per-million-token prices of the turn's model. When the model has
 * `offPeak` rates and `atMs` falls inside one of the Beijing-time windows, the
 * discounted rates apply and the row gains an 空闲 marker. An empty string
 * means "no price covers this model" (or no usage yet), which the meta
 * renderer omits — an absent row, never a blank one.
 */
export function estimateCost(
  usage: TurnTokenUsage | undefined,
  pricing: Readonly<Record<string, ModelPricing>> | undefined,
  model: string,
  atMs: number | undefined,
  windows: readonly TimeWindow[] | undefined,
): string {
  const price = lookupPrice(pricing, model)
  if (usage === undefined || price === undefined) return ''
  const { offPeak: discount } = price
  const discounted = discount !== undefined && atMs !== undefined && inOffPeak(atMs, windows)
  return formatAmount(price.currency ?? '¥', amount(usage, discounted ? discount : price))
    + (discounted ? OFF_PEAK_MARK : '')
}

/** Whether `atMs` falls inside any half-open Beijing-time window. */
export function inOffPeak(atMs: number, windows: readonly TimeWindow[] | undefined): boolean {
  if (windows === undefined || windows.length === 0) return false
  const minutes = beijingMinutesOfDay(atMs)
  return windows.some(window => insideWindow(minutes, window))
}

function insideWindow(minutes: number, window: TimeWindow): boolean {
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  // Malformed or zero-length bounds match nothing; resolveConfig rejects them.
  if (start === undefined || end === undefined || start === end) return false
  // An end earlier than the start wraps past midnight.
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** Wall-clock minutes since midnight in Beijing (UTC+8), host timezone aside. */
function beijingMinutesOfDay(atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(atMs))
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  const minute = Number(parts.find(part => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return -1
  return hour * 60 + minute
}

/** Exact model-id match first, then the segment after the last route slash. */
function lookupPrice(
  pricing: Readonly<Record<string, ModelPricing>> | undefined,
  model: string,
): ModelPricing | undefined {
  const id = model.trim()
  if (id === '' || pricing === undefined) return undefined
  return pricing[id] ?? pricing[id.split('/').pop() ?? '']
}

function amount(
  usage: TurnTokenUsage,
  rates: { readonly input: number; readonly output: number; readonly cacheHitInput?: number },
): number {
  // The host's inputTokens exclude cache reads, so the hit portion bills at
  // its own rate; unpriced hit rates fall back to the miss rate (overestimate).
  const hit = usage.cacheReadTokens ?? 0
  const hitRate = rates.cacheHitInput ?? rates.input
  return (
    usage.inputTokens * rates.input
    + hit * hitRate
    + usage.outputTokens * rates.output
  ) / 1_000_000
}

/** Two decimals from one unit up; up to four significant decimals below. */
function formatAmount(currency: string, value: number): string {
  if (value >= 1) return currency + value.toFixed(2)
  const rounded = Number(value.toFixed(4))
  if (value > 0 && rounded === 0) return currency + '<0.0001'
  return currency + String(rounded)
}
