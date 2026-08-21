/** Unified cards for slash-command discovery, success, information, and failure. */
import type { HostCommandDescriptor } from './host.ts';
import type { CommandOutcome } from './commands.ts';
/** Render one command's result without falling back to a naked chat message. */
export declare function commandResultCard(command: string, outcome: CommandOutcome): object;
/** Render every available command in the same neutral help card. */
export declare function commandHelpCard(commands: readonly HostCommandDescriptor[]): object;
//# sourceMappingURL=command-card.d.ts.map