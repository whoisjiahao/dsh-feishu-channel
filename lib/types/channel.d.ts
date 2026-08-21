/** Feishu channel composition: inbound messages, owned agents, turns, and transport lifecycle. */
import type { Context } from '@deepseek-ai/cordis';
import type { CardActionEvent, CardActionResponse, LarkChannelError, NormalizedMessage, RejectEvent } from '@larksuite/channel';
import { type Authorization } from './authorization.ts';
import type { ResolvedConfig } from './config.ts';
import type { HostUserMessage } from './host.ts';
import { type CollectedImages, type ImagePort } from './images.ts';
import { type ReplyPresenterPort } from './presentation/reply-presenter.ts';
import { type SlashPanelPort } from './slash-panel.ts';
/** Transport operations consumed by one running channel. */
export interface ChannelPort extends ReplyPresenterPort, ImagePort, SlashPanelPort {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    on(name: 'message', handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
    on(name: 'cardAction', handler: (event: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>): () => void;
    on(name: 'reject', handler: (event: RejectEvent) => void): () => void;
    on(name: 'error', handler: (error: LarkChannelError) => void): () => void;
    on(name: 'reconnecting', handler: () => void): () => void;
    on(name: 'reconnected', handler: () => void): () => void;
    updateCard(messageId: string, card: object): Promise<void>;
}
/** Model-facing layout contract for the frozen reply-card experience. */
export declare const REPLY_CARD_PROMPT: string;
/** Convert one normalized Feishu message into an immutable host user message. */
export declare function chatUserMessage(message: NormalizedMessage, images: CollectedImages): HostUserMessage;
/** Install one channel and bind every registration to the current plugin fiber. */
export declare function installChannel(ctx: Context, config: ResolvedConfig, port: ChannelPort, notify: (line: string) => void, authorization: Authorization): void;
//# sourceMappingURL=channel.d.ts.map