/** Owned DSH agent lifecycle partitioned by Feishu conversation identity. */

import type { Context } from '@deepseek-ai/cordis'
import { createSessionId, sessionBelongsTo, type ConversationKey } from './conversation.ts'
import type {
  HostAgentHandle,
  HostAgentOptions,
  HostAgentRegistry,
  HostSessionPersistence,
  HostWorkspace,
} from './host.ts'

/** One agent this plugin created or resumed and therefore owns. */
export interface OwnedAgent {
  readonly conversationKey: ConversationKey
  readonly handle: HostAgentHandle
}

/** Host seams and per-agent composition used by the registry. */
export interface AgentRegistryOptions {
  readonly agents: HostAgentRegistry
  readonly workspace?: HostWorkspace | undefined
  readonly persistence?: HostSessionPersistence | undefined
  readonly agentOptions?: HostAgentOptions | undefined
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string } | undefined
  readonly setup?: ((agentCtx: Context) => Promise<void>) | undefined
  readonly report?: ((line: string) => void) | undefined
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serializes lifecycle work per conversation while allowing unrelated
 * conversations to progress independently.
 */
export class AgentRegistry {
  private readonly current = new Map<ConversationKey, OwnedAgent>()
  private readonly conversationBySession = new Map<string, ConversationKey>()
  private readonly pending = new Map<ConversationKey, Promise<void>>()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly options: AgentRegistryOptions) {}

  /** Return the current owned agent, opening it once when absent. */
  acquire(key: ConversationKey): Promise<OwnedAgent> {
    return this.exclusive(key, async () => {
      const existing = this.current.get(key)
      if (existing !== undefined) return existing
      const opened = await this.restoreOrCreate(key)
      this.remember(opened)
      return opened
    })
  }

  /** Replace one conversation generation and retire its previous owned agent. */
  reset(key: ConversationKey): Promise<OwnedAgent> {
    return this.exclusive(key, async () => {
      const previous = this.current.get(key)
      const replacement = await this.create(key)
      await this.attach(replacement.handle.agent.session.id)
      this.remember(replacement)

      if (previous !== undefined) {
        this.conversationBySession.delete(previous.handle.agent.session.id)
        previous.handle.agent.cancel({ kind: 'user' })
        await this.detach(previous.handle.agent.session.id)
        await previous.handle.dispose().catch((error: unknown) => {
          this.report('disposing replaced session failed: ' + detail(error))
        })
      }
      return replacement
    })
  }

  /** Whether this registry currently owns one exact host session. */
  ownsSession(sessionId: string): boolean {
    return this.conversationBySession.has(sessionId)
  }

  /** Whether an acquired handle is still the active generation for its conversation. */
  isCurrent(agent: OwnedAgent): boolean {
    return this.current.get(agent.conversationKey) === agent
  }

  /** The conversation key currently owning a host session, when any. */
  conversationOf(sessionId: string): ConversationKey | undefined {
    return this.conversationBySession.get(sessionId)
  }

  /** Dispose every owned handle after in-flight lifecycle work settles. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.closing = (async () => {
      await Promise.allSettled([...this.pending.values()])
      const handles = [...new Set([...this.current.values()].map(entry => entry.handle))]
      this.current.clear()
      this.conversationBySession.clear()
      await Promise.allSettled(handles.map(handle => handle.dispose()))
    })()
    return this.closing
  }

  private exclusive<T>(key: ConversationKey, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('agent registry is closed'))
    const previous = this.pending.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      if (this.closed) throw new Error('agent registry is closed')
      return work()
    })
    const settled = operation.then(() => undefined, () => undefined)
    this.pending.set(key, settled)
    return operation.finally(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key)
    })
  }

  private async restoreOrCreate(key: ConversationKey): Promise<OwnedAgent> {
    for (const sessionId of await this.candidates(key)) {
      if (this.options.agents.get(sessionId) !== undefined) {
        this.report('foreign live agent skipped: ' + sessionId)
        continue
      }
      try {
        const handle = await this.options.agents.resume({
          resumeSessionId: sessionId,
          ...(this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions }),
          ...(this.options.setup === undefined ? {} : { setup: this.options.setup }),
        })
        const owned = Object.freeze({ conversationKey: key, handle })
        await this.attach(sessionId)
        return owned
      } catch (error) {
        this.report('resuming session ' + sessionId + ' failed: ' + detail(error))
      }
    }

    const created = await this.create(key)
    await this.attach(created.handle.agent.session.id)
    return created
  }

  private async create(key: ConversationKey): Promise<OwnedAgent> {
    const handle = await this.options.agents.create({
      sessionId: createSessionId(key),
      ...(this.options.meta === undefined ? {} : { meta: this.options.meta }),
      ...(this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions }),
      ...(this.options.setup === undefined ? {} : { setup: this.options.setup }),
    })
    return Object.freeze({ conversationKey: key, handle })
  }

  private remember(agent: OwnedAgent): void {
    this.current.set(agent.conversationKey, agent)
    this.conversationBySession.set(agent.handle.agent.session.id, agent.conversationKey)
  }

  private async candidates(key: ConversationKey): Promise<string[]> {
    const ids: string[] = []
    if (this.options.persistence !== undefined) {
      try {
        const headers = await this.options.persistence.list()
        ids.push(...headers
          .filter(header => sessionBelongsTo(key, header.id))
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(header => header.id))
      } catch (error) {
        this.report('listing persisted sessions failed: ' + detail(error))
      }
    }
    ids.push(...(this.options.workspace?.sessionIds ?? []).filter(id => sessionBelongsTo(key, id)))
    return [...new Set(ids)]
  }

  private async attach(sessionId: string): Promise<void> {
    if (this.options.workspace === undefined) return
    try {
      await this.options.workspace.attachSession(sessionId)
    } catch (error) {
      this.report('workspace attach failed for ' + sessionId + ': ' + detail(error))
    }
  }

  private async detach(sessionId: string): Promise<void> {
    if (this.options.workspace === undefined) return
    try {
      await this.options.workspace.detachSession(sessionId)
    } catch (error) {
      this.report('workspace detach failed for ' + sessionId + ': ' + detail(error))
    }
  }

  private report(line: string): void {
    this.options.report?.(line)
  }
}
