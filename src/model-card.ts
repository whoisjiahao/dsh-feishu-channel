/** Interactive Feishu cards for inspecting and changing one session's model settings. */

import type { HostModelDirectory, HostModelSelection } from './host.ts'
import { currentModel, route } from './model-catalog.ts'
import {
  interactiveCard,
  interactiveDivider,
  interactiveFieldRow,
  interactiveStatusLine,
} from './card-design.ts'

/** Marker distinguishing model-setting selectors from other card actions. */
export const MODEL_SETTING_ACTION = 'dsh-feishu-channel/model-setting'

/** Which setting one selector changes. */
export type ModelSettingKind = 'model' | 'effort'

/** One server-approved option shown by a model-setting selector. */
export interface ModelSettingChoice {
  readonly value: string
  readonly label: string
  readonly selection: HostModelSelection
}

/** Compact callback payload; the actual allowed selections remain server-side. */
export interface ModelSettingActionValue {
  readonly kind: typeof MODEL_SETTING_ACTION
  readonly id: string
}

/** Narrow one arbitrary card-action value to a model-setting callback. */
export function modelSettingActionValue(value: unknown): ModelSettingActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== MODEL_SETTING_ACTION || typeof record.id !== 'string') return undefined
  return { kind: MODEL_SETTING_ACTION, id: record.id }
}

function settingLabel(kind: ModelSettingKind): string {
  return kind === 'model' ? '模型设置' : '推理强度'
}

/** Build exact server-approved choices for one selector. */
export function modelSettingChoices(
  directory: HostModelDirectory,
  kind: ModelSettingKind,
): ModelSettingChoice[] {
  if (kind === 'model') {
    return directory.groups.flatMap(group => group.models.map(model => ({
      value: route({ provider: group.id, model: model.id }),
      label: model.name + ' · ' + group.name,
      selection: {
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort }),
      },
    })))
  }

  const reasoning = currentModel(directory)?.reasoning
  return [
    {
      value: 'default',
      label: '模型默认'
        + (reasoning?.defaultEffort === undefined ? '' : '（' + reasoning.defaultEffort + '）'),
      selection: {
        provider: directory.current.provider,
        model: directory.current.model,
        ...(reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: reasoning.defaultEffort }),
      },
    },
    ...(reasoning?.efforts ?? []).map(effort => ({
      value: effort.id,
      label: effort.name + '（' + effort.id + '）',
      selection: {
        provider: directory.current.provider,
        model: directory.current.model,
        reasoningEffort: effort.id,
      },
    })),
  ]
}

/** Build a native Feishu dropdown card showing the current value and choices. */
export function modelSettingCard(
  directory: HostModelDirectory,
  kind: ModelSettingKind,
  id: string,
  choices: readonly ModelSettingChoice[],
): object {
  const title = kind === 'model' ? '选择模型' : '选择推理强度'
  const currentRows = kind === 'model'
    ? [
        interactiveFieldRow('当前模型', directory.current.model),
        interactiveFieldRow('提供方', directory.current.provider),
      ]
    : [interactiveFieldRow('当前强度', directory.current.reasoningEffort ?? '模型默认')]
  return interactiveCard([
    interactiveStatusLine(settingLabel(kind), '请选择', 'info'),
    interactiveDivider(),
    ...currentRows,
    {
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: title },
        options: choices.map(choice => ({
          text: { tag: 'plain_text', content: choice.label },
          value: choice.value,
        })),
        value: { kind: MODEL_SETTING_ACTION, id },
      }],
    },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '选择后将作用于当前会话的下一条消息。' }] },
  ])
}

/** Replace a used selector with an unambiguous settled result. */
export function settledModelSettingCard(kind: ModelSettingKind, selected: HostModelSelection): object {
  const rows = kind === 'model'
    ? [
        interactiveFieldRow('当前模型', selected.model),
        interactiveFieldRow('提供方', selected.provider),
        ...(selected.reasoningEffort === undefined
          ? []
          : [interactiveFieldRow('推理强度', selected.reasoningEffort)]),
      ]
    : [interactiveFieldRow('当前强度', selected.reasoningEffort ?? '模型默认')]
  return interactiveCard([
    interactiveStatusLine(settingLabel(kind), '已完成', 'success'),
    interactiveDivider(),
    ...rows,
  ])
}

/** Replace a failed selector with a clear retry instruction. */
export function failedModelSettingCard(kind: ModelSettingKind, detail: string): object {
  return interactiveCard([
    interactiveStatusLine(settingLabel(kind), '失败', 'failure'),
    interactiveDivider(),
    { tag: 'div', text: { tag: 'plain_text', content: detail.slice(0, 300) } },
    {
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: '请重新输入 /' + (kind === 'model' ? 'model' : 'effort') + '再试。',
      }],
    },
  ])
}
