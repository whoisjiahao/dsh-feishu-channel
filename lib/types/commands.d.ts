/** Parse and execute the slash commands exposed by the Feishu surface. */
import type { HostAgent, HostCommandDescriptor, HostCommands, HostModelController } from './host.ts';
export declare const NEW_COMMAND = "new";
export declare const RESET_COMMAND = "reset";
export declare const STOP_COMMAND = "stop";
export declare const HELP_COMMAND = "help";
export declare const MODEL_COMMAND = "model";
export declare const EFFORT_COMMAND = "effort";
/** Commands owned by this channel, shared by help and slash-panel sync. */
export declare const CHANNEL_COMMANDS: readonly [{
    name: "new";
    description: string;
}, {
    name: "reset";
    description: string;
}, {
    name: "stop";
    description: string;
}, {
    name: "model";
    description: string;
}, {
    name: "effort";
    description: string;
}, {
    name: "help";
    description: string;
}];
/** One syntactically valid command. Parsing has no runtime side effects. */
export interface ParsedCommand {
    readonly name: string;
    readonly input: string;
    readonly source: string;
}
/** Parse one complete command line; surrounding non-command text is rejected. */
export declare function parseCommandLine(text: string): ParsedCommand | undefined;
export declare function isCommandLine(text: string): boolean;
export declare function isSessionCommand(text: string): boolean;
/** User-visible result consumed by the command card. */
export interface CommandOutcome {
    readonly reply: string;
    readonly status: 'success' | 'info' | 'failure';
}
/** Runtime services required after parsing. */
export interface CommandExecutionContext {
    readonly agent: HostAgent;
    readonly commands?: HostCommands | undefined;
    readonly models?: HostModelController | undefined;
    readonly signal: AbortSignal;
}
/** Deduplicated directory shared by help cards and slash-panel sync. */
export declare function commandCatalog(commands: HostCommands | undefined, agent: HostAgent): HostCommandDescriptor[];
export declare function helpText(commands: HostCommands | undefined, agent: HostAgent): string;
/** Execute a command that has already passed syntax parsing. */
export declare function executeCommand(command: ParsedCommand, context: CommandExecutionContext): Promise<CommandOutcome>;
//# sourceMappingURL=commands.d.ts.map