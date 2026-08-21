import { describe, expect, it } from 'vitest'
import { redactSensitiveText } from '../src/presentation/sensitive-text.ts'

describe('redactSensitiveText', () => {
  it('redacts sensitive values throughout nested JSON', () => {
    const input = JSON.stringify({
      command: 'deploy',
      auth: { access_token: 'token-value', clientSecret: 'secret-value' },
      items: [{ password: 'password-value' }, { result: 'safe' }],
    })
    const output = redactSensitiveText(input)

    expect(output).not.toContain('token-value')
    expect(output).not.toContain('secret-value')
    expect(output).not.toContain('password-value')
    expect(output).toContain('deploy')
    expect(output).toContain('safe')
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3)
  })

  it('redacts Python-like and ordinary key-value text', () => {
    const output = redactSensitiveText("{'api_key': 'sk-live', clientSecret = super-secret, result: ok}")
    expect(output).not.toContain('sk-live')
    expect(output).not.toContain('super-secret')
    expect(output).toContain("'api_key': '[REDACTED]'")
    expect(output).toContain('result: ok')
  })

  it('redacts CLI options and authorization headers', () => {
    const output = redactSensitiveText(
      'curl --api-key sk-live --password="hello world" --header "Authorization: Bearer ey.secret.token"',
    )
    expect(output).not.toContain('sk-live')
    expect(output).not.toContain('hello world')
    expect(output).not.toContain('ey.secret.token')
    expect(output).toContain('--api-key [REDACTED]')
    expect(output).toContain('--password="[REDACTED]"')
    expect(output).toContain('"Authorization: [REDACTED]"')
  })

  it('redacts URL query and environment-style secrets', () => {
    const output = redactSensitiveText(
      'POST https://example.test/run?token=abc123&mode=safe API_KEY=xyz789 RESULT=ok',
    )
    expect(output).toBe(
      'POST https://example.test/run?token=[REDACTED]&mode=safe API_KEY=[REDACTED] RESULT=ok',
    )
  })

  it('does not redact identifiers or words that merely contain similar letters', () => {
    const input = 'token_count=42 tokenizer=ready secretariat=open password_hint=none chat_id=oc_1 message_id=om_1'
    expect(redactSensitiveText(input)).toBe(input)
  })

  it('bounds the final redacted text without exposing a truncated secret', () => {
    const output = redactSensitiveText('api_key=' + 'x'.repeat(200) + ' safe=' + 'y'.repeat(200), 48)
    expect(output.length).toBeLessThanOrEqual(48)
    expect(output).toBe('api_key=[REDACTED] safe=' + 'y'.repeat(23) + '…')
    expect(output).not.toContain('xxxxx')
  })

  it('is idempotent and leaves non-sensitive untrusted text unchanged', () => {
    const input = '<script>alert(1)</script> path=/tmp/output.txt'
    expect(redactSensitiveText(input)).toBe(input)
    expect(redactSensitiveText(redactSensitiveText('token=abc'))).toBe('token=[REDACTED]')
  })
})
