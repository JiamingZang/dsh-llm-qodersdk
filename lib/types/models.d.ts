/**
 * Live model catalog retrieval from the local Qoder CLI. One short-lived
 * inner session sends the SDK's `get_models` control request; the response
 * (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static catalog is the fallback
 * while the CLI is unreachable.
 * @module dsh-llm-qoder/models
 */
import type { ModelInfo } from '@qoder-ai/qoder-agent-sdk';
import type { QoderCatalogModel } from './catalog.ts';
/** How long a fetched catalog stays fresh by default. */
export declare const DEFAULT_MODEL_CACHE_TTL_MS: number;
/** Cached live CLI catalog with a static fallback. */
export declare class QoderModelCatalog {
    private readonly ttlMs;
    private cached;
    private inflight;
    /** @param ttlMs - how long a fetched catalog stays fresh before a re-fetch. */
    constructor(ttlMs: number);
    /** Raw live entries; the stale snapshot when a refresh fails, else nothing. */
    liveModels(): Promise<readonly ModelInfo[]>;
    /** dsh catalog entries: the enabled live list, or the static fallback. */
    models(): Promise<readonly QoderCatalogModel[]>;
    private fetch;
}
//# sourceMappingURL=models.d.ts.map