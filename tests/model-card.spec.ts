import { describe, expect, it } from 'vitest'
import {
  MODEL_SETTING_ACTION,
  modelSettingActionValue,
  modelSettingCard,
  modelSettingChoices,
  failedModelSettingCard,
  settledModelSettingCard,
} from '../src/model-card.ts'
import type { HostModelDirectory } from '../src/host.ts'

const directory: HostModelDirectory = {
  current: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  },
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      reasoning: {
        efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最高' }],
        defaultEffort: 'high',
      },
    }, {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      reasoning: { efforts: [{ id: 'max', name: '最高' }], defaultEffort: 'max' },
    }],
  }],
}

describe('model setting cards', () => {
  it('shows the current model and returns only advertised model selections', () => {
    const choices = modelSettingChoices(directory, 'model')
    const card = modelSettingCard(directory, 'model', 'picker-1', choices) as any

    expect(choices[1]).toEqual({
      value: 'deepseek-official/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro · DeepSeek',
      selection: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })
    expect(card).not.toHaveProperty('header')
    expect(card.elements[0].text.content).toContain("<text_tag color='blue'>请选择</text_tag>")
    expect(card.elements[1]).toEqual({ tag: 'hr' })
    expect(card.elements[2].fields).toEqual([
      { is_short: true, text: { tag: 'lark_md', content: '**当前模型**' } },
      { is_short: true, text: { tag: 'plain_text', content: 'deepseek-v4-flash' } },
    ])
    expect(card.elements[3].fields).toEqual([
      { is_short: true, text: { tag: 'lark_md', content: '**提供方**' } },
      { is_short: true, text: { tag: 'plain_text', content: 'deepseek-official' } },
    ])
    expect(card.elements[4].actions[0]).toMatchObject({
      tag: 'select_static',
      value: { kind: MODEL_SETTING_ACTION, id: 'picker-1' },
    })
    expect(card.elements[4].actions[0]).not.toHaveProperty('width')
  })

  it('shows the current effort and offers default plus advertised efforts', () => {
    const choices = modelSettingChoices(directory, 'effort')
    const card = modelSettingCard(directory, 'effort', 'picker-2', choices) as any

    expect(choices.map(choice => choice.value)).toEqual(['default', 'high', 'max'])
    expect(card.elements[2].fields[1].text).toEqual({ tag: 'plain_text', content: 'high' })
  })

  it('uses the same neutral compact hierarchy for a settled result', () => {
    const card = settledModelSettingCard('effort', {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }) as any

    expect(card).not.toHaveProperty('header')
    expect(card.elements[0].text.content).toBe(
      "**推理强度**  <text_tag color='green'>已完成</text_tag>",
    )
    expect(card.elements[1]).toEqual({ tag: 'hr' })
    expect(card.elements[2].fields).toEqual([
      { is_short: true, text: { tag: 'lark_md', content: '**当前强度**' } },
      { is_short: true, text: { tag: 'plain_text', content: 'max' } },
    ])
  })

  it('rejects unrelated or malformed callback values', () => {
    expect(modelSettingActionValue({ kind: MODEL_SETTING_ACTION, id: 'picker' })).toEqual({
      kind: MODEL_SETTING_ACTION,
      id: 'picker',
    })
    expect(modelSettingActionValue({ kind: MODEL_SETTING_ACTION })).toBeUndefined()
    expect(modelSettingActionValue({ kind: 'other', id: 'picker' })).toBeUndefined()
  })

  it('renders a bounded static retry card when applying a choice fails', () => {
    const card = failedModelSettingCard('effort', 'x'.repeat(400)) as any
    expect(card).not.toHaveProperty('header')
    expect(card.elements[0].text.content).toContain("<text_tag color='red'>失败</text_tag>")
    expect(card.elements[2].text.content).toHaveLength(300)
    expect(card.elements[3].elements[0].content).toContain('/effort')
  })
})
