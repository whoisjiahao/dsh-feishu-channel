/**
 * Package-owned invariant companion. This channel owns no durable mutable
 * data of its own beyond what the host session store already accounts, so
 * the invariant is a structural one: the plugin's conversation-session
 * mapping must stay injective — one conversation facet, one session id. The
 * pure derivation is exercised by the conversation tests; this companion reserves
 * the package name in the host invariant registry so diagnostic compositions
 * can account for it.
 *
 * The companion is not part of the default bundle patch: the shipped
 * dsh-base/web profiles compose no `invariants` service (it comes from the
 * host's runtime-diagnostics composition), and a row waiting on the absent
 * service fails the whole tree at boot. Diagnostic compositions add the
 * documented row in cordis.patch.yml.
 * @module dsh-feishu-channel/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** The structural invariant this package owns. */
export declare const invariantName = "feishu-channel/conversation-session-injective";
/** Cordis companion plugin name. */
export declare const name = "feishu-channel-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map