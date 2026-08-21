/** Owns card publication for one immutable Feishu reply target. */
import type { SendInput, SendOptions, SendResult } from '@larksuite/channel';
import type { HostSessionEvent, RequestContextData } from '../host.ts';
import { type CardRenderOptions } from './feishu-card.ts';
/** Transport operations required to publish one reply. */
export interface ReplyPresenterPort {
    send(to: string, input: SendInput, options?: SendOptions): Promise<SendResult>;
    updateCard(messageId: string, card: object): Promise<void>;
}
/** Immutable destination captured when a turn is coordinated. */
export interface ReplyDestination {
    readonly chatId: string;
    readonly replyToMessageId: string;
    readonly replyInThread: boolean;
}
/** Publication controls in addition to the card's visual options. */
export interface ReplyPresenterOptions extends CardRenderOptions {
    readonly onFailure: (error: unknown) => void;
    readonly initialContext?: RequestContextData | undefined;
    readonly reuseCardMessageId?: string | undefined;
    readonly onCardPublished?: ((messageId: string) => void) | undefined;
}
/** One turn-bound presenter. */
export interface ReplyPresenter {
    observe(event: HostSessionEvent): void;
    close(): Promise<void>;
}
/** Create a presenter whose destination cannot be retargeted later. */
export declare function createReplyPresenter(port: ReplyPresenterPort, destination: ReplyDestination, options: ReplyPresenterOptions): ReplyPresenter;
/** Remove model-emitted pseudo tool calls before a native fallback is sent. */
export declare function stripToolCallMarkup(text: string): string;
//# sourceMappingURL=reply-presenter.d.ts.map