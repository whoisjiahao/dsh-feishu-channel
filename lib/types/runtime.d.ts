/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-feishu-channel/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
import type { ResolvedConfig } from './config.ts';
import { type ChannelPort } from './channel.ts';
import type { LarkCredentials, RegisterAppPort } from './onboarding.ts';
import type { Authorization } from './authorization.ts';
/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials;
/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - the channel's authorization rules.
 * @returns the real @larksuite/channel client behind the channel's port surface.
 */
export declare function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort;
/** Substitutable production boundaries; tests replace them with fakes. */
export declare const internals: {
    createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort;
    registerApp: RegisterAppPort;
    notify: (line: string) => void;
    reissueFloorMs?: number;
};
/**
 * Apply the plugin to its Cordis context. With credentials configured the
 * transport connects directly; without them the QR registration flow runs
 * first and persists the scanned credentials through the host settings
 * service when one is composed.
 * @param ctx - scoped plugin context; requires the agents service.
 * @param config - configuration resolved by Cordis from the exported schema.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=runtime.d.ts.map