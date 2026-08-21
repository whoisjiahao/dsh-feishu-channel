/**
 * Feishu/Lark IM channel for DeepSeek Harness: each chat drives its own
 * agent, committed assistant output returns as streaming rich cards or chat
 * messages, and approval questions become interactive cards.
 * @module dsh-feishu-channel
 */
/** Cordis plugin name; keep this stable after publishing. */
export declare const name = "feishu-channel";
/** Services that must exist before the plugin is applied. */
export declare const inject: string[];
export { Config } from './config.ts';
export { apply } from './runtime.ts';
//# sourceMappingURL=index.d.ts.map