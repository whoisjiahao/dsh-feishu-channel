/** Owned-turn approval questions rendered and settled through Feishu cards. */
import type { CardActionEvent, CardActionResponse, SendInput, SendResult } from '@larksuite/channel';
import type { ConversationKey } from './conversation.ts';
import type { HostApprovalOutcome, HostApprovalRequest } from './host.ts';
/** Marker distinguishing this plugin's approval actions. */
export declare const APPROVAL_ACTION = "dsh-feishu-channel/approval";
/** Exact owned turn allowed to surface one host approval in Feishu. */
export interface ApprovalTurn {
    readonly sessionId: string;
    readonly turnId: string;
    readonly conversationKey: ConversationKey;
    readonly chatId: string;
    readonly chatType: string;
}
/** One visible approval awaiting a decision. */
export interface PendingApproval {
    readonly conversationKey: ConversationKey;
    readonly chatId: string;
    readonly chatType: string;
    readonly messageId: string;
    readonly toolName: string;
}
/** Frozen pending approval card. Dynamic values are literal plain text. */
export declare function approvalCard(toolName: string, reason: string | undefined, command: string | undefined, id: string): object;
/** Frozen terminal approval card. */
export declare function settledCard(toolName: string, outcome: HostApprovalOutcome, decidedBy?: string): object;
/** Dependencies and policy callback owned by one approval gate. */
export interface ApprovalGateOptions {
    readonly port: {
        send(to: string, input: SendInput): Promise<SendResult>;
        updateCard(messageId: string, card: object): Promise<void>;
    };
    readonly notify: (line: string) => void;
    readonly refuseCardAction: (subject: {
        readonly operatorId: string;
        readonly chatId: string;
    }, pending: PendingApproval) => string | undefined;
    readonly createId?: (() => string) | undefined;
}
/** Approval lifecycle scoped to Feishu-submitted owned turns. */
export interface ApprovalGate {
    recordToolCall(owner: ApprovalTurn, callId: string, argumentsText: string): void;
    finishTurn(owner: ApprovalTurn): void;
    ask(owner: ApprovalTurn, request: HostApprovalRequest, next: () => Promise<HostApprovalOutcome>): Promise<HostApprovalOutcome>;
    handleCardAction(event: CardActionEvent): CardActionResponse | undefined;
    cancelConversation(key: ConversationKey): Promise<void>;
    close(): Promise<void>;
}
/** Create a gate with exact owner, call, card, and cancellation correlation. */
export declare function createApprovalGate(options: ApprovalGateOptions): ApprovalGate;
//# sourceMappingURL=approval-gate.d.ts.map