/**
 * Design-system tokens: the code-layer single source of truth for the
 * semantic palette and spacing scale defined in docs/design-system.md.
 * Every other module consumes these constants and never hardcodes a color
 * or spacing literal.
 * @module dsh-feishu-channel/card-tokens
 */
/** Platform semantic colors; clients adapt these tokens to light and dark themes. */
export declare const CARD_COLOR: {
    readonly neutral: "neutral";
    readonly grey: "grey";
    readonly blue: "blue";
    readonly green: "green";
    readonly orange: "orange";
    readonly red: "red";
    readonly indigo: "indigo";
};
/** Semantic state, independent of Card JSON version. */
export type CardTone = 'neutral' | 'info' | 'success' | 'warning' | 'failure';
/** Map one semantic state to the restrained accent used by status text only. */
export declare function toneColor(tone: CardTone): string;
/** Spacing scale (design-system.md §3.5): the only spacing vocabulary. */
export declare const SPACE_2 = "4px";
export declare const SPACE_3 = "8px";
export declare const SPACE_4 = "12px";
export declare const SPACE_5 = "14px";
export declare const SPACE_6 = "16px";
//# sourceMappingURL=card-tokens.d.ts.map