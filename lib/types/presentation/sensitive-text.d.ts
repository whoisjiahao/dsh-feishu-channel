/** Redacts credential values before untrusted operational text reaches a card. */
/**
 * Replace values owned by credential-like keys, then bound the complete safe
 * result. Redaction always runs before truncation, so the retained prefix
 * cannot expose the beginning of a long secret.
 */
export declare function redactSensitiveText(text: string, maxChars?: number): string;
//# sourceMappingURL=sensitive-text.d.ts.map