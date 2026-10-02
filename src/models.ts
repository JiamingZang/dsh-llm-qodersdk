/**
 * Live model catalog retrieval from the local Qoder CLI. One short-lived
 * inner session sends the SDK's `get_models` control request; the response
 * (including account-custom models) stays fresh for a TTL, concurrent
 * callers share one in-flight fetch, and the static catalog is the fallback
 * while the CLI is unreachable.
 * @module dsh-llm-qoder/models
 */

import type { ModelInfo } from '@qoder-ai/qoder-agent-sdk'
import { qodercliAuth, query } from '@qoder-ai/qoder-agent-sdk'
import type { QoderCatalogModel } from './catalog.ts'
import { QODER_MODELS } from './catalog.ts'

/** How long a fetched catalog stays fresh by default. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000
/** Give up on one CLI catalog fetch after this long. */
const FETCH_TIMEOUT_MS = 20_000

/** One fetched catalog snapshot with its freshness stamp. */
interface CatalogSnapshot {
  at: number
  models: readonly ModelInfo[]
}

/** Cached live CLI catalog with a static fallback. */
export class QoderModelCatalog {
  private cached: CatalogSnapshot | undefined
  private inflight: Promise<readonly ModelInfo[]> | undefined

  /** @param ttlMs - how long a fetched catalog stays fresh before a re-fetch. */
  constructor(private readonly ttlMs: number) {}

  /** Raw live entries; the stale snapshot when a refresh fails, else nothing. */
  async liveModels(): Promise<readonly ModelInfo[]> {
    const cached = this.cached
    if (cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached.models
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined })
    try {
      const models = await this.inflight
      this.cached = { at: Date.now(), models }
      return models
    } catch {
      return this.cached?.models ?? []
    }
  }

  /** dsh catalog entries: the enabled live list, or the static fallback. */
  async models(): Promise<readonly QoderCatalogModel[]> {
    const live = (await this.liveModels()).filter(model => model.isEnabled !== false)
    if (live.length === 0) return QODER_MODELS
    return live.map(model => ({
      id: model.value,
      name: model.displayName.length > 0 ? model.displayName : model.value,
      ...model.description.length > 0 ? { description: model.description } : {},
      ...model.source === undefined ? {} : { source: model.source },
      // Carry only a verified affirmative: a false or absent flag stays off the
      // entry, so a non-VL live model and the static fallback look identical.
      ...model.isVl === true ? { isVl: true } : {},
    }))
  }

  private async fetch(): Promise<readonly ModelInfo[]> {
    const q = query({
      prompt: inertInput(),
      options: { auth: qodercliAuth(), tools: [], allowedTools: [], settingSources: [], maxTurns: 1 },
    })
    try {
      return await withTimeout(q.getAvailableModels({ fetchStrategy: 'live' }), FETCH_TIMEOUT_MS)
    } finally {
      await q.close().catch(() => undefined)
    }
  }
}

/** Streaming prompt that never yields, so no model turn runs during the fetch. */
async function* inertInput(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`qoder model catalog fetch timed out after ${ms}ms`)) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
