/** Exact Feishu card serialization and capacity inspection. */
/** Fixed platform and safety limits. */
export declare const FEISHU_MAX_TABLES = 5;
export declare const FEISHU_MAX_ELEMENTS = 200;
export declare const SAFE_CARD_JSON_BYTES = 28000;
export type CardBudgetViolation = 'unserializable' | 'json_bytes' | 'elements' | 'tables';
/** Complete card budget verdict. */
export interface CardBudgetInspection {
    readonly jsonBytes: number;
    readonly elementCount: number;
    readonly tableCount: number;
    readonly violations: readonly CardBudgetViolation[];
    readonly safe: boolean;
    readonly primaryReason: CardBudgetViolation | '';
    readonly serializationError: string;
}
/**
 * Serialize and inspect a card through one JSON traversal. Unsupported or
 * circular values are replaced only inside the temporary serialization and
 * always make the verdict unsafe.
 */
export declare function inspectCardBudget(card: unknown): CardBudgetInspection;
//# sourceMappingURL=card-budget.d.ts.map