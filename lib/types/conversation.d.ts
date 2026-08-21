/** Stable identity for one Feishu conversation facet and one inbound turn. */
/** How Feishu traffic is partitioned into DSH sessions. */
export type SessionScope = 'chat' | 'chat-thread' | 'chat-sender';
/** Message identity fields used before any agent or transport work begins. */
export interface ConversationAddress {
    readonly chatId: string;
    readonly senderId: string;
    readonly messageId: string;
    readonly threadId?: string | undefined;
}
declare const conversationKeyBrand: unique symbol;
/** Encoded key for one independently routed conversation facet. */
export type ConversationKey = string & {
    readonly [conversationKeyBrand]: true;
};
/** Immutable destination captured for one agent turn. */
export interface TurnTarget {
    readonly conversationKey: ConversationKey;
    readonly chatId: string;
    readonly replyToMessageId: string;
    readonly replyInThread: boolean;
}
/** Derive the sole state-partition key for one configured session scope. */
export declare function conversationKey(scope: SessionScope, address: ConversationAddress): ConversationKey;
/** Create a current-generation DSH session id for one conversation key. */
export declare function createSessionId(key: ConversationKey, generation?: string): string;
/** Test whether a session id is a current-generation id for this key. */
export declare function sessionBelongsTo(key: ConversationKey, sessionId: string): boolean;
/** Capture a turn's reply destination before asynchronous work can interleave. */
export declare function createTurnTarget(scope: SessionScope, address: ConversationAddress): TurnTarget;
export {};
//# sourceMappingURL=conversation.d.ts.map