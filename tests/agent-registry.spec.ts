import { describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/agent-registry.ts'
import { conversationKey } from '../src/conversation.ts'
import type {
  HostAgent,
  HostAgentHandle,
  HostAgentRegistry,
  HostSessionPersistence,
  HostWorkspace,
} from '../src/host.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function createHost() {
  const stored = new Map<string, number>()
  const live = new Map<string, HostAgent>()
  const created: string[] = []
  const resumed: string[] = []
  const disposed: string[] = []
  const attached: string[] = []
  const detached: string[] = []
  const workspaceIds: string[] = []
  const state: { failAttach: boolean; createGate?: Promise<void> } = { failAttach: false }
  let clock = 0

  const handle = (sessionId: string): HostAgentHandle => {
    const agent: HostAgent = {
      id: sessionId,
      session: { id: sessionId, requestContext: () => undefined },
      followup: vi.fn(),
      cancel: vi.fn(),
    }
    live.set(sessionId, agent)
    return {
      agent,
      dispose: vi.fn(async () => {
        disposed.push(sessionId)
        live.delete(sessionId)
      }),
    }
  }

  const agents: HostAgentRegistry = {
    get: sessionId => live.get(sessionId),
    async resume(options) {
      resumed.push(options.resumeSessionId)
      if (!stored.has(options.resumeSessionId) || live.has(options.resumeSessionId)) {
        throw new Error('session unavailable: ' + options.resumeSessionId)
      }
      return handle(options.resumeSessionId)
    },
    async create(options) {
      await state.createGate
      created.push(options.sessionId)
      clock += 1
      stored.set(options.sessionId, clock)
      return handle(options.sessionId)
    },
  }

  const persistence: HostSessionPersistence = {
    async list() {
      return [...stored].map(([id, createdAt]) => ({ id, createdAt }))
    },
  }

  const workspace: HostWorkspace = {
    id: 'ws',
    path: '/workspace',
    get sessionIds() { return [...workspaceIds] },
    async attachSession(sessionId) {
      if (state.failAttach) throw new Error('attach failed')
      attached.push(sessionId)
      workspaceIds.splice(0, workspaceIds.length, sessionId, ...workspaceIds.filter(id => id !== sessionId))
    },
    async detachSession(sessionId) {
      detached.push(sessionId)
      const index = workspaceIds.indexOf(sessionId)
      if (index >= 0) workspaceIds.splice(index, 1)
    },
  }

  return {
    agents,
    persistence,
    workspace,
    stored,
    live,
    created,
    resumed,
    disposed,
    attached,
    detached,
    workspaceIds,
    state,
    declareForeignLive(sessionId: string) { return handle(sessionId).agent },
  }
}

function key() {
  return conversationKey('chat', {
    chatId: 'oc_chat',
    senderId: 'ou_sender',
    messageId: 'om_message',
  })
}

function registry(host: ReturnType<typeof createHost>, reports: string[] = []) {
  return new AgentRegistry({
    agents: host.agents,
    workspace: host.workspace,
    persistence: host.persistence,
    report: line => { reports.push(line) },
  })
}

describe('AgentRegistry', () => {
  it('serializes concurrent acquisition for one conversation', async () => {
    const host = createHost()
    const agents = registry(host)
    const [first, second] = await Promise.all([agents.acquire(key()), agents.acquire(key())])

    expect(first).toBe(second)
    expect(host.created).toHaveLength(1)
    expect(agents.ownsSession(first.handle.agent.session.id)).toBe(true)
    await agents.close()
  })

  it('makes acquire wait for an in-flight reset and return the replacement', async () => {
    const host = createHost()
    const agents = registry(host)
    const previous = await agents.acquire(key())
    const gate = deferred()
    host.state.createGate = gate.promise

    const resetting = agents.reset(key())
    let acquired = false
    const acquiring = agents.acquire(key()).then((value) => {
      acquired = true
      return value
    })
    await Promise.resolve()
    expect(acquired).toBe(false)

    gate.resolve()
    const replacement = await resetting
    expect(await acquiring).toBe(replacement)
    expect(replacement).not.toBe(previous)
    expect(previous.handle.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(host.disposed).toContain(previous.handle.agent.session.id)
    await agents.close()
  })

  it('does not adopt a live agent owned by another surface', async () => {
    const host = createHost()
    const conversation = key()
    const foreignId = 'feishu-' + conversation + '~123e4567-e89b-42d3-a456-426614174000'
    host.stored.set(foreignId, 1)
    host.declareForeignLive(foreignId)
    const reports: string[] = []
    const agents = registry(host, reports)

    const opened = await agents.acquire(conversation)
    expect(opened.handle.agent.session.id).not.toBe(foreignId)
    expect(host.resumed).not.toContain(foreignId)
    expect(reports.some(line => line.includes('foreign live agent'))).toBe(true)
    await agents.close()
  })

  it('recovers an attach-failed session from persistence on the next start', async () => {
    const host = createHost()
    host.state.failAttach = true
    const firstRegistry = registry(host)
    const first = await firstRegistry.acquire(key())
    const sessionId = first.handle.agent.session.id
    expect(host.workspaceIds).toEqual([])
    await firstRegistry.close()

    host.state.failAttach = false
    const secondRegistry = registry(host)
    const resumed = await secondRegistry.acquire(key())
    expect(resumed.handle.agent.session.id).toBe(sessionId)
    expect(host.resumed).toContain(sessionId)
    expect(host.workspaceIds).toEqual([sessionId])
    await secondRegistry.close()
  })

  it('closes owned handles once and rejects later work', async () => {
    const host = createHost()
    const agents = registry(host)
    const opened = await agents.acquire(key())
    await agents.close()
    await agents.close()

    expect(host.disposed.filter(id => id === opened.handle.agent.session.id)).toHaveLength(1)
    await expect(agents.acquire(key())).rejects.toThrow('closed')
    await expect(agents.reset(key())).rejects.toThrow('closed')
  })
})
