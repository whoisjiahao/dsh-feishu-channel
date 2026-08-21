/**
 * Shared parsing of the host model directory: the provider-group flattening,
 * the current-model lookup, and the stable provider/model route label. Both
 * the command surface (commands.ts) and the model-setting card (model-card.ts)
 * derive their options from the same directory facts; one non-conceptual
 * helper keeps the two surfaces from drifting apart.
 * @module dsh-feishu-channel/model-catalog
 */

import type { HostCatalogModel, HostModelDirectory, HostModelSelection } from './host.ts'

/** One advertised model, with the provider group it belongs to. */
export interface CatalogEntry {
  readonly provider: string
  readonly model: HostCatalogModel
}

/** Stable provider/model label used in command output and card options. */
export function route(selection: Pick<HostModelSelection, 'provider' | 'model'>): string {
  return selection.provider + '/' + selection.model
}

/** Flatten the advisory directory without losing provider identity. */
export function catalog(directory: HostModelDirectory): CatalogEntry[] {
  return directory.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model })))
}

/** The current model's advertised metadata, when it appears in the advisory directory. */
export function currentModel(directory: HostModelDirectory): HostCatalogModel | undefined {
  return directory.groups
    .find(group => group.id === directory.current.provider)
    ?.models.find(model => model.id === directory.current.model)
}
