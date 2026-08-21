/**
 * Shared parsing of the host model directory: the provider-group flattening,
 * the current-model lookup, and the stable provider/model route label. Both
 * the command surface (commands.ts) and the model-setting card (model-card.ts)
 * derive their options from the same directory facts; one non-conceptual
 * helper keeps the two surfaces from drifting apart.
 * @module dsh-feishu-channel/model-catalog
 */
import type { HostCatalogModel, HostModelDirectory, HostModelSelection } from './host.ts';
/** One advertised model, with the provider group it belongs to. */
export interface CatalogEntry {
    readonly provider: string;
    readonly model: HostCatalogModel;
}
/** Stable provider/model label used in command output and card options. */
export declare function route(selection: Pick<HostModelSelection, 'provider' | 'model'>): string;
/** Flatten the advisory directory without losing provider identity. */
export declare function catalog(directory: HostModelDirectory): CatalogEntry[];
/** The current model's advertised metadata, when it appears in the advisory directory. */
export declare function currentModel(directory: HostModelDirectory): HostCatalogModel | undefined;
//# sourceMappingURL=model-catalog.d.ts.map