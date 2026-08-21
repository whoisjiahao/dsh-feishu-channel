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

import type { Context } from '@deepseek-ai/cordis'

/** The structural invariant this package owns. */
export const invariantName = 'feishu-channel/conversation-session-injective'

const PACKAGE_NAME = 'dsh-feishu-channel'

/** A package-attributed invariant failure reported by the host registry. */
type InvariantFailure = (message: string) => never

/** Installer callback accepted by the host's invariant registry. */
type InvariantInstaller = (ctx: Context, fail: InvariantFailure) => void | Promise<void>

/** Minimal runtime contract used by the companion without a source checkout. */
interface InvariantRegistry {
  register(packageName: string, installer: InvariantInstaller): () => void
}

/** Cordis companion plugin name. */
export const name = 'feishu-channel-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the channel's conversation→agent bindings and pending
 * approval cards are process-local ephemera keyed by host-owned ids; every
 * durable relation they touch (session/event broadcasts, the approval
 * ask/outcome audit pair) is owned and asserted by the host session and
 * approval packages.
 */
const install: InvariantInstaller = () => {}

/**
 * Resolve the host registry through Cordis's named service lookup. Keeping
 * this narrow local contract lets this package build without host source
 * files; a composed DSH profile still supplies the real `invariants` service.
 * @param ctx - Cordis context carrying the host service.
 * @returns the host invariant registry.
 * @throws {Error} when the companion is loaded without its host service.
 */
function getInvariantRegistry(ctx: Context): InvariantRegistry {
  const registry = ctx.get('invariants') as InvariantRegistry | undefined
  if (registry === undefined) {
    throw new Error('invariant companion requires the "invariants" service for ' + PACKAGE_NAME)
  }
  return registry
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(getInvariantRegistry(ctx).register(PACKAGE_NAME, install))
