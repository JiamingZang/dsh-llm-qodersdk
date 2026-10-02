/**
 * Static Qoder model catalog, captured from `getAvailableModels()` on one
 * account (2026-08). Fallback only when the live CLI catalog is unreachable:
 * the served catalog comes from {@link import('./models.ts').QoderModelCatalog},
 * and requests carry any model id through to the SDK's per-session
 * `resolveModel`, where unknown ids fall back to `auto`.
 * @module dsh-llm-qoder/catalog
 */
import type { ModelSource } from '@qoder-ai/qoder-agent-sdk';
/** One Qoder CLI model entry. */
export interface QoderCatalogModel {
    id: string;
    name: string;
    description?: string;
    /** Where the model came from: `user` and `custom` mark account-added models. */
    source?: ModelSource;
    /**
     * Whether the CLI reports vision input for this model. Only a live catalog
     * entry can carry it: the static fallback below declares no capability it
     * could not verify, so an unreachable CLI never advertises image input.
     */
    isVl?: boolean;
}
/** Default combined context capacity assumed for Qoder-backed models. */
export declare const DEFAULT_CONTEXT_WINDOW = 200000;
/** Default per-request output cap assumed for Qoder-backed models. */
export declare const DEFAULT_MAX_TOKENS = 32000;
/** Every model the account exposed at capture time, in SDK display order. */
export declare const QODER_MODELS: readonly QoderCatalogModel[];
/**
 * Convenience aliases so a dsh deployment can keep using its own DeepSeek
 * model names against the Qoder route.
 */
export declare const MODEL_ALIASES: Readonly<Record<string, string>>;
/**
 * Map a dsh-side model id onto a Qoder SDK model value.
 * @param model - model id from {@link import('@deepseek-ai/dsh-llm').GenerateOptions.model}.
 * @returns the Qoder model value: an alias expansion, or the id with any
 *   `qoder-` prefix stripped; the CLI falls back to `auto` for unknown values.
 */
export declare function resolveQoderModelId(model: string): string;
//# sourceMappingURL=catalog.d.ts.map