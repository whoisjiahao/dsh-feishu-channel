/** Unified cards for slash-command discovery, success, information, and failure. */
import type { HostCommandDescriptor } from './host.ts';
import type { CommandOutcome } from './commands.ts';
/** Marker distinguishing command-card callbacks from other card actions. */
export declare const COMMAND_INTERACTION_ACTION = "dsh-feishu-channel/command-interaction";
/** Form field carrying one command's free-form argument text. */
export declare const COMMAND_INPUT_NAME = "command_input";
type CommandInteractionKind = 'open' | 'run' | 'cancel';
/** Compact callback payload; allowed commands remain in server-side pending state. */
export interface CommandInteractionActionValue {
    readonly kind: typeof COMMAND_INTERACTION_ACTION;
    readonly id: string;
    readonly action: CommandInteractionKind;
}
/** Narrow an arbitrary card value to this plugin's command interaction. */
export declare function commandInteractionActionValue(value: unknown): CommandInteractionActionValue | undefined;
/** Encode one unguessable pending id into a CardKit form-submit button name. */
export declare function commandFormActionName(id: string): string;
/** Recover a pending id only from this plugin's form-submit namespace. */
export declare function commandFormActionId(name: unknown): string | undefined;
/** Render one command's result without falling back to a naked chat message. */
export declare function commandResultCard(command: string, outcome: CommandOutcome): object;
/** Render every available command as one native selector. */
export declare function commandHelpCard(commands: readonly HostCommandDescriptor[], id: string): object;
/** Render one host descriptor as a confirmation card or free-text form. */
export declare function commandPromptCard(command: HostCommandDescriptor, id: string): object;
/** Replace a dismissed prompt with a terminal, inert card. */
export declare function cancelledCommandCard(command: string): object;
export {};
//# sourceMappingURL=command-card.d.ts.map