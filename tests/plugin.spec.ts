/**
 * End-to-end tests for the mounted channel: the production plugin running
 * over the fake transport and fake host services from `harness.ts`. Covers
 * the inbound ladder, message shaping, authorization, slash commands, the
 * approval card lifecycle, rich-card rendering, image intake, panel sync,
 * disposal, and first-boot onboarding.
 * @module tests/plugin
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostAgent,
  HostApprovalOutcome,
  HostApprovalRequest,
  HostCommandImage,
  HostCommands,
  HostSession,
  HostSessionEvent,
} from '../src/host.ts'
import type { RegisterAppPort } from '../src/onboarding.ts'
import { RETRY_ACTION, COPY_ERROR_ACTION } from '../src/presentation/feishu-card.ts'
import {
  approvalValueFromCard,
  clickAction,
  createFakeAttachments,
  createFakeCommands,
  createFakeModelApi,
  createFakePort,
  createFakePresets,
  createFakeSettings,
  createFakeTools,
  createFakeWorkspaces,
  fakeMessage,
  mountChannel,
  SENDER_ID,
  type Harness,
} from './harness.ts'

describe('controllable transport harness', () => {
  it('keeps the message delivery promise open until its async handler finishes', async () => {
    const fake = createFakePort()
    fake.controls.delayNextSend()
    fake.port.on('message', async (message) => {
      await fake.port.send(message.chatId, { text: 'done' })
    })

    let completed = false
    const delivery = fake.emitMessage(fakeMessage()).then(() => { completed = true })
    await vi.waitFor(() => { expect(fake.state.pendingSends).toBe(1) })
    expect(fake.state.inFlightMessages).toBe(1)
    expect(completed).toBe(false)

    fake.controls.releaseSend()
    await delivery
    expect(completed).toBe(true)
    expect(fake.state.inFlightMessages).toBe(0)
  })

  it('models the real pending-connect disposal edge', async () => {
    const fake = createFakePort()
    fake.controls.delayNextConnect()
    const connecting = fake.port.connect()
    await vi.waitFor(() => { expect(fake.state.connecting).toBe(true) })

    await fake.port.disconnect()
    expect(fake.state.connected).toBe(false)
    fake.controls.releaseConnect()
    await connecting
    expect(fake.state.connected).toBe(true)
  })
})

/** Each test owns one mounted channel; dispose it even when an assertion fails. */
let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Mount the channel and register it for afterEach disposal. */
const TEST_CREDENTIALS = { appId: 'cli_test', appSecret: 'test-secret' }
async function mount(
  overrides: Parameters<typeof mountChannel>[0] = {},
  services: Parameters<typeof mountChannel>[1] = {},
  credentials: Parameters<typeof mountChannel>[2] = TEST_CREDENTIALS,
) {
  harness = await mountChannel(overrides, services, credentials)
  return harness
}

/** Wait until the chat's first agent exists and return it. */
async function firstAgent(harness: Harness) {
  await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
  return harness.agents.created[0]!
}

/** Current-generation session prefixes used by the explicit conversation scopes. */
const chatSessionPrefix = (chatId: string) => 'feishu-chat:' + chatId
const threadSessionPrefix = (chatId: string, threadId: string) => 'feishu-thread:' + chatId + ':' + threadId
const generation = '00000000-0000-4000-8000-000000000001'

/** One session event, shaped as the host session store broadcasts it. */
function sessionEvent(type: string, data: unknown): HostSessionEvent {
  return { type, data } as HostSessionEvent
}

/** A completed assistant turn's events, ending with the turn/end boundary. */
function completeTurn(overrides: { answer?: string; toolTitle?: string } = {}): HostSessionEvent[] {
  const { answer = '## 完成\n结论已经给出。', toolTitle = 'exec_command' } = overrides
  return [
    sessionEvent('step/start', { turn: 1, step: 1 }),
    sessionEvent('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '正在思考' } }),
    sessionEvent('assistant/chunk', { turn: 1, chunk: { type: 'text', text: '正在处理' } }),
    sessionEvent('tool/call', {
      turn: 1,
      callId: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}',
    }),
    sessionEvent('tool/result', {
      turn: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: toolTitle + ': done' }],
        }],
      },
    }),
    sessionEvent('assistant/message', {
      turn: 1,
      message: {
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** Emit one owned agent's session events exactly as the host store would. */
function emitEvents(harness: Harness, agent: { session: HostSession }, events: HostSessionEvent[]): void {
  for (const event of events) harness.ctx.emit('session/event', agent.session, event)
}

/** One approval question for an owned agent, answered by the channel's card. */
function approvalFor(harness: Harness, agent: { id: string; session: { id: string } }, extra: Partial<HostApprovalRequest> = {}) {
  return harness.ctx.waterfall('approval/request', {
    agent: agent as HostApprovalRequest['agent'],
    toolName: 'bash',
    ...extra,
  } as HostApprovalRequest, async (): Promise<HostApprovalOutcome> => 'unavailable')
}

describe('inbound ladder and message shaping', () => {
  it('creates one agent per chat and follows up verbatim in direct messages', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ content: 'first' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    // A fresh chat gets a fresh generation of the conversation's session id.
    expect(created.sessionId.startsWith(chatSessionPrefix('oc_chat_1') + '~')).toBe(true)
    const sent = created.agent.followup.mock.calls[0]![0]!
    expect(sent.content[0]).toEqual({ type: 'text', text: 'first' })
    expect(sent.role).toBe('user')

    // A later message in the same chat reuses the same agent.
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_in_2', content: 'second' }))
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(2) })
    expect(h.agents.created).toHaveLength(1)

    // Another chat gets its own agent.
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_in_3', chatId: 'oc_chat_2', content: 'other' }))
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(2) })
    expect(h.agents.created[1]!.sessionId.startsWith(chatSessionPrefix('oc_chat_2') + '~')).toBe(true)
  })

  it('keeps SDK delivery pending until asynchronous agent creation finishes', async () => {
    const h = await mount()
    h.agents.controls.delayNextCreate()
    let delivered = false
    const delivery = h.fake.emitMessage(fakeMessage()).then(() => { delivered = true })

    try {
      await vi.waitFor(() => { expect(h.agents.state.pendingCreates).toBe(1) })
      expect(h.fake.state.inFlightMessages).toBe(1)
      expect(delivered).toBe(false)
    } finally {
      h.agents.controls.releaseCreate()
      await delivery
    }

    expect(delivered).toBe(true)
    expect(h.fake.state.inFlightMessages).toBe(0)
  })

  it('prefixes group messages with the sender so the model can tell voices apart', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ chatType: 'group', senderName: 'Alice', content: 'hi all' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    expect(created.agent.followup.mock.calls[0]![0]!.content[0]).toEqual({ type: 'text', text: 'Alice: hi all' })
  })

  it('skips bot-authored messages and blank pings without starting a turn', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ senderIsBot: true, content: 'hello' }))
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_in_2', content: '   ' }))
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_in_3', content: '' }))
    // Give any wrongly-started creation a chance to surface.
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(h.agents.created).toHaveLength(0)
    expect(h.fake.sent).toHaveLength(0)
  })

  it('aims replies at the asking message inside its thread', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1', content: 'in thread' }))
    const created = await firstAgent(h)
    emitEvents(h, created.agent, completeTurn())
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(h.fake.sent[0]!.opts).toEqual({ replyTo: 'om_in_1', replyInThread: true })
    expect(h.fake.sent[0]!.to).toBe('oc_chat_1')
  })

  it('leaves a reply outside any thread unthreaded', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    emitEvents(h, created.agent, completeTurn())
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(h.fake.sent[0]!.opts).toEqual({ replyTo: 'om_in_1' })
  })

  it('keeps the reply target captured by each queued message', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_first', content: 'first' }))
    const created = await firstAgent(h)
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_second', content: 'second' }))
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(2) })

    emitEvents(h, created.agent, completeTurn({ answer: '## 第一条完成' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(h.fake.sent[0]!.opts).toEqual({ replyTo: 'om_first' })
  })

  it('resumes a stored generation instead of creating a fresh session', async () => {
    const stored = chatSessionPrefix('oc_chat_1') + '~' + generation
    const workspaces = createFakeWorkspaces([stored])
    const h = await mount({}, { workspaces: workspaces.service })
    h.agents.resumable.add(stored)
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(1) })
    expect(h.agents.resumed).toEqual([stored])
    expect(h.agents.created[0]!.sessionId).toBe(stored)
    expect(h.agents.created[0]!.meta).toBeUndefined()
  })

  it('creates fresh without probing the removed legacy session id', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    expect(h.agents.resumed).toEqual([])
    expect(h.agents.looked).toEqual([])
    expect(created.sessionId.startsWith(chatSessionPrefix('oc_chat_1') + '~')).toBe(true)
  })

  it('does not adopt an agent another owner already published', async () => {
    const stored = chatSessionPrefix('oc_chat_1') + '~' + generation
    const workspaces = createFakeWorkspaces([stored])
    const h = await mount({}, { workspaces: workspaces.service })
    const live = h.agents.declareLive(stored)
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(1) })
    expect(live.followup).not.toHaveBeenCalled()
    expect(h.agents.looked).toContain(stored)
    expect(h.logs.some(line => line.text.includes('foreign live agent skipped: ' + stored))).toBe(true)
  })

  it('gives each topic thread its own agent under chat-thread scope', async () => {
    const h = await mount({ sessionScope: 'chat-thread' })
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1' }))
    await firstAgent(h)
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_in_2', threadId: 'omt_2' }))
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(2) })
    expect(h.agents.created[0]!.sessionId.startsWith(threadSessionPrefix('oc_chat_1', 'omt_1') + '~')).toBe(true)
    expect(h.agents.created[1]!.sessionId.startsWith(threadSessionPrefix('oc_chat_1', 'omt_2') + '~')).toBe(true)
  })
})

describe('per-agent composition', () => {
  it('composes the reply-card prompt, the interaction prompt, and tool guards', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    expect(created.setupRan).toBe(true)
    const names = created.promptSections.map(section => section.name)
    expect(names).toContain('feishu-channel:reply-card')
    expect(names).toContain('feishu-channel:interaction')
    expect(created.denyReason('ask_user_question')).toContain('unavailable')
    expect(created.denyReason('exit_plan_mode')).toContain('unavailable')
    expect(created.denyReason('bash')).toBeUndefined()
  })

  it('joins the configured preset', async () => {
    const presets = createFakePresets(['default', 'researcher'], 'default')
    const h = await mount({ preset: 'researcher' }, { presets: presets.presets })
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    expect(presets.resolved).toContain('researcher')
    expect(created.meta).toEqual(expect.objectContaining({ agentPreset: 'researcher' }))
  })

  it('reads the preset roster once for a resumed conversation', async () => {
    const presets = createFakePresets()
    const stored = chatSessionPrefix('oc_chat_1') + '~' + generation
    const workspaces = createFakeWorkspaces([stored])
    const h = await mount({}, { presets: presets.presets, workspaces: workspaces.service })
    h.agents.resumable.add(stored)
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.agents.resumed).toHaveLength(1) })
    // The resume attempt and the session's renderer share one composition, so
    // the roster is read once, not once per rung.
    expect(presets.resolved).toHaveLength(1)
  })

  it('falls back to the host default model selection', async () => {
    const h = await mount(
      { provider: undefined, model: undefined },
      { defaultModel: { currentSelection: () => ({ provider: 'fallback-provider', model: 'fallback-model' }) } },
    )
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    expect(created.agentOptions).toEqual({ provider: 'fallback-provider', model: 'fallback-model' })
  })

  it('reports a creation failure to the chat instead of running toolless', async () => {
    const presets = createFakePresets(['default'], 'default')
    const h = await mount({ preset: 'nope' }, { presets: presets.presets })
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(JSON.stringify(h.fake.sent[0]!.input)).toContain('无法启动会话')
    expect(h.agents.created).toHaveLength(0)
  })

  it('reports a missing model route at creation', async () => {
    const h = await mount({ provider: undefined, model: undefined })
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const input = h.fake.sent[0]!.input
    expect('text' in input && input.text).toContain('无法启动会话')
    expect('text' in input && input.text).toContain('no model configured')
    expect(h.agents.created).toHaveLength(0)
  })
})

describe('conversation-scope isolation', () => {
  it('retries the exact failed thread even after another thread runs', async () => {
    const h = await mount({ sessionScope: 'chat-thread' })
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1', messageId: 'om_t1', content: 'thread one' }))
    const first = await firstAgent(h)
    emitEvents(h, first.agent, [
      sessionEvent('step/start', { turn: 1, step: 1 }),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_1', message: 'first failed' } } }),
    ])
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })

    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_2', messageId: 'om_t2', content: 'thread two' }))
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(2) })
    const second = h.agents.created[1]!
    emitEvents(h, second.agent, [
      sessionEvent('step/start', { turn: 1, step: 1 }),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_2', message: 'second failed' } } }),
    ])
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(2) })

    const response = await h.fake.emitCardAction(clickAction(
      { kind: RETRY_ACTION },
      { chatId: 'oc_chat_1', messageId: 'om_sent_1' },
    ))
    expect(response).toEqual({ toast: { type: 'success', content: '已重新发起请求' } })
    expect(first.agent.followup).toHaveBeenCalledTimes(2)
    expect(second.agent.followup).toHaveBeenCalledTimes(1)
    expect(first.agent.followup.mock.calls[1]![0]!.content[0]).toEqual({ type: 'text', text: 'thread one' })
  })

  it('keeps model selectors alive independently for two threads in one chat', async () => {
    const api = createFakeModelApi({
      current: { provider: 'provider-a', model: 'model-a' },
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      }],
    })
    const h = await mount({ sessionScope: 'chat-thread' }, { apiProxy: api.api })
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1', messageId: 'om_model_1', content: '/model' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const firstAgentRecord = h.agents.created[0]!
    const firstSelector = selectorFrom(h.fake.sent[0]!.input)

    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_2', messageId: 'om_model_2', content: '/model' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(2) })
    expect(h.agents.created).toHaveLength(2)

    const response = await h.fake.emitCardAction(clickAction(firstSelector.value, {
      chatId: 'oc_chat_1',
      messageId: 'om_sent_1',
      option: firstSelector.options[1]!.value,
    }))
    expect(response).toEqual({ toast: { type: 'info', content: '正在切换模型' } })
    await vi.waitFor(() => { expect(api.selected).toHaveLength(1) })
    expect(api.selected[0]).toEqual({
      sessionId: firstAgentRecord.sessionId,
      provider: 'provider-a',
      model: 'model-b',
    })
  })

  it('resets one thread without replacing another thread agent', async () => {
    const h = await mount({ sessionScope: 'chat-thread' })
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1', messageId: 'om_t1', content: 'first' }))
    const first = await firstAgent(h)
    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_2', messageId: 'om_t2', content: 'second' }))
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(2) })
    const second = h.agents.created[1]!

    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_1', messageId: 'om_new', content: '/new' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(await h.fake.emitCardAction(clickAction(firstButtonValue(h.fake.sent[0]!.input)))).toEqual({
      toast: { type: 'info', content: '正在执行 /new' },
    })
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(3) })
    expect(first.agent.cancel).toHaveBeenCalledWith('user')
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.agent.cancel).not.toHaveBeenCalled()
    expect(second.dispose).not.toHaveBeenCalled()

    await h.fake.emitMessage(fakeMessage({ threadId: 'omt_2', messageId: 'om_t2_next', content: 'still second' }))
    expect(h.agents.created).toHaveLength(3)
    expect(second.agent.followup).toHaveBeenCalledTimes(2)
  })
})

describe('authorization', () => {
  it('refuses direct messages from senders outside the allowlist, silently', async () => {
    const h = await mount({ senderAllowlist: ['ou_allowed'] })
    // The transport policy is narrowed to match: the runtime passes the same
    // allowlist to the port factory.
    expect(h.portAuthorizations[0]!.directSenders).toEqual(['ou_allowed'])
    await h.fake.emitMessage(fakeMessage({ senderId: 'ou_other' }))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(h.agents.created).toHaveLength(0)
    expect(h.fake.sent).toHaveLength(0)
    expect(h.notices.some(line => line.includes('ignored a message'))).toBe(true)
  })

  it('refuses groups outside the allowlist', async () => {
    const h = await mount({ groupAllowlist: ['oc_trusted'] })
    await h.fake.emitMessage(fakeMessage({ chatType: 'group', chatId: 'oc_other' }))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(h.agents.created).toHaveLength(0)
    expect(h.portAuthorizations[0]!.groups).toEqual(['oc_trusted'])
  })

  it('keeps no_mention rejections off the operator console but reports bot loops', async () => {
    const h = await mount()
    h.fake.emitReject({
      messageId: 'om_in_1',
      chatId: 'oc_chat_1',
      senderId: SENDER_ID,
      reason: 'no_mention',
    })
    h.fake.emitReject({
      messageId: 'om_in_2',
      chatId: 'oc_chat_1',
      senderId: 'ou_bot',
      reason: 'bot_loop',
    })
    expect(h.notices.some(line => line.includes('bot loop guard tripped'))).toBe(true)
    expect(h.notices.some(line => line.includes('no_mention'))).toBe(false)
    expect(h.logs.some(line => line.type === 'debug' && line.text.includes('no_mention'))).toBe(true)
  })

  it('reports transport failures and connection state', async () => {
    const h = await mount()
    h.fake.emitError({ name: 'LarkChannelError', code: 'unknown', message: 'boom' })
    expect(h.notices.some(line => line.includes('transport error [unknown]: boom'))).toBe(true)
    h.fake.emitConnectionState('reconnecting')
    expect(h.notices.some(line => line.includes('connection lost'))).toBe(true)
    h.fake.emitConnectionState('reconnected')
    expect(h.notices.some(line => line.includes('connection restored'))).toBe(true)
  })

  it('stops reporting once the fiber unwinds', async () => {
    const h = await mount()
    h.fake.emitError({ name: 'LarkChannelError', code: 'unknown', message: 'boom' })
    // Let the connect-time panel sync finish: its registration notice would
    // otherwise land after the snapshot and look like a leak.
    await vi.waitFor(() => { expect(h.fake.panelCreated.length).toBeGreaterThanOrEqual(6) })
    const before = h.notices.length
    await h.dispose()
    // Unsubscribed: transport events after disposal leave no trace at all.
    h.fake.emitError({ name: 'LarkChannelError', code: 'unknown', message: 'after' })
    h.fake.emitReject({ messageId: 'om_1', chatId: 'oc_chat_1', senderId: SENDER_ID, reason: 'bot_loop' })
    h.fake.emitConnectionState('reconnecting')
    expect(h.notices.length).toBe(before)
  })
})

describe('slash commands', () => {
  it('asks for confirmation before an argument-free command and settles the same card', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ content: '/stop' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(created.agent.cancel).not.toHaveBeenCalled()
    expect(JSON.stringify(h.fake.sent[0]!.input)).toContain('待确认')

    const response = await h.fake.emitCardAction(clickAction(firstButtonValue(h.fake.sent[0]!.input)))
    expect(response).toEqual({ toast: { type: 'info', content: '正在执行 /stop' } })
    await vi.waitFor(() => { expect(created.agent.cancel).toHaveBeenCalledWith('user') })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('已停止当前任务')
  })

  it('collects a host command argument through a CardKit form', async () => {
    const commands = createFakeCommands([{
      name: 'feedback',
      description: '记录反馈',
      input: { hint: '<text>' },
    }])
    const h = await mount({}, { commands: commands.service })
    await h.fake.emitMessage(fakeMessage({ content: '/feedback' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const submitName = formSubmitName(h.fake.sent[0]!.input)
    expect(commands.executed).toEqual([])

    const response = await h.fake.emitCardAction(clickAction(undefined, {
      actionName: submitName,
      formValue: { command_input: '卡片体验很清晰' },
    }))
    expect(response).toEqual({ toast: { type: 'info', content: '正在执行 /feedback' } })
    await vi.waitFor(() => { expect(commands.executed).toEqual(['/feedback 卡片体验很清晰']) })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
  })

  it('opens the selected command inside the existing help card', async () => {
    const commands = createFakeCommands([{
      name: 'feedback',
      description: '记录反馈',
      input: { hint: '<text>' },
    }])
    const h = await mount({}, { commands: commands.service })
    await h.fake.emitMessage(fakeMessage({ content: '/help' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const selector = selectorFrom(h.fake.sent[0]!.input)

    const response = await h.fake.emitCardAction(clickAction(selector.value, {
      option: 'feedback',
    }))

    expect(response).toEqual({ toast: { type: 'info', content: '正在打开 /feedback' } })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('dsh_command_form')
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('/feedback')
    expect(commands.executed).toEqual([])
  })

  it('reads permission options from the session projection and executes the selected preset', async () => {
    const commands = createFakeCommands([{
      name: 'permission',
      description: '切换权限预设',
      input: { hint: '<preset>' },
    }])
    const api = createFakeModelApi({
      current: { provider: 'provider-a', model: 'model-a' },
      groups: [],
    }, {
      currentValue: 'workspace-write',
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
    })
    const h = await mount({}, { commands: commands.service, apiProxy: api.api })
    await h.fake.emitMessage(fakeMessage({ content: '/permission' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const selector = selectorFrom(h.fake.sent[0]!.input)
    expect(selector.options.map(option => option.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])

    const response = await h.fake.emitCardAction(clickAction(selector.value, {
      messageId: 'om_sent_1',
      option: 'read-only',
    }))
    expect(response).toEqual({ toast: { type: 'info', content: '正在切换权限' } })
    await vi.waitFor(() => { expect(commands.executed).toEqual(['/permission read-only']) })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('read-only')
  })

  it('requires a second click before enabling full-access permissions', async () => {
    const commands = createFakeCommands([{
      name: 'permission',
      description: '切换权限预设',
      input: { hint: '<preset>' },
    }])
    const api = createFakeModelApi({
      current: { provider: 'provider-a', model: 'model-a' },
      groups: [],
    }, {
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
    })
    const h = await mount({}, { commands: commands.service, apiProxy: api.api })
    await h.fake.emitMessage(fakeMessage({ content: '/permission' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const selector = selectorFrom(h.fake.sent[0]!.input)

    const firstResponse = await h.fake.emitCardAction(clickAction(selector.value, {
      option: 'danger-full-access',
    }))

    expect(firstResponse).toEqual({ toast: { type: 'info', content: '请再次确认高风险权限' } })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('高风险')
    expect(commands.executed).toEqual([])

    const confirm = firstButtonValue({ card: h.fake.updated[0]!.card })
    const secondResponse = await h.fake.emitCardAction(clickAction(confirm))
    expect(secondResponse).toEqual({ toast: { type: 'info', content: '正在切换权限' } })
    await vi.waitFor(() => {
      expect(commands.executed).toEqual(['/permission danger-full-access'])
    })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(2) })
  })

  it('rejects a command-card click from an operator outside the approver list', async () => {
    const h = await mount({ approvers: ['ou_boss'] })
    await h.fake.emitMessage(fakeMessage({ content: '/stop' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })

    const response = await h.fake.emitCardAction(clickAction(
      firstButtonValue(h.fake.sent[0]!.input),
      { openId: 'ou_intruder' },
    ))

    expect(response).toEqual({ toast: { type: 'error', content: '你无权操作此会话' } })
    expect(created.agent.cancel).not.toHaveBeenCalled()
    expect(h.fake.updated).toEqual([])
  })

  it('expires an older command card when a newer interaction replaces it', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_stop_1', content: '/stop' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const staleAction = firstButtonValue(h.fake.sent[0]!.input)

    await h.fake.emitMessage(fakeMessage({ messageId: 'om_stop_2', content: '/stop' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(2) })
    const response = await h.fake.emitCardAction(clickAction(staleAction, { messageId: 'om_sent_1' }))

    expect(response).toEqual({ toast: { type: 'info', content: '该命令卡已失效' } })
    expect(created.agent.cancel).not.toHaveBeenCalled()
  })

  it('answers unknown commands with the help listing', async () => {
    const commands = createFakeCommands()
    const h = await mount({}, { commands: commands.service })
    await h.fake.emitMessage(fakeMessage({ content: '/frobnicate' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const card = JSON.stringify(h.fake.sent[0]!.input)
    expect(card).toContain('未知命令 /frobnicate')
    expect(card).toContain('/status')
    expect(card).toContain('/model')
  })

  it('reports a failed host command execution', async () => {
    const commands = createFakeCommands(
      [{ name: 'status', description: '查看运行状态' }],
      { status: { kind: 'error', text: 'boom' } },
    )
    const h = await mount({}, { commands: commands.service })
    await h.fake.emitMessage(fakeMessage({ content: '/status' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(commands.executed).toEqual([])
    await h.fake.emitCardAction(clickAction(firstButtonValue(h.fake.sent[0]!.input)))
    await vi.waitFor(() => { expect(commands.executed).toEqual(['/status']) })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('执行失败')
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('boom')
  })

  it('labels a thrown host command as a command failure', async () => {
    const commands = {
      list: () => [{ name: 'permission', description: '切换权限' }],
      async execute(_agent: HostAgent, _line: string, _images: readonly HostCommandImage[], signal: AbortSignal) {
        if (signal.aborted) throw new Error('unexpected abort')
        throw new Error('host command crashed')
      },
    } satisfies HostCommands
    const h = await mount({}, { commands })

    await h.fake.emitMessage(fakeMessage({ content: '/permission read-only' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const card = JSON.stringify(h.fake.sent[0]!.input)
    expect(card).toContain('命令执行失败')
    expect(card).toContain('host command crashed')
    expect(card).not.toContain('无法启动会话')
  })

  it('explains when no session model control service exists', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ content: '/model' }))
    await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(JSON.stringify(h.fake.sent[0]!.input)).toContain('没有会话模型控制服务')
  })

  it('switches the model through the Host API when one is composed', async () => {
    const api = createFakeModelApi({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' },
        }, {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          reasoning: { efforts: [{ id: 'max', name: '最高' }], defaultEffort: 'max' },
        }],
      }],
    })
    const h = await mount({}, { apiProxy: api.api })
    await h.fake.emitMessage(fakeMessage({ content: '/model' }))
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const selector = selectorFrom(h.fake.sent[0]!.input)
    expect(JSON.stringify(h.fake.sent[0]!.input)).toContain('deepseek-official/deepseek-v4-flash')
    const response = await h.fake.emitCardAction(clickAction(selector.value, {
      messageId: 'om_sent_1',
      option: selector.options[1]!.value,
    }))
    expect(response).toEqual({ toast: { type: 'info', content: '正在切换模型' } })
    await vi.waitFor(() => { expect(api.selected).toHaveLength(1) })
    expect(api.selected[0]).toEqual({
      sessionId: created.sessionId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('deepseek-v4-pro')
  })

  it('retires the old generation on /new and settles its pending approval', async () => {
    const workspaces = createFakeWorkspaces()
    const h = await mount({}, { workspaces: workspaces.service })
    await h.fake.emitMessage(fakeMessage({ content: 'hello' }))
    const first = await firstAgent(h)
    const outcome = approvalFor(h, first.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })

    await h.fake.emitMessage(fakeMessage({ messageId: 'om_new', content: '/new' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(2) })
    expect(JSON.stringify(h.fake.sent[1]!.input)).toContain('待确认')
    expect(await h.fake.emitCardAction(clickAction(firstButtonValue(h.fake.sent[1]!.input), {
      messageId: 'om_sent_2',
    }))).toEqual({ toast: { type: 'info', content: '正在执行 /new' } })
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(2) })
    const next = h.agents.created[1]!
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(next.sessionId.startsWith(chatSessionPrefix('oc_chat_1') + '~')).toBe(true)
    expect(first.agent.cancel).toHaveBeenCalledWith('user')
    expect(first.dispose).toHaveBeenCalled()
    expect(workspaces.detached).toContain(first.sessionId)
    expect(await outcome).toBe('cancelled')
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(2) })
    expect(h.fake.updated.some(update => JSON.stringify(update.card).includes('已撤回'))).toBe(true)
    expect(h.fake.updated.some(update => JSON.stringify(update.card).includes('已新建空白会话'))).toBe(true)
    expect(workspaces.sessionIds).toEqual([next.sessionId])
  })
})

describe('approval cards', () => {
  it('grants once through the allow button', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const values = approvalValueFromCard(cardOf(h.fake.sent[0]!))
    const allow = values.find(value => value.decision === 'allow')!
    const response = await h.fake.emitCardAction(clickAction(allow))
    expect(response).toEqual({ toast: { type: 'success', content: '已允许执行一次' } })
    expect(await outcome).toBe('allowed-once')
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    const settled = JSON.stringify(h.fake.updated[0]!.card)
    expect(settled).toContain('已允许')
    expect(settled).toContain('操作人')
  })

  it('rejects through the reject button', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const reject = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'reject')!
    const response = await h.fake.emitCardAction(clickAction(reject))
    expect(response).toEqual({ toast: { type: 'info', content: '已拒绝' } })
    expect(await outcome).toBe('rejected')
  })

  it('refuses clicks from another chat and names no approver boundary', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const allow = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'allow')!
    const foreign = await h.fake.emitCardAction(clickAction(allow, { chatId: 'oc_other' }))
    expect(foreign).toEqual({ toast: { type: 'error', content: '你无权批准此操作' } })
    // Still pending: the owner's click later decides it.
    const owner = await h.fake.emitCardAction(clickAction(allow))
    expect(owner).toEqual({ toast: { type: 'success', content: '已允许执行一次' } })
    expect(await outcome).toBe('allowed-once')
  })

  it('restricts clicks to named approvers when configured', async () => {
    const h = await mount({ approvers: ['ou_boss'] })
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const allow = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'allow')!
    expect(await h.fake.emitCardAction(clickAction(allow))).toEqual({
      toast: { type: 'error', content: '你无权批准此操作' },
    })
    expect(await h.fake.emitCardAction(clickAction(allow, { openId: 'ou_boss' }))).toEqual({
      toast: { type: 'success', content: '已允许执行一次' },
    })
    expect(await outcome).toBe('allowed-once')
  })

  it('answers stale and foreign card actions without settling', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    // A card action from another plugin is ignored entirely.
    expect(await h.fake.emitCardAction(clickAction({ some: 'other-plugin' }))).toBeUndefined()
    const allow = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'allow')!
    await h.fake.emitCardAction(clickAction(allow))
    expect(await outcome).toBe('allowed-once')
    // The question is settled; a second click gets the stale toast.
    expect(await h.fake.emitCardAction(clickAction(allow))).toEqual({
      toast: { type: 'info', content: '该审批已失效' },
    })
  })

  it('settles a withdrawn question as cancelled', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const controller = new AbortController()
    const outcome = approvalFor(h, created.agent, { signal: controller.signal })
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    controller.abort()
    expect(await outcome).toBe('cancelled')
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('已撤回')
  })

  it('delegates when the card cannot be sent', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    h.fake.state.failNextSend = true
    const outcome = approvalFor(h, created.agent)
    expect(await outcome).toBe('unavailable')
  })

  it('answers chat approvals before a competing answerer, but delegates foreign ones', async () => {
    const competing = { claims: [] as { toolName: string }[] }
    const h = await mount({}, { competingAnswerer: competing })
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)

    // The plugin's listener is prepended: the BFF-style answerer is never
    // consulted for a chat-owned question, or the chat would wait forever.
    const owned = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const allow = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'allow')!
    await h.fake.emitCardAction(clickAction(allow))
    expect(await owned).toBe('allowed-once')
    expect(competing.claims).toHaveLength(0)

    // A question about an agent this channel does not own delegates onward.
    const foreign = {
      id: 'foreign',
      session: { id: 'foreign', requestContext: () => undefined },
      followup: () => {},
      cancel: () => {},
    }
    const outcome = await h.ctx.waterfall('approval/request', {
      agent: foreign as HostApprovalRequest['agent'],
      toolName: 'bash',
    } as HostApprovalRequest, async (): Promise<HostApprovalOutcome> => 'unavailable')
    expect(outcome).toBe('unavailable')
    expect(competing.claims).toEqual([{ toolName: 'bash' }])
  })

  it('shows the pending call arguments on the card, bounded and cleared per turn', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    // The turn's tool call publishes its arguments before the question arrives.
    emitEvents(h, created.agent, [sessionEvent('tool/call', {
      turn: 1,
      callId: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"rm -rf build"}',
    })])
    const withCommand = approvalFor(h, created.agent, { callId: 'call_1' })
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(JSON.stringify(h.fake.sent[0]!.input)).toContain('rm -rf build')
    const allow = approvalValueFromCard(cardOf(h.fake.sent[0]!)).find(value => value.decision === 'allow')!
    await h.fake.emitCardAction(clickAction(allow))
    expect(await withCommand).toBe('allowed-once')

    // Turn end forgets the turn's calls. A second Feishu-submitted turn may
    // own another question, but it cannot inherit the first turn's command.
    emitEvents(h, created.agent, [sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    await h.fake.emitMessage(fakeMessage({ messageId: 'om_second', content: 'next turn' }))
    const withoutCommand = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(3) })
    expect(JSON.stringify(h.fake.sent[2]!.input)).not.toContain('rm -rf build')
    const reject = approvalValueFromCard(cardOf(h.fake.sent[2]!)).find(value => value.decision === 'reject')!
    await h.fake.emitCardAction(clickAction(reject, { messageId: 'om_sent_3' }))
    expect(await withoutCommand).toBe('rejected')
  })
})

describe('session events render into the rich card', () => {
  it('streams one card per turn and settles it at turn end', async () => {
    const tools = createFakeTools({ exec_command: () => ({ title: '执行命令' }) })
    const h = await mount({}, { tools: tools.service })
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    emitEvents(h, created.agent, completeTurn({ toolTitle: '执行命令' }))
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const card = JSON.stringify(h.fake.sent[0]!.input)
    expect(card).toContain('结论已经给出')
    expect(card).toContain('执行命令')
    // No second card: the same card was updated in place.
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    expect(h.fake.sent).toHaveLength(1)
  })

  it('keeps foreign sessions out of the chat', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    h.ctx.emit('session/event', { id: 'foreign-session', requestContext: () => undefined }, sessionEvent('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'ignore me' }] },
    }))
    emitEvents(h, created.agent, completeTurn())
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(JSON.stringify(h.fake.sent[0]!.input)).not.toContain('ignore me')
  })

  it('renders a failed turn as a failure card with retry and copy actions', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage({ content: 'run it' }))
    const created = await firstAgent(h)
    emitEvents(h, created.agent, [
      sessionEvent('step/start', { turn: 1, step: 1 }),
      sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'E_X', message: 'boom' } },
      }),
    ])
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    const card = JSON.stringify(h.fake.sent[0]!.input)
    expect(card).toContain('失败')
    expect(card).toContain('E_X')
    expect(card).toContain('boom')
    expect(card).toContain(RETRY_ACTION)
    expect(card).toContain(COPY_ERROR_ACTION)

    // The copy-error click surfaces the error text as a toast.
    const copy = await h.fake.emitCardAction(clickAction({ kind: COPY_ERROR_ACTION, text: 'E_X: boom' }))
    expect(copy).toEqual({ toast: { type: 'info', content: 'E_X: boom' } })

    // The retry click replays the last user message on the same card.
    const retriedId = 'om_sent_1'
    const retry = await h.fake.emitCardAction(clickAction({ kind: RETRY_ACTION }, { messageId: retriedId }))
    expect(retry).toEqual({ toast: { type: 'success', content: '已重新发起请求' } })
    expect(created.agent.followup).toHaveBeenCalledTimes(2)
    const replayed = created.agent.followup.mock.calls[1]![0]!
    expect(replayed.id).not.toBe(created.agent.followup.mock.calls[0]![0]!.id)
    expect(replayed.content[0]).toEqual({ type: 'text', text: 'run it' })

    // The replayed turn reuses the failed card's message id.
    emitEvents(h, created.agent, completeTurn({ answer: '## 重试成功' }))
    await vi.waitFor(() => { expect(h.fake.updated).toHaveLength(1) })
    expect(h.fake.updated[0]!.messageId).toBe(retriedId)
    expect(JSON.stringify(h.fake.updated[0]!.card)).toContain('重试成功')
  })
})

describe('images', () => {
  const imageMessage = () => fakeMessage({
    content: 'look at this',
    resources: [{ type: 'image', fileKey: 'img_1', fileName: 'a.png' }],
  })

  it('refuses images when the current model lacks image input', async () => {
    const h = await mount({}, {
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    })
    h.agentsControls.requestContext = { provider: 'fake', model: 'text-only-model' }
    await h.fake.emitMessage(imageMessage())
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    const text = created.agent.followup.mock.calls[0]![0]!.content[0]!
    expect(text).toEqual({
      type: 'text',
      text: 'look at this\n（用户发送了 1 张图片：当前模型 text-only-model 不支持图片输入，未传递图片；可用 /model 切换视觉模型后重发）',
    })
    expect(created.agent.followup.mock.calls[0]![0]!.content).toHaveLength(1)
  })

  it('downloads and attaches images when the model admits them', async () => {
    const attachments = createFakeAttachments()
    const h = await mount({}, {
      attachments: attachments.service,
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    })
    h.agentsControls.requestContext = { provider: 'fake', model: 'vision-model' }
    h.fake.resourceBytes.set('img_1', { buffer: new Uint8Array([1, 2, 3]), contentType: 'image/png' })
    await h.fake.emitMessage(imageMessage())
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    const content = created.agent.followup.mock.calls[0]![0]!.content
    expect(content[0]).toEqual({ type: 'text', text: 'look at this' })
    expect(content[1]).toEqual(expect.objectContaining({ type: 'image' }))
    expect((content[1] as { attachment: { attachmentId: string } }).attachment.attachmentId).toBe('att_1')
    expect(attachments.saved).toEqual([{ mediaType: 'image/png', bytes: 3, name: 'a.png' }])
  })

  it('admits images when no model facts are available (parity with the web path)', async () => {
    const attachments = createFakeAttachments()
    const h = await mount({}, { attachments: attachments.service })
    h.fake.resourceBytes.set('img_1', { buffer: new Uint8Array([7]), contentType: 'image/jpeg' })
    await h.fake.emitMessage(imageMessage())
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    const content = created.agent.followup.mock.calls[0]![0]!.content
    expect(content[1]).toEqual(expect.objectContaining({ type: 'image' }))
    expect(attachments.saved).toEqual([{ mediaType: 'image/jpeg', bytes: 1, name: 'a.png' }])
  })

  it('leaves a note when an image cannot be downloaded', async () => {
    const h = await mount({}, { attachments: createFakeAttachments().service, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } })
    h.agentsControls.requestContext = { provider: 'fake', model: 'vision-model' }
    await h.fake.emitMessage(imageMessage())
    const created = await firstAgent(h)
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(1) })
    const text = created.agent.followup.mock.calls[0]![0]!.content[0]!
    expect(text).toEqual({
      type: 'text',
      text: 'look at this\n（一张图片附加失败：no such resource img_1 on om_in_1 (fake)）',
    })
  })
})

describe('slash panel sync', () => {
  it('registers the channel commands after connect and after the first agent', async () => {
    const h = await mount()
    await vi.waitFor(() => {
      expect(h.fake.panelCreated).toEqual(expect.arrayContaining(['new', 'reset', 'stop', 'model', 'effort', 'help']))
    })
    expect(h.notices.some(line => line.includes('registered /new'))).toBe(true)
    // The panel now offers exactly what the channel accepts.
    expect(h.fake.panelCommands).toEqual(expect.arrayContaining(['new', 'reset', 'stop', 'model', 'effort', 'help']))
  })

  it('re-syncs on commands/change without duplicating registrations', async () => {
    const h = await mount()
    await vi.waitFor(() => { expect(h.fake.panelCreated.length).toBeGreaterThanOrEqual(6) })
    await h.fake.emitMessage(fakeMessage())
    await firstAgent(h)
    const before = h.fake.panelCreated.length
    h.ctx.emit('commands/change')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(h.fake.panelCreated.length).toBe(before)
  })
})

describe('disposal', () => {
  it('disconnects after a pending initial connection settles', async () => {
    const h = await mount({}, {
      configurePort: (fake) => { fake.controls.delayNextConnect() },
    })
    await vi.waitFor(() => { expect(h.fake.state.connecting).toBe(true) })

    const disposing = h.dispose()
    harness = undefined
    h.fake.controls.releaseConnect()
    await disposing

    expect(h.fake.state.connected).toBe(false)
    expect(h.fake.state.disconnects).toBe(1)
    expect(h.fake.panelCreated).toEqual([])
  })

  it('disconnects the transport, disposes owned agents, and cancels open approvals', async () => {
    const h = await mount()
    await h.fake.emitMessage(fakeMessage())
    const created = await firstAgent(h)
    const outcome = approvalFor(h, created.agent)
    await vi.waitFor(() => { expect(h.fake.sent).toHaveLength(1) })
    expect(h.fake.state.connects).toBe(1)

    await h.dispose()
    expect(h.fake.state.disconnects).toBe(1)
    expect(created.dispose).toHaveBeenCalledTimes(1)
    expect(await outcome).toBe('cancelled')
  })

  it('leaves agents another owner published running', async () => {
    const stored = chatSessionPrefix('oc_chat_1') + '~' + generation
    const workspaces = createFakeWorkspaces([stored])
    const h = await mount({}, { workspaces: workspaces.service })
    const foreign = h.agents.declareLive(stored)
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.agents.looked).toContain(stored) })
    await h.dispose()
    expect(h.fake.state.disconnects).toBe(1)
    expect(foreign.cancel).not.toHaveBeenCalled()
    expect(h.agents.created[0]!.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('first-boot onboarding', () => {
  it('runs the QR flow without credentials, persists, and connects', async () => {
    const settings = createFakeSettings()
    const registerApp = vi.fn(async (request: Parameters<RegisterAppPort>[0]) => {
      request.onQRCodeReady({ url: 'https://qr.example', expireIn: 300 })
      return { client_id: 'cli_new', client_secret: 'sec_new', user_info: { open_id: 'ou_owner' } }
    })
    // The QR path is the explicit `undefined` third argument; the default
    // parameter would supply credentials instead.
    harness = await mountChannel({}, { settings: settings.settings, registerApp }, undefined)
    const h = harness
    await vi.waitFor(() => { expect(registerApp).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(h.notices.some(line => line.includes('扫码注册流程'))).toBe(true) })
    await vi.waitFor(() => { expect(h.notices.some(line => line.includes('https://qr.example'))).toBe(true) })
    await vi.waitFor(() => { expect(h.fake.state.connects).toBe(1) })
    expect(settings.registered.map(entry => entry.ns)).toContain('feishu-channel')
    expect(settings.updates).toEqual([{ appId: 'cli_new', appSecret: 'sec_new', registeredBy: 'ou_owner' }])
    // The channel is live under the onboarded credentials.
    await h.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(h.agents.created).toHaveLength(1) })
  })

  it('does not persist or start the channel when registration settles after disposal', async () => {
    const settings = createFakeSettings()
    let request: Parameters<RegisterAppPort>[0] | undefined
    let finish!: (value: { client_id: string; client_secret: string }) => void
    const registerApp: RegisterAppPort = vi.fn(options => {
      request = options
      return new Promise<{ client_id: string; client_secret: string }>(resolve => { finish = resolve })
    })
    harness = await mountChannel({}, { settings: settings.settings, registerApp }, undefined)
    const h = harness
    await vi.waitFor(() => { expect(request).toBeDefined() })

    await h.dispose()
    harness = undefined
    expect(request!.signal.aborted).toBe(true)
    finish({ client_id: 'cli_late', client_secret: 'sec_late' })
    await Promise.resolve()
    await Promise.resolve()

    expect(settings.updates).toEqual([])
    expect(h.fake.state.connects).toBe(0)
    expect(h.notices.some(line => line.includes('扫码成功'))).toBe(false)
  })
})

/** Extract the model-selector action payload from a sent card. */
function selectorFrom(input: unknown): {
  readonly value: unknown
  readonly options: readonly { readonly value: string }[]
} {
  const card = (input as { card: { elements: readonly { tag: string; actions?: readonly unknown[] }[] } }).card
  const action = card.elements.find(element => element.tag === 'action')?.actions?.[0]
  return action as { readonly value: unknown; readonly options: readonly { readonly value: string }[] }
}

/** Extract the first ordinary button callback from one command card. */
function firstButtonValue(input: unknown): unknown {
  const card = (input as { card: { elements: readonly { tag: string; actions?: readonly { value: unknown }[] }[] } }).card
  return card.elements.find(element => element.tag === 'action')?.actions?.[0]?.value
}

/** Extract the submit button name from one CardKit command form. */
function formSubmitName(input: unknown): string {
  const card = (input as {
    card: { elements: readonly { tag: string; elements?: readonly { tag: string; name?: string }[] }[] }
  }).card
  const name = card.elements.find(element => element.tag === 'form')?.elements
    ?.find(element => element.tag === 'button')?.name
  if (name === undefined) throw new Error('command form has no submit button')
  return name
}

/** The card object one sent message carried. */
function cardOf(sent: { input: unknown }): object {
  return (sent.input as { card: object }).card
}
