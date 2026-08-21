/** Structure-aware Markdown preparation for Feishu cards. */
/** Parsed table content retained by a table block. */
export interface MarkdownTable {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
}
/** One non-overlapping source region with explicit Markdown semantics. */
export interface MarkdownBlock {
    readonly kind: 'prose' | 'list' | 'fence' | 'table';
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly table?: MarkdownTable | undefined;
}
/** Result of enforcing the card's Markdown table budget. */
export interface TableOverflow {
    readonly text: string;
    readonly sourceTableCount: number;
    readonly compactedTableCount: number;
    readonly truncatedTableCount: number;
}
/** Parse one Markdown table row while respecting escapes and inline-code spans. */
export declare function parseTableRow(row: string): string[] | undefined;
/** Scan source Markdown into explicit blocks while preserving every byte. */
export declare function scanMarkdown(text: string): MarkdownBlock[];
/** Remove inline-code styling outside fenced code blocks. */
export declare function stripInlineCode(text: string): string;
/** Apply all visual Markdown normalizations used by reply and command cards. */
export declare function normalizeMarkdownForCard(text: string): string;
/** Count actual Markdown tables, excluding fenced examples. */
export declare function countMarkdownTables(text: string): number;
/** Compact or truncate Markdown tables beyond the allowed count. */
export declare function applyTableOverflow(text: string, options?: {
    readonly mode: 'compact' | 'truncate';
    readonly maxTables?: number;
}): TableOverflow;
/** Split Markdown to size while re-closing fences and repeating table headers. */
export declare function splitMarkdown(text: string, maxChars: number): string[];
/** Stateful filter for think tags split across model stream chunks. */
export declare class MarkdownStreamFilter {
    private suffix;
    push(delta: string): string;
}
//# sourceMappingURL=markdown.d.ts.map