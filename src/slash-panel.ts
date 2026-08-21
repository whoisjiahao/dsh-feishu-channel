/** Deterministic reconciliation for the bot's native slash-command panel. */

export type PanelCommand = {
  readonly command: string
  readonly commandId: string
}

/** One page returned by Feishu's application command endpoint. */
export type PanelCommandPage = {
  readonly commands: readonly PanelCommand[]
  readonly nextPageToken?: string | undefined
}

export interface SlashPanelPort {
  readonly listSlashCommands: (pageToken?: string) => Promise<PanelCommandPage>
  readonly createSlashCommand: (command: string, description: string) => Promise<void>
  readonly deleteSlashCommand: (commandId: string) => Promise<void>
}

export type DesiredCommand = {
  readonly name: string
  readonly description: string
}

export type PanelSync = {
  readonly added: string[]
  readonly removed: string[]
}

export type PanelSyncOptions = {
  readonly removeUnknown?: boolean
  readonly signal?: AbortSignal | undefined
}

/** Read all pages, then apply the exact desired/remote difference in stable order. */
export async function syncSlashPanel(
  port: SlashPanelPort,
  desired: readonly DesiredCommand[],
  notify: (line: string) => void,
  options: PanelSyncOptions = {},
): Promise<PanelSync> {
  const signal = options.signal
  let existing: readonly PanelCommand[]
  try {
    existing = await listAllCommands(port, signal)
  } catch (error) {
    if (!isAborted(signal)) {
      notify('feishu-channel: slash-command panel not synced: ' + errorDetail(error))
    }
    return unchanged()
  }
  if (isAborted(signal)) return unchanged()

  const wantedCommands = [...new Map(
    desired.map(command => [command.name, command]),
  ).values()]
  const remoteNames = new Set(existing.map(command => command.command))
  const wantedNames = new Set(wantedCommands.map(command => command.name))
  const added: string[] = []
  const removed: string[] = []

  for (const command of wantedCommands) {
    if (isAborted(signal)) break
    if (remoteNames.has(command.name)) continue
    try {
      await port.createSlashCommand(command.name, command.description)
      added.push(command.name)
      remoteNames.add(command.name)
    } catch (error) {
      notify('feishu-channel: could not register /' + command.name + ': ' + errorDetail(error))
    }
  }

  if (options.removeUnknown !== false) {
    for (const command of existing) {
      if (isAborted(signal)) break
      if (wantedNames.has(command.command)) continue
      try {
        await port.deleteSlashCommand(command.commandId)
        removed.push(command.command)
      } catch (error) {
        notify('feishu-channel: could not remove /' + command.command + ': ' + errorDetail(error))
      }
    }
  }
  return { added, removed }
}

async function listAllCommands(
  port: SlashPanelPort,
  signal: AbortSignal | undefined,
): Promise<readonly PanelCommand[]> {
  const commands: PanelCommand[] = []
  const visitedTokens = new Set<string>()
  let pageToken: string | undefined
  while (!isAborted(signal)) {
    const page = await port.listSlashCommands(pageToken)
    commands.push(...page.commands)
    const next = page.nextPageToken
    if (next === undefined || next === '') break
    if (visitedTokens.has(next)) throw new Error('slash-command pagination repeated token ' + next)
    visitedTokens.add(next)
    pageToken = next
  }
  return commands
}

function unchanged(): PanelSync {
  return { added: [], removed: [] }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
