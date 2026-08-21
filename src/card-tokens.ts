/**
 * Design-system tokens: the code-layer single source of truth for the
 * semantic palette and spacing scale defined in docs/design-system.md.
 * Every other module consumes these constants and never hardcodes a color
 * or spacing literal.
 * @module dsh-feishu-channel/card-tokens
 */

/** Platform semantic colors; clients adapt these tokens to light and dark themes. */
export const CARD_COLOR = {
  neutral: 'neutral',
  grey: 'grey',
  blue: 'blue',
  green: 'green',
  orange: 'orange',
  red: 'red',
  indigo: 'indigo',
} as const

/** Semantic state, independent of Card JSON version. */
export type CardTone = 'neutral' | 'info' | 'success' | 'warning' | 'failure'

/** Map one semantic state to the restrained accent used by status text only. */
export function toneColor(tone: CardTone): string {
  switch (tone) {
    case 'info': return CARD_COLOR.blue
    case 'success': return CARD_COLOR.green
    case 'warning': return CARD_COLOR.orange
    case 'failure': return CARD_COLOR.red
    default: return CARD_COLOR.neutral
  }
}

/** Spacing scale (design-system.md §3.5): the only spacing vocabulary. */
export const SPACE_2 = '4px'
export const SPACE_3 = '8px'
export const SPACE_4 = '12px'
export const SPACE_5 = '14px'
export const SPACE_6 = '16px'
