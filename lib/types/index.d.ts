/**
 * Register {@link QoderAdapter} for the `qoder` and `qoder-byok` provider
 * routes on `ctx.llm`. The inner sessions ride on the local `qodercli` login
 * state through the qoder-agent-sdk: the advertised model catalog is fetched
 * live from the CLI and split into the account's built-in models (`qoder`)
 * and its custom models (`qoder-byok`), every model is addressable by its SDK
 * value (plus the two `deepseek-v4-*` aliases), and warm inner sessions close
 * with the plugin.
 * @module dsh-llm-qoder
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { QoderAdapter, QODER_PROVIDER, QODER_BYOK_PROVIDER } from './adapter.ts';
export type { ImageRequestReader, QoderAdapterOptions } from './adapter.ts';
export { QoderSession, QoderSessionManager } from './session.ts';
export { QODER_MODELS, resolveQoderModelId } from './catalog.ts';
export { QoderModelCatalog } from './models.ts';
export declare const name = "llm-qoder";
export declare const inject: string[];
/** Plugin config; the adapter works entirely off local qodercli auth. */
export interface Config {
    /** Maximum simultaneously warm inner qodercli sessions. */
    maxSessions?: number;
    /** Seconds a fetched CLI model catalog stays fresh before re-fetching. */
    modelCacheTtlSeconds?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map