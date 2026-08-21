/**
 * Interactive-card primitives: the shared building blocks for the channel's
 * command, approval, model-setting, and handoff cards. The semantic palette
 * and spacing tokens live in card-tokens.ts (docs/design-system.md is the
 * design-level source of truth; this file and card-tokens.ts are the
 * executable contract).
 * @module dsh-feishu-channel/card-design
 */
import { type CardTone } from './card-tokens.ts';
/** Inline status pill supported by both lark_md and CardKit markdown. */
export declare function statusTag(label: string, tone: CardTone): string;
/** Neutral JSON 1.0 card shell used by interactive command and approval cards. */
export declare function interactiveCard(elements: readonly object[]): object;
/** Compact JSON 1.0 title row: hierarchy in type, state in one small pill. */
export declare function interactiveStatusLine(title: string, status: string, tone: CardTone): object;
/** One hard divider; Feishu does not expose the mockup's edge-fade treatment. */
export declare function interactiveDivider(): object;
/** Responsive JSON 1.0 label/value row with dynamic content rendered literally. */
export declare function interactiveFieldRow(label: string, value: string): object;
/** Static section label followed by literal dynamic content. */
export declare function interactivePlainSection(label: string, value: string): object[];
/** Compact CardKit 2.0 state line for cards that do not need a disclosure header. */
export declare function cardKitStatusLine(elementId: string, title: string, status: string, tone: CardTone): object;
//# sourceMappingURL=card-design.d.ts.map