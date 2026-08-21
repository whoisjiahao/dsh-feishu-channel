/** Deterministic reconciliation for the bot's native slash-command panel. */
export type PanelCommand = {
    readonly command: string;
    readonly commandId: string;
};
/** One page returned by Feishu's application command endpoint. */
export type PanelCommandPage = {
    readonly commands: readonly PanelCommand[];
    readonly nextPageToken?: string | undefined;
};
export interface SlashPanelPort {
    readonly listSlashCommands: (pageToken?: string) => Promise<PanelCommandPage>;
    readonly createSlashCommand: (command: string, description: string) => Promise<void>;
    readonly deleteSlashCommand: (commandId: string) => Promise<void>;
}
export type DesiredCommand = {
    readonly name: string;
    readonly description: string;
};
export type PanelSync = {
    readonly added: string[];
    readonly removed: string[];
};
export type PanelSyncOptions = {
    readonly removeUnknown?: boolean;
    readonly signal?: AbortSignal | undefined;
};
/** Read all pages, then apply the exact desired/remote difference in stable order. */
export declare function syncSlashPanel(port: SlashPanelPort, desired: readonly DesiredCommand[], notify: (line: string) => void, options?: PanelSyncOptions): Promise<PanelSync>;
//# sourceMappingURL=slash-panel.d.ts.map