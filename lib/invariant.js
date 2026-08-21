//#region src/invariant.ts
/** The structural invariant this package owns. */
const invariantName = "feishu-channel/conversation-session-injective";
const PACKAGE_NAME = "dsh-feishu-channel";
/** Cordis companion plugin name. */
const name = "feishu-channel-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the channel's conversation→agent bindings and pending
* approval cards are process-local ephemera keyed by host-owned ids; every
* durable relation they touch (session/event broadcasts, the approval
* ask/outcome audit pair) is owned and asserted by the host session and
* approval packages.
*/
const install = () => {};
/**
* Resolve the host registry through Cordis's named service lookup. Keeping
* this narrow local contract lets this package build without host source
* files; a composed DSH profile still supplies the real `invariants` service.
* @param ctx - Cordis context carrying the host service.
* @returns the host invariant registry.
* @throws {Error} when the companion is loaded without its host service.
*/
function getInvariantRegistry(ctx) {
	const registry = ctx.get("invariants");
	if (registry === void 0) throw new Error("invariant companion requires the \"invariants\" service for dsh-feishu-channel");
	return registry;
}
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(getInvariantRegistry(ctx).register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, invariantName, name };
