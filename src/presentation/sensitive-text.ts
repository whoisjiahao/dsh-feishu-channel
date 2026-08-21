/** Redacts credential values before untrusted operational text reaches a card. */

const REDACTED = '[REDACTED]'
const DEFAULT_MAX_CHARS = 600

interface Assignment {
  readonly key: string
  readonly valueStart: number
}

function canonicalKey(key: string): string {
  return key
    .replace(/^--?/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function isSensitiveKey(key: string): boolean {
  const canonical = canonicalKey(key)
  const parts = canonical.split('_').filter(Boolean)
  const last = parts.at(-1)
  if (last === undefined) return false
  if (['token', 'secret', 'password', 'passwd', 'credential', 'credentials'].includes(last)) return true
  if (['authorization', 'proxy_authorization', 'cookie', 'set_cookie'].includes(canonical)) return true
  if (last === 'key' && ['api', 'access', 'private', 'secret'].includes(parts.at(-2) ?? '')) return true
  return canonical.endsWith('access_key_id') || canonical.endsWith('password_hash')
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? REDACTED : redactJson(item),
  ]))
}

function structuredJson(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.stringify(redactJson(JSON.parse(trimmed)))
  } catch {
    return undefined
  }
}

function isKeyCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_.-]/.test(character)
}

function assignmentAt(text: string, start: number): Assignment | undefined {
  if (start > 0 && isKeyCharacter(text[start - 1])) return undefined
  let cursor = start
  let cliOption = false
  if (text.startsWith('--', cursor)) {
    cliOption = true
    cursor += 2
  }

  const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : undefined
  if (quote !== undefined) cursor += 1
  const keyStart = cursor
  while (isKeyCharacter(text[cursor])) cursor += 1
  if (cursor === keyStart) return undefined
  const key = text.slice(keyStart, cursor)
  if (quote !== undefined) {
    if (text[cursor] !== quote) return undefined
    cursor += 1
  }

  const whitespaceStart = cursor
  while (/\s/.test(text[cursor] ?? '')) cursor += 1
  if (text[cursor] === ':' || text[cursor] === '=') {
    cursor += 1
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    return { key, valueStart: cursor }
  }
  if (cliOption && cursor > whitespaceStart) return { key, valueStart: cursor }
  return undefined
}

function quotedValueEnd(text: string, start: number, quote: string): number {
  let cursor = start + 1
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (text[cursor] === quote) return cursor + 1
    cursor += 1
  }
  return text.length
}

function unquotedValueEnd(text: string, start: number, key: string, wrapperQuote: string | undefined): number {
  if (wrapperQuote !== undefined) {
    const closing = text.indexOf(wrapperQuote, start)
    return closing < 0 ? text.length : closing
  }
  if (['authorization', 'proxy_authorization'].includes(canonicalKey(key))) {
    const credential = /^(?:Bearer|Basic)\s+\S+/i.exec(text.slice(start))
    if (credential !== null) return start + credential[0].length
  }
  let cursor = start
  while (cursor < text.length && !/[\s,;&}]/.test(text[cursor]!)) cursor += 1
  return cursor
}

function redactAssignments(text: string): string {
  let output = ''
  let copiedUntil = 0
  let cursor = 0
  while (cursor < text.length) {
    const assignment = assignmentAt(text, cursor)
    if (assignment === undefined || !isSensitiveKey(assignment.key)) {
      cursor += 1
      continue
    }

    const valueStart = assignment.valueStart
    if (valueStart >= text.length) {
      cursor += 1
      continue
    }
    const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : undefined
    const wrapper = quote === undefined && (text[cursor - 1] === '"' || text[cursor - 1] === "'")
      ? text[cursor - 1]
      : undefined
    const valueEnd = quote === undefined
      ? unquotedValueEnd(text, valueStart, assignment.key, wrapper)
      : quotedValueEnd(text, valueStart, quote)
    if (valueEnd === valueStart) {
      cursor += 1
      continue
    }

    output += text.slice(copiedUntil, valueStart)
    output += quote === undefined ? REDACTED : quote + REDACTED + quote
    copiedUntil = valueEnd
    cursor = valueEnd
  }
  return output + text.slice(copiedUntil)
}

function bound(text: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer')
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'
  return text.slice(0, maxChars - 1) + '…'
}

/**
 * Replace values owned by credential-like keys, then bound the complete safe
 * result. Redaction always runs before truncation, so the retained prefix
 * cannot expose the beginning of a long secret.
 */
export function redactSensitiveText(text: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const redacted = structuredJson(text) ?? redactAssignments(text)
  return bound(redacted, maxChars)
}
