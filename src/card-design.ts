/**
 * Interactive-card primitives: the shared building blocks for the channel's
 * command, approval, model-setting, and handoff cards. The semantic palette
 * and spacing tokens live in card-tokens.ts (docs/design-system.md is the
 * design-level source of truth; this file and card-tokens.ts are the
 * executable contract).
 * @module dsh-feishu-channel/card-design
 */

import { toneColor, type CardTone } from './card-tokens.ts'

/** Inline status pill supported by both lark_md and CardKit markdown. */
export function statusTag(label: string, tone: CardTone): string {
  return `<text_tag color='${toneColor(tone)}'>${label}</text_tag>`
}

/** Neutral JSON 1.0 card shell used by interactive command and approval cards. */
export function interactiveCard(elements: readonly object[]): object {
  return {
    config: { wide_screen_mode: true },
    elements,
  }
}

/** Compact JSON 1.0 title row: hierarchy in type, state in one small pill. */
export function interactiveStatusLine(
  title: string,
  status: string,
  tone: CardTone,
): object {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${title}**  ${statusTag(status, tone)}`,
    },
  }
}

/** One hard divider; Feishu does not expose the mockup's edge-fade treatment. */
export function interactiveDivider(): object {
  return { tag: 'hr' }
}

/** Responsive JSON 1.0 label/value row with dynamic content rendered literally. */
export function interactiveFieldRow(label: string, value: string): object {
  return {
    tag: 'div',
    fields: [
      { is_short: true, text: { tag: 'lark_md', content: `**${label}**` } },
      { is_short: true, text: { tag: 'plain_text', content: value } },
    ],
  }
}

/** Static section label followed by literal dynamic content. */
export function interactivePlainSection(label: string, value: string): object[] {
  return [
    { tag: 'div', text: { tag: 'lark_md', content: `**${label}**` } },
    { tag: 'div', text: { tag: 'plain_text', content: value } },
  ]
}

/** Compact CardKit 2.0 state line for cards that do not need a disclosure header. */
export function cardKitStatusLine(
  elementId: string,
  title: string,
  status: string,
  tone: CardTone,
): object {
  return {
    tag: 'markdown',
    element_id: elementId,
    content: `**${title}**  ${statusTag(status, tone)}`,
    text_size: 'normal',
  }
}
