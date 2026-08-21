/** Exact Feishu card serialization and capacity inspection. */

import { countMarkdownTables } from './markdown.ts'

/** Fixed platform and safety limits. */
export const FEISHU_MAX_TABLES = 5
export const FEISHU_MAX_ELEMENTS = 200
export const SAFE_CARD_JSON_BYTES = 28_000

export type CardBudgetViolation = 'unserializable' | 'json_bytes' | 'elements' | 'tables'

/** Complete card budget verdict. */
export interface CardBudgetInspection {
  readonly jsonBytes: number
  readonly elementCount: number
  readonly tableCount: number
  readonly violations: readonly CardBudgetViolation[]
  readonly safe: boolean
  readonly primaryReason: CardBudgetViolation | ''
  readonly serializationError: string
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Serialize and inspect a card through one JSON traversal. Unsupported or
 * circular values are replaced only inside the temporary serialization and
 * always make the verdict unsafe.
 */
export function inspectCardBudget(card: unknown): CardBudgetInspection {
  let elementCount = 0
  let tableCount = 0
  let serializationError = ''
  const ancestors: object[] = []

  const reject = (reason: string): null => {
    if (serializationError === '') serializationError = reason
    return null
  }

  let serialized = ''
  try {
    serialized = JSON.stringify(card, function (this: object, _key, value: unknown): unknown {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()

      if (value === undefined) return reject('undefined_value')
      if (typeof value === 'bigint') return reject('bigint_value')
      if (typeof value === 'function') return reject('function_value')
      if (typeof value === 'symbol') return reject('symbol_value')
      if (typeof value === 'number' && !Number.isFinite(value)) return reject('non_finite_number')
      if (typeof value !== 'object' || value === null) return value

      if (ancestors.includes(value)) return reject('circular_reference')
      if (!Array.isArray(value) && !isPlainObject(value)) return reject('unsupported_object')
      ancestors.push(value)

      if (!Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (typeof record.tag === 'string') {
          elementCount += 1
          if (record.tag === 'table') {
            tableCount += 1
          } else if (record.tag === 'markdown' && typeof record.content === 'string') {
            tableCount += countMarkdownTables(record.content)
          }
        }
      }
      return value
    }) ?? ''
  } catch (error) {
    serializationError = serializationError || (error instanceof Error ? error.message : String(error))
  }

  const jsonBytes = Buffer.byteLength(serialized, 'utf8')
  const checks: readonly [violated: boolean, reason: CardBudgetViolation][] = [
    [serializationError !== '', 'unserializable'],
    [jsonBytes > SAFE_CARD_JSON_BYTES, 'json_bytes'],
    [elementCount > FEISHU_MAX_ELEMENTS, 'elements'],
    [tableCount > FEISHU_MAX_TABLES, 'tables'],
  ]
  const violations = checks.filter(([violated]) => violated).map(([, reason]) => reason)
  return {
    jsonBytes,
    elementCount,
    tableCount,
    violations,
    safe: violations.length === 0,
    primaryReason: violations[0] ?? '',
    serializationError,
  }
}
