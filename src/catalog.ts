/**
 * Static Qoder model catalog, captured from `getAvailableModels()` on one
 * account (2026-08). Fallback only when the live CLI catalog is unreachable:
 * the served catalog comes from {@link import('./models.ts').QoderModelCatalog},
 * and requests carry any model id through to the SDK's per-session
 * `resolveModel`, where unknown ids fall back to `auto`.
 * @module dsh-llm-qoder/catalog
 */

import type { ModelSource } from '@qoder-ai/qoder-agent-sdk'

/** One Qoder CLI model entry. */
export interface QoderCatalogModel {
  id: string
  name: string
  description?: string
  /** Where the model came from: `user` and `custom` mark account-added models. */
  source?: ModelSource
  /**
   * Whether the CLI reports vision input for this model. Only a live catalog
   * entry can carry it: the static fallback below declares no capability it
   * could not verify, so an unreachable CLI never advertises image input.
   */
  isVl?: boolean
}

/** Default combined context capacity assumed for Qoder-backed models. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output cap assumed for Qoder-backed models. */
export const DEFAULT_MAX_TOKENS = 32_000

/** Every model the account exposed at capture time, in SDK display order. */
export const QODER_MODELS: readonly QoderCatalogModel[] = [
  { id: 'auto', name: 'Auto', description: 'Qoder 自动路由' },
  { id: 'ultimate', name: 'Ultimate', description: '最强档位路由' },
  { id: 'performance', name: 'Performance' },
  { id: 'efficient', name: 'Efficient' },
  { id: 'lite', name: 'Lite' },
  { id: 'cmodel', name: 'Cantus' },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max' },
  { id: 'qmodel', name: 'Qwen3.7-Plus' },
  { id: 'kmodel_latest', name: 'Kimi-K3' },
  { id: 'kmodel', name: 'Kimi-K2.7-Code' },
  { id: 'gmodel', name: 'GLM-5.3' },
  { id: 'gm51model', name: 'GLM-5.2' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro' },
  { id: 'dfmodel', name: 'DeepSeek-V4-Flash' },
  { id: 'mmodel', name: 'MiniMax-M3' },
]

/**
 * Convenience aliases so a dsh deployment can keep using its own DeepSeek
 * model names against the Qoder route.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'dfmodel',
  'deepseek-v4-pro': 'dmodel',
}

/**
 * Map a dsh-side model id onto a Qoder SDK model value.
 * @param model - model id from {@link import('@deepseek-ai/dsh-llm').GenerateOptions.model}.
 * @returns the Qoder model value: an alias expansion, or the id with any
 *   `qoder-` prefix stripped; the CLI falls back to `auto` for unknown values.
 */
export function resolveQoderModelId(model: string): string {
  const aliased = MODEL_ALIASES[model.toLowerCase()]
  if (aliased !== undefined) return aliased
  const stripped = model.startsWith('qoder-') ? model.slice(6) : model
  return stripped.length > 0 ? stripped : 'auto'
}
