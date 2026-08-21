/**
 * Who may drive this channel's agents and answer their approval questions.
 * The platform owns the outer boundary (app visibility scope); every list
 * here is empty by default and only narrows when a deployment fills it in.
 * @module dsh-feishu-channel/authorization
 */
import type { ResolvedConfig } from './config.ts';
/** The narrowing rules one running channel applies. */
export interface Authorization {
    /** Senders allowed to send direct messages; empty allows everyone the platform admits. */
    readonly directSenders: ReadonlySet<string>;
    /** Group chat ids the channel serves; empty serves any group the bot is in. */
    readonly groups: ReadonlySet<string>;
    /** Open ids that may answer approvals; empty lets anyone who may drive the chat answer. */
    readonly approvers: ReadonlySet<string>;
}
/** Resolve the narrowing rules from configuration. */
export declare function resolveAuthorization(config: ResolvedConfig): Authorization;
/** State the channel's reach once, for the operator, at startup. */
export declare function describeAuthorization(authorization: Authorization): string;
/** One inbound message's authorization subject. */
export interface MessageSubject {
    readonly senderId: string;
    readonly chatId: string;
    readonly chatType: string;
}
/**
 * Whether one inbound message may drive this channel.
 * @param authorization - the channel's authorization rules.
 * @param subject - the message's sender, chat, and chat kind.
 * @returns the refusal reason for the operator log, or undefined when allowed.
 */
export declare function refuseMessage(authorization: Authorization, subject: MessageSubject): string | undefined;
/**
 * Whether one card click may settle an approval. With no configured
 * approvers, whoever may drive that chat may also answer it.
 * @param authorization - the channel's authorization rules.
 * @param click - the clicking operator and the chat the click came from.
 * @param pending - the chat the approval card was published to, and its kind.
 * @returns the refusal reason, or undefined when the click counts.
 */
export declare function refuseApprovalClick(authorization: Authorization, click: {
    readonly operatorId: string | undefined;
    readonly chatId: string;
}, pending: {
    readonly chatId: string;
    readonly chatType: string;
}): string | undefined;
//# sourceMappingURL=authorization.d.ts.map